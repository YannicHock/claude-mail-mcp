/**
 * What src/ical-worker.ts can be asked to do, shared by the worker and by
 * src/ical-worker-pool.ts so the two cannot disagree on a name or a type.
 *
 * Every operation that walks a recurrence rule belongs here, and nowhere
 * else runs one on the connector's own thread (review of #223): the pool is
 * what bounds it. An operation is pure and synchronous, and never throws for
 * anything in its input.
 *
 * **What crosses the boundary** (review of #225). An operation takes the
 * stored object as its text and parses it afresh, in the worker; it returns
 * plain data that structured clone carries — strings such as
 * `reportedTime` produces, numbers, indices into the object, plain objects —
 * and never an ICAL.Time, ICAL.Component or any other ical.js value, which
 * would arrive as a bare object with its prototype gone. Nor does it return
 * a calendar `occurrencesIn` walked: that one was changed in memory (an
 * impossible RRULE dropped, a PERIOD RDATE split) and is for reading only.
 * A write re-parses the original text on the main thread and changes that,
 * addressing what the operation found by the strings and indices it returned.
 *
 * To add one — as PR 4 added the occurrence lookup by `recurrence_id` — add it to
 * {@link WORKER_OPS}, say what it does in {@link OP_ACTIONS}, and call it
 * with `ExpansionPool.runOn` (src/ical-worker-pool.ts), which also remembers
 * an object that timed out — or, for many objects in one call, as
 * `find_free_slot` reads a calendar (#213), with `ExpansionPool.runOnEach`,
 * which makes them one request; turn a rejection into words with `reasonOf`.
 */

import { busyTimes } from "./ical-busy.js";
import { expandObject, findOccurrence } from "./ical-expand.js";

export const WORKER_OPS = {
  /** src/ical-expand.ts's {@link expandObject}: one stored object's instances in a window. */
  expand: expandObject,
  /**
   * src/ical-busy.ts's {@link busyTimes}: one stored object's busy time in a
   * window, as epoch ms, for `find_free_slot` (#213) — transparent, cancelled
   * and self-declined occurrences left out, and what could not be read said.
   * The account's own addresses and the working zone come in as plain strings.
   */
  busyTimes,
  /**
   * src/ical-expand.ts's {@link findOccurrence}: the occurrence a caller's
   * `recurrence_id` names, matched against the expanded series (#206), for
   * `update_event` and `delete_event` on one occurrence and as the anchor of
   * a series' new time (#207).
   */
  findOccurrence,
} as const;

export type WorkerOps = typeof WORKER_OPS;
export type WorkerOpName = keyof WorkerOps;

/**
 * Each operation as the words "It did not finish … within 3 s" takes, for
 * the `ExpansionTimeout` it can end in. Typed over {@link WorkerOpName}, so an
 * operation added without one does not compile.
 */
export const OP_ACTIONS: { readonly [K in WorkerOpName]: string } = {
  expand: "expanding",
  busyTimes: "reading its busy times",
  findOccurrence: "looking for the occurrence",
};

export interface WorkerRequest<K extends WorkerOpName = WorkerOpName> {
  id: number;
  op: K;
  args: Parameters<WorkerOps[K]>;
}

export type WorkerResponse =
  | { id: number; result: unknown; error?: undefined }
  | { id: number; error: string; result?: undefined };
