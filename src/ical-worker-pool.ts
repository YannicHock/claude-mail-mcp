/**
 * Recurrence expansion off the connector's own thread, under a deadline
 * (review of #223, finding 1).
 *
 * Why: ical.js's `RecurIterator.next` gives up on a rule that matches nothing
 * only for MONTHLY and YEARLY. For DAILY, WEEKLY, HOURLY, MINUTELY and
 * SECONDLY it keeps stepping inside a single `next()` call — `FREQ=DAILY;
 * BYMONTH=2;BYMONTHDAY=30` never returns, `FREQ=DAILY;BYWEEKNO=1;BYMONTH=6`
 * returns an error after about two minutes — so `MAX_STEPS_PER_OBJECT`
 * (src/ical-expand.ts), which is counted between calls, never fires. Before
 * v0.7.4 the CalDAV server expanded; once the connector did, on its one
 * thread, one such object in any calendar froze every tool call of every
 * account and the health check with them. An invitation the server files on
 * its own is enough to plant one.
 *
 * So every expansion runs in a worker thread (src/ical-worker.ts), and each
 * object has {@link EXPANSION_DEADLINE_MS} of the worker's time. When it runs
 * out, the worker is terminated — the one thing that can stop a synchronous
 * loop — the object comes back as a `skipped` entry saying so, and a fresh
 * worker takes the rest of the queue. One pathological object costs itself
 * and a deadline, never the calendar and never the process.
 *
 * The pool is shared by every account, so the review of #225 added two
 * things that keep one account's bad calendar from being everyone's problem:
 *
 *   - **Turns, not one line.** Each request — one `expand()` call, one
 *     `run()` — is a group, and a free worker takes the next object from the
 *     group with the fewest objects in a worker, the longest-waiting first
 *     among equals. A `list_events` on account B no longer waits behind every
 *     object of account A's (six hanging objects held a one-object request
 *     back 9 s); it waits for at most the object a worker already has.
 *   - **A timeout is remembered.** An object that ran out its deadline is
 *     known by its URL and ETag (or its text, with no ETag) for
 *     {@link HANGING_REMEMBERED_MS}, and skipped at once with the same reason
 *     rather than costing every later call another deadline. An edit gives
 *     it a new ETag, and so a fresh try.
 *
 * Cost: the workers are long-lived, {@link EXPANSION_WORKERS} of them,
 * started on first use; an object is one message each way. The deadline
 * starts when a worker takes the object, not when it is queued, and not while
 * a worker is still loading, so a slow start or a long queue never skips an
 * object that would have finished. An idle worker holds no reference that
 * keeps the process alive (`unref`), so it never delays a shutdown.
 *
 * A worker that cannot even be created — `new Worker` throws synchronously
 * on EMFILE or ERR_WORKER_INIT_FAILED, and it is created from timer and
 * message handlers — fails the objects waiting for it with that reason, and
 * the next request tries again; it never becomes an uncaught exception in
 * the connector (review of #225).
 *
 * `impossibleRule` (src/ical-expand.ts) is the fast path for the common
 * hostile shape; this is the guarantee.
 */

import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";

import type { ExpandResult, ExpandWindow, StoredObject } from "./ical-expand.js";
import {
  OP_ACTIONS,
  type WorkerOpName,
  type WorkerOps,
  type WorkerRequest,
  type WorkerResponse,
} from "./ical-worker-ops.js";

/**
 * How long one object may take in a worker. Honest expansion is bounded by
 * `MAX_STEPS_PER_OBJECT`: at most about a second of work, a minutely
 * rule walked from years ago, with zones through `Intl` or a VTIMEZONE alike.
 * Three seconds leaves room for a slower host, and is what one object that
 * never ends costs a `list_events` — once, then it is remembered.
 */
export const EXPANSION_DEADLINE_MS = 3_000;

/** Workers kept, so one object at its deadline does not hold up the rest. */
export const EXPANSION_WORKERS = 2;

/**
 * How long an object that timed out is skipped without a new try. Long
 * enough that a calendar with one is not slow on every call; short enough
 * that one which only timed out because the host was starved gets another
 * chance the same day.
 */
export const HANGING_REMEMBERED_MS = 60 * 60_000;

/** Objects remembered as timed out, at most; the oldest is forgotten first. */
const HANGING_REMEMBERED_MAX = 1000;

/** Heap per worker: an object that allocates without end is stopped by this, not by the host. */
const WORKER_HEAP_MB = 256;

/**
 * The worker's entry point: its `.ts` source when the connector runs through
 * tsx (tests, `npm run dev`), which a worker inherits through `execArgv`,
 * and the compiled `.js` beside this file otherwise.
 */
const WORKER_URL = new URL(import.meta.url.endsWith(".ts") ? "./ical-worker.ts" : "./ical-worker.js", import.meta.url);

/** One expansion worker as the pool starts it; {@link ExpansionPoolOptions.startWorker} replaces it in tests. */
export function startExpansionWorker(): Worker {
  return new Worker(WORKER_URL, { resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MB } });
}

/**
 * An operation that was still running when its deadline passed. The text
 * names what the operation was doing ({@link OP_ACTIONS}) and nothing about
 * what the caller does with it next, so every operation can hand it on as
 * it is (see {@link reasonOf}).
 */
export class ExpansionTimeout extends Error {
  constructor(deadlineMs: number, action: string) {
    super(
      `It did not finish ${action} within ${deadlineMs / 1000} s, so the connector stopped it: its recurrence rule may never produce a next occurrence.`
    );
    this.name = "ExpansionTimeout";
  }
}

/** What every call to a closed pool, and everything queued when it closed, is refused with. */
export class PoolClosed extends Error {
  constructor() {
    super("The expansion pool is closed.");
    this.name = "PoolClosed";
  }
}

/**
 * The one sentence, for `skipped` or a refusal, that a failed operation
 * comes to. A timeout and a closed pool say so in their own words; anything
 * else is the worker's failure — it threw, ran out of heap, or could not be
 * started — with its message. `expand()` uses it, and so does every caller
 * of {@link ExpansionPool.run}, which rejects with the error as it is.
 */
export function reasonOf(err: unknown): string {
  if (err instanceof ExpansionTimeout || err instanceof PoolClosed) return err.message;
  return `The connector's expansion worker failed on it: ${err instanceof Error ? err.message : String(err)}`;
}

/** One request's objects: they take turns with every other request's. */
interface Group {
  tasks: Task[];
  /** How many of this group's tasks a worker has right now. */
  running: number;
}

interface Task {
  id: number;
  op: WorkerOpName;
  args: unknown[];
  /** The object it runs on, for remembering a timeout; null for one that is not about a stored object. */
  key: string | null;
  group: Group;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

interface Slot {
  worker: Worker;
  ready: boolean;
  task: Task | null;
  timer: NodeJS.Timeout | null;
}

export interface ExpansionPoolOptions {
  /** Workers kept; {@link EXPANSION_WORKERS} by default. */
  size?: number;
  /** Per object; {@link EXPANSION_DEADLINE_MS} by default. Tests shorten it. */
  deadlineMs?: number;
  /** Creates a worker; {@link startExpansionWorker} by default. Tests make it throw. */
  startWorker?: () => Worker;
}

/**
 * What a stored object is known by for {@link HANGING_REMEMBERED_MS}: its URL
 * and its ETag, which the server changes on every edit; its text instead
 * when the server sent no ETag.
 */
function objectKey(object: StoredObject): string {
  const version = object.etag ?? `sha256:${createHash("sha256").update(object.data).digest("base64")}`;
  return `${object.url}\n${version}`;
}

export class ExpansionPool {
  private readonly size: number;
  private readonly deadlineMs: number;
  private readonly startWorker: () => Worker;
  private readonly slots: Slot[] = [];
  /** Groups with tasks still waiting, in turn order: whoever took last goes to the back. */
  private readonly groups: Group[] = [];
  /** Objects that ran out their deadline, by {@link objectKey}, with when and why. */
  private readonly hanging = new Map<string, { at: number; error: ExpansionTimeout }>();
  private nextId = 1;
  private closed = false;

  constructor(options: ExpansionPoolOptions = {}) {
    this.size = Math.max(1, options.size ?? EXPANSION_WORKERS);
    this.deadlineMs = options.deadlineMs ?? EXPANSION_DEADLINE_MS;
    this.startWorker = options.startWorker ?? startExpansionWorker;
  }

  /**
   * Run one {@link WorkerOps} operation in a worker, as a request of its own.
   * Rejects with {@link ExpansionTimeout} when it outlives the deadline, with
   * {@link PoolClosed} after {@link close}, and with a plain Error when the
   * worker failed (it threw, ran out of heap, or could not start); turn any
   * of them into words with {@link reasonOf}. A timeout here is not
   * remembered, since nothing says which object it was: use {@link runOn}
   * for an operation on a stored object.
   */
  run<K extends WorkerOpName>(op: K, ...args: Parameters<WorkerOps[K]>): Promise<ReturnType<WorkerOps[K]>> {
    return this.submit(this.group(), null, op, args) as Promise<ReturnType<WorkerOps[K]>>;
  }

  /**
   * {@link run} for an operation on one stored object: an object that timed
   * out before, in any operation, is refused at once with the same
   * {@link ExpansionTimeout}, and one that times out now is remembered.
   * What PR 4's occurrence lookup by `recurrence_id` calls.
   */
  runOn<K extends WorkerOpName>(
    object: StoredObject,
    op: K,
    ...args: Parameters<WorkerOps[K]>
  ): Promise<ReturnType<WorkerOps[K]>> {
    return this.submit(this.group(), objectKey(object), op, args) as Promise<ReturnType<WorkerOps[K]>>;
  }

  /**
   * {@link runOn} for each of `objects`, in order, as **one** request taking
   * turns with every other — what `expand` is for `expandObject`, for any
   * operation. `argsOf` gives each object's arguments. Never rejects: each
   * object's outcome is settled on its own, an object that timed out (now or
   * within {@link HANGING_REMEMBERED_MS}) or whose worker failed coming back
   * `rejected` — turn its reason into words with {@link reasonOf}.
   *
   * Why not `runOn` per object: each call is a request of its own, so a
   * `find_free_slot` over a calendar of fifty objects (#213) would be fifty
   * requests, and another account's one-object `list_events` would wait
   * behind every one of them — the stall the turns exist to prevent.
   */
  runOnEach<K extends WorkerOpName>(
    objects: readonly StoredObject[],
    op: K,
    argsOf: (object: StoredObject) => Parameters<WorkerOps[K]>
  ): Promise<PromiseSettledResult<ReturnType<WorkerOps[K]>>[]> {
    const group = this.group();
    return Promise.allSettled(
      objects.map((o) => this.submit(group, objectKey(o), op, argsOf(o)) as Promise<ReturnType<WorkerOps[K]>>)
    );
  }

  /**
   * `expandObject` for each of `objects`, in order, each under its own
   * deadline, as one request taking turns with every other. Never rejects:
   * an object that timed out — now or within {@link HANGING_REMEMBERED_MS} —
   * or whose worker failed comes back with no instances and
   * {@link reasonOf} in `skipped`.
   */
  expand(objects: StoredObject[], window: ExpandWindow): Promise<ExpandResult[]> {
    const group = this.group();
    return Promise.all(
      objects.map((o) =>
        (this.submit(group, objectKey(o), "expand", [o.data, window, { url: o.url, etag: o.etag }]) as Promise<ExpandResult>).catch(
          (err: unknown): ExpandResult => ({ instances: [], skipped: reasonOf(err) })
        )
      )
    );
  }

  /**
   * Stop every worker and refuse what is still queued with {@link PoolClosed}.
   * Called by the connector's shutdown (src/index.ts) and by tests; a closed
   * pool refuses every later call.
   */
  async close(): Promise<void> {
    this.closed = true;
    for (const group of this.groups.splice(0)) {
      for (const task of group.tasks.splice(0)) task.reject(new PoolClosed());
    }
    const slots = this.slots.splice(0);
    for (const slot of slots) {
      if (slot.timer !== null) clearTimeout(slot.timer);
      slot.task?.reject(new PoolClosed());
    }
    await Promise.all(slots.map((slot) => slot.worker.terminate()));
  }

  private group(): Group {
    return { tasks: [], running: 0 };
  }

  private submit(group: Group, key: string | null, op: WorkerOpName, args: unknown[]): Promise<unknown> {
    if (this.closed) return Promise.reject(new PoolClosed());
    const known = this.knownHanging(key);
    if (known !== null) return Promise.reject(known);
    return new Promise((resolve, reject) => {
      const task: Task = { id: this.nextId++, op, args, key, group, resolve, reject };
      if (group.tasks.length === 0) this.groups.push(group);
      group.tasks.push(task);
      this.pump();
    });
  }

  /** The timeout `key` ran into within {@link HANGING_REMEMBERED_MS}, or null. */
  private knownHanging(key: string | null): ExpansionTimeout | null {
    if (key === null) return null;
    const entry = this.hanging.get(key);
    if (entry === undefined) return null;
    if (Date.now() - entry.at > HANGING_REMEMBERED_MS) {
      this.hanging.delete(key);
      return null;
    }
    return entry.error;
  }

  private rememberHanging(key: string, error: ExpansionTimeout): void {
    this.hanging.delete(key);
    if (this.hanging.size >= HANGING_REMEMBERED_MAX) {
      const oldest = this.hanging.keys().next().value;
      if (oldest !== undefined) this.hanging.delete(oldest);
    }
    this.hanging.set(key, { at: Date.now(), error });
  }

  /**
   * The next task to run: from the group with the fewest tasks in a worker,
   * the one earliest in turn among equals, which then goes to the back of
   * the turn order. A task whose object timed out meanwhile — queued in two
   * requests at once, say — is refused here instead of run again.
   */
  private take(): Task | null {
    for (;;) {
      let best = -1;
      for (let i = 0; i < this.groups.length; i++) {
        if (best === -1 || this.groups[i].running < this.groups[best].running) best = i;
      }
      if (best === -1) return null;
      const [group] = this.groups.splice(best, 1);
      const task = group.tasks.shift() as Task;
      if (group.tasks.length > 0) this.groups.push(group);
      const known = this.knownHanging(task.key);
      if (known === null) return task;
      task.reject(known);
    }
  }

  private waiting(): number {
    let n = 0;
    for (const group of this.groups) n += group.tasks.length;
    return n;
  }

  /** Hand queued tasks to idle workers, starting workers as the queue needs them. */
  private pump(): void {
    for (;;) {
      const idle = this.slots.find((s) => s.ready && s.task === null);
      if (idle === undefined) break;
      const task = this.take();
      if (task === null) break;
      this.dispatch(idle, task);
    }
    const starting = this.slots.filter((s) => !s.ready).length;
    for (let n = starting; n < this.waiting() && this.slots.length < this.size; n++) {
      if (!this.spawn()) break;
    }
    // A worker keeps the process alive only while there is work for it: an
    // idle one must never hold up a shutdown, and a busy or starting one must
    // not let a script exit with its answer still pending.
    for (const slot of this.slots) {
      if (slot.task !== null || !slot.ready) slot.worker.ref();
      else slot.worker.unref();
    }
  }

  private dispatch(slot: Slot, task: Task): void {
    slot.task = task;
    task.group.running++;
    slot.timer = setTimeout(() => {
      this.remove(slot);
      this.release(slot);
      void slot.worker.terminate();
      const timeout = new ExpansionTimeout(this.deadlineMs, OP_ACTIONS[task.op]);
      if (task.key !== null) this.rememberHanging(task.key, timeout);
      task.reject(timeout);
      this.pump();
    }, this.deadlineMs);
    const request: WorkerRequest = { id: task.id, op: task.op, args: task.args as WorkerRequest["args"] };
    slot.worker.postMessage(request);
  }

  /** Take `slot`'s task and timer off it; its group has one fewer in a worker. */
  private release(slot: Slot): Task | null {
    const task = slot.task;
    if (slot.timer !== null) clearTimeout(slot.timer);
    slot.task = null;
    slot.timer = null;
    if (task !== null) task.group.running--;
    return task;
  }

  /**
   * Start one worker; false when it could not be created. `new Worker` can
   * throw synchronously (EMFILE, ERR_WORKER_INIT_FAILED), and this runs
   * inside timer and message handlers, where a throw would be an uncaught
   * exception in the connector. With no worker left to take the queue, the
   * tasks waiting fail with the reason; with one, they wait for it.
   */
  private spawn(): boolean {
    let worker: Worker;
    try {
      worker = this.startWorker();
    } catch (err) {
      if (this.slots.length === 0) {
        const reason = new Error(`the worker could not start: ${err instanceof Error ? err.message : String(err)}`);
        for (const group of this.groups.splice(0)) {
          for (const task of group.tasks.splice(0)) task.reject(reason);
        }
      }
      return false;
    }
    const slot: Slot = { worker, ready: false, task: null, timer: null };
    this.slots.push(slot);
    worker.on("message", (message: WorkerResponse | { ready: true }) => {
      if ("ready" in message) {
        slot.ready = true;
        this.pump();
        return;
      }
      if (slot.task === null || message.id !== slot.task.id) return;
      const task = this.release(slot) as Task;
      if (message.error !== undefined) task.reject(new Error(message.error));
      else task.resolve(message.result);
      this.pump();
    });
    worker.on("error", (err) => this.lose(slot, err));
    worker.on("exit", (code) => this.lose(slot, new Error(`the worker exited with code ${code}`)));
    return true;
  }

  /**
   * A worker gone other than by its deadline: it threw, ran out of heap, or
   * never started. Its task fails.
   *
   * A worker that never became ready fails the whole queue, on purpose: it
   * died loading its entry point — a missing or broken build, a heap limit
   * the host cannot give — and every replacement would die the same way, so
   * starting one per waiting object would only loop. The requests waiting
   * get the reason instead, and the next request tries a fresh worker.
   */
  private lose(slot: Slot, err: Error): void {
    if (!this.remove(slot)) return;
    this.release(slot)?.reject(err);
    if (!slot.ready) {
      for (const group of this.groups.splice(0)) {
        for (const task of group.tasks.splice(0)) task.reject(err);
      }
      return;
    }
    this.pump();
  }

  /** Take `slot` out of the pool; false when it was already out. */
  private remove(slot: Slot): boolean {
    const index = this.slots.indexOf(slot);
    if (index === -1) return false;
    this.slots.splice(index, 1);
    return true;
  }
}

/** The pool `CalDavClient` expands through, shared by every account. */
export const expansionPool = new ExpansionPool();
