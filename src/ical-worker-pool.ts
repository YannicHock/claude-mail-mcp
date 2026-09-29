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
 * Cost: the workers are long-lived, {@link EXPANSION_WORKERS} of them,
 * started on first use; an object is one message each way. The deadline
 * starts when a worker takes the object, not when it is queued, and not while
 * a worker is still loading, so a slow start or a long queue never skips an
 * object that would have finished. An idle worker holds no reference that
 * keeps the process alive (`unref`), so it never delays a shutdown.
 *
 * `impossibleRule` (src/ical-expand.ts) is the fast path for the common
 * hostile shape; this is the guarantee.
 */

import { Worker } from "node:worker_threads";

import type { ExpandResult, ExpandWindow } from "./ical-expand.js";
import type { WorkerOpName, WorkerOps, WorkerRequest, WorkerResponse } from "./ical-worker-ops.js";

/**
 * How long one object may take in a worker. Honest expansion is bounded by
 * `MAX_STEPS_PER_OBJECT`: at most about a second of work, a minutely
 * rule walked from years ago, with zones through `Intl` or a VTIMEZONE alike.
 * Three seconds leaves room for a slower host, and is what one object that
 * never ends costs a `list_events`.
 */
export const EXPANSION_DEADLINE_MS = 3_000;

/** Workers kept, so one object at its deadline does not hold up the rest. */
export const EXPANSION_WORKERS = 2;

/** Heap per worker: an object that allocates without end is stopped by this, not by the host. */
const WORKER_HEAP_MB = 256;

/**
 * The worker's entry point: its `.ts` source when the connector runs through
 * tsx (tests, `npm run dev`), which a worker inherits through `execArgv`,
 * and the compiled `.js` beside this file otherwise.
 */
const WORKER_URL = new URL(import.meta.url.endsWith(".ts") ? "./ical-worker.ts" : "./ical-worker.js", import.meta.url);

/** An object that was still being expanded when its deadline passed. */
export class ExpansionTimeout extends Error {
  readonly deadlineMs: number;

  constructor(deadlineMs: number) {
    super(
      `It did not finish expanding within ${deadlineMs / 1000} s, so it was stopped and left out: its recurrence rule may never produce a next occurrence.`
    );
    this.name = "ExpansionTimeout";
    this.deadlineMs = deadlineMs;
  }
}

/** A stored object as `CalDavClient` fetched it. */
export interface StoredObject {
  url: string;
  etag: string | null;
  data: string;
}

interface Task {
  id: number;
  op: WorkerOpName;
  args: unknown[];
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
}

export class ExpansionPool {
  private readonly size: number;
  private readonly deadlineMs: number;
  private readonly slots: Slot[] = [];
  private readonly queue: Task[] = [];
  private nextId = 1;
  private closed = false;

  constructor(options: ExpansionPoolOptions = {}) {
    this.size = Math.max(1, options.size ?? EXPANSION_WORKERS);
    this.deadlineMs = options.deadlineMs ?? EXPANSION_DEADLINE_MS;
  }

  /**
   * Run one {@link WorkerOps} operation in a worker. Rejects with
   * {@link ExpansionTimeout} when it outlives the deadline, and with a plain
   * Error when the worker failed (it threw, ran out of heap, or could not
   * start).
   */
  run<K extends WorkerOpName>(op: K, ...args: Parameters<WorkerOps[K]>): Promise<ReturnType<WorkerOps[K]>> {
    if (this.closed) return Promise.reject(new Error("The expansion pool is closed."));
    return new Promise((resolve, reject) => {
      this.queue.push({ id: this.nextId++, op, args, resolve: resolve as (value: unknown) => void, reject });
      this.pump();
    });
  }

  /**
   * `expandObject` for each of `objects`, in order, each under its own
   * deadline. Never rejects: an object that timed out, or whose worker
   * failed, comes back with no instances and the reason in `skipped`.
   */
  expand(objects: StoredObject[], window: ExpandWindow): Promise<ExpandResult[]> {
    return Promise.all(
      objects.map((o) =>
        this.run("expand", o.data, window, { url: o.url, etag: o.etag }).catch(
          (err: Error): ExpandResult => ({
            instances: [],
            skipped:
              err instanceof ExpansionTimeout ? err.message : `The connector's expansion worker failed on it: ${err.message}`,
          })
        )
      )
    );
  }

  /** Stop every worker and refuse what is still queued. For tests and shutdown. */
  async close(): Promise<void> {
    this.closed = true;
    for (const task of this.queue.splice(0)) task.reject(new Error("The expansion pool is closed."));
    const slots = this.slots.splice(0);
    for (const slot of slots) {
      if (slot.timer !== null) clearTimeout(slot.timer);
      slot.task?.reject(new Error("The expansion pool is closed."));
    }
    await Promise.all(slots.map((slot) => slot.worker.terminate()));
  }

  /** Hand queued tasks to idle workers, starting workers as the queue needs them. */
  private pump(): void {
    while (this.queue.length > 0) {
      const idle = this.slots.find((s) => s.ready && s.task === null);
      if (idle === undefined) break;
      this.dispatch(idle, this.queue.shift() as Task);
    }
    const starting = this.slots.filter((s) => !s.ready).length;
    for (let n = starting; n < this.queue.length && this.slots.length < this.size; n++) this.spawn();
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
    slot.timer = setTimeout(() => {
      this.remove(slot);
      slot.task = null;
      slot.timer = null;
      void slot.worker.terminate();
      task.reject(new ExpansionTimeout(this.deadlineMs));
      this.pump();
    }, this.deadlineMs);
    const request: WorkerRequest = { id: task.id, op: task.op, args: task.args as WorkerRequest["args"] };
    slot.worker.postMessage(request);
  }

  private spawn(): void {
    const worker = new Worker(WORKER_URL, { resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MB } });
    const slot: Slot = { worker, ready: false, task: null, timer: null };
    this.slots.push(slot);
    worker.on("message", (message: WorkerResponse | { ready: true }) => {
      if ("ready" in message) {
        slot.ready = true;
        this.pump();
        return;
      }
      const task = slot.task;
      if (task === null || message.id !== task.id) return;
      if (slot.timer !== null) clearTimeout(slot.timer);
      slot.task = null;
      slot.timer = null;
      if (message.error !== undefined) task.reject(new Error(message.error));
      else task.resolve(message.result);
      this.pump();
    });
    worker.on("error", (err) => this.lose(slot, err));
    worker.on("exit", (code) => this.lose(slot, new Error(`the worker exited with code ${code}`)));
  }

  /**
   * A worker gone other than by its deadline: it threw, ran out of heap, or
   * never started. Its task fails; a worker that never became ready fails the
   * whole queue, since the next one would fail the same way.
   */
  private lose(slot: Slot, err: Error): void {
    if (!this.remove(slot)) return;
    if (slot.timer !== null) clearTimeout(slot.timer);
    slot.task?.reject(err);
    slot.task = null;
    if (!slot.ready) {
      for (const task of this.queue.splice(0)) task.reject(err);
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
