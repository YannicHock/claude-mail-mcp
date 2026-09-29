/**
 * ToolRefusal, and the status check every CalDAV write now makes
 * (spec 2026-09-28 §4.5).
 *
 * A refusal is an answer: it reaches the caller word for word and leaves no
 * `warn` line, because a model retrying after a conflict is the tool working.
 * Anything else still goes through #146's reporting, prefixed and logged once.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { ClientPool } from "../../src/client-pool.js";
import { reportingFailures, ToolRefusal, TOOL_FAILURE_EVENT } from "../../src/tool-errors.js";

interface Line {
  level: string;
  message: string;
}

/** `reportingFailures` only ever calls `pool.log`; nothing else is needed. */
function recordingPool(): { pool: ClientPool; lines: Line[] } {
  const lines: Line[] = [];
  const pool = { log: (level: string, message: string) => lines.push({ level, message }) } as unknown as ClientPool;
  return { pool, lines };
}

describe("reportingFailures", () => {
  it("passes a ToolRefusal through unchanged and logs nothing", async () => {
    const { pool, lines } = recordingPool();
    const refusal = new ToolRefusal("The event changed after you read it.");
    await assert.rejects(
      reportingFailures(pool, "update_event", "work", () => Promise.reject(refusal)),
      (err: unknown) => err === refusal
    );
    assert.deepEqual(lines, []);
  });

  it("still names the account and logs one warn line for anything else", async () => {
    const { pool, lines } = recordingPool();
    await assert.rejects(
      reportingFailures(pool, "update_event", "work", () =>
        Promise.reject(new Error("CalDAV server answered 403 Forbidden to PUT"))
      ),
      /^Error: Account "work": .*403 Forbidden to PUT/
    );
    assert.deepEqual(lines, [{ level: "warn", message: TOOL_FAILURE_EVENT }]);
  });
});
