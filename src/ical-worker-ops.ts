/**
 * What src/ical-worker.ts can be asked to do, shared by the worker and by
 * src/ical-worker-pool.ts so the two cannot disagree on a name or a type.
 *
 * Every operation that walks a recurrence rule belongs here, and nowhere
 * else runs one on the connector's own thread (review of #223): the pool is
 * what bounds it. An operation is pure and synchronous, takes and returns
 * only what structured clone carries (strings, numbers, plain objects — no
 * ICAL.Time), and never throws for anything in its input.
 *
 * To add one — PR 4's occurrence lookup by `recurrence_id`, say — add it to
 * {@link WORKER_OPS} and call it with `ExpansionPool.run`.
 */

import { expandObject } from "./ical-expand.js";

export const WORKER_OPS = {
  /** src/ical-expand.ts's {@link expandObject}: one stored object's instances in a window. */
  expand: expandObject,
} as const;

export type WorkerOps = typeof WORKER_OPS;
export type WorkerOpName = keyof WorkerOps;

export interface WorkerRequest<K extends WorkerOpName = WorkerOpName> {
  id: number;
  op: K;
  args: Parameters<WorkerOps[K]>;
}

export type WorkerResponse =
  | { id: number; result: unknown; error?: undefined }
  | { id: number; error: string; result?: undefined };
