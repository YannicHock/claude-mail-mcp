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

import { assertWritten, requireEtag } from "../../src/caldav-client.js";
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

describe("assertWritten", () => {
  it("accepts every 2xx", () => {
    for (const status of [200, 201, 204]) {
      assert.doesNotThrow(() => assertWritten(new Response(null, { status }), "PUT"));
    }
  });

  it("turns anything else into an error naming the status and the method", () => {
    assert.throws(
      () => assertWritten(new Response(null, { status: 403, statusText: "Forbidden" }), "PUT"),
      /CalDAV server answered 403 Forbidden to PUT/
    );
    assert.throws(
      () => assertWritten(new Response(null, { status: 507, statusText: "Insufficient Storage" }), "DELETE"),
      /507 Insufficient Storage to DELETE/
    );
  });
});

describe("requireEtag (spec §4.1)", () => {
  const target = { calendarUrl: "https://dav.example/cal/", uid: "e@x" };

  it("sends the caller's etag when there is one", () => {
    assert.equal(requireEtag({ ...target, etag: '"a"' }, { etag: '"b"' }), '"a"');
  });

  it("writes without If-Match when the server keeps no etag", () => {
    assert.equal(requireEtag(target, { etag: null }), undefined);
  });

  it("refuses to write blind over an object that has an etag", () => {
    assert.throws(() => requireEtag(target, { etag: '"b"' }), (err: unknown) => err instanceof ToolRefusal);
  });
});
