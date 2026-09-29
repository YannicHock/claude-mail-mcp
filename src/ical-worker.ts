/**
 * The worker thread src/ical-worker-pool.ts runs expansion in (review of
 * #223, finding 1). Nothing but a message loop: every operation it offers is
 * in {@link WORKER_OPS}, pure and synchronous, and is also callable
 * in-process for unit tests.
 *
 * It exists because ical.js can walk a recurrence rule for ever inside one
 * call (`RecurIterator.next` on a DAILY rule whose BY-parts never match), and
 * no check between calls can interrupt that. A worker can be terminated from
 * outside; the connector's own thread cannot.
 *
 * Protocol: the worker posts `{ ready: true }` once loaded, so the pool can
 * start a deadline on work rather than on start-up; then answers each
 * `{ id, op, args }` with `{ id, result }` or `{ id, error }`.
 */

import { parentPort } from "node:worker_threads";

import { WORKER_OPS, type WorkerRequest, type WorkerResponse } from "./ical-worker-ops.js";

const port = parentPort;
if (port === null) throw new Error("src/ical-worker.ts is a worker thread's entry point, not a module to import");

port.on("message", (request: WorkerRequest) => {
  let response: WorkerResponse;
  try {
    const op = WORKER_OPS[request.op] as (...args: unknown[]) => unknown;
    response = { id: request.id, result: op(...request.args) };
  } catch (err) {
    response = { id: request.id, error: err instanceof Error ? err.message : String(err) };
  }
  port.postMessage(response);
});

port.postMessage({ ready: true });
