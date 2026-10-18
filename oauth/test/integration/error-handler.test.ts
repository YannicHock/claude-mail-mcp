/**
 * The app's last-resort error handler (#219).
 *
 * It answered everything it caught `500` and logged it at `error`, so a form
 * over the 64 KB parser limit reached the log as this service's failure. A body
 * the parser refuses is the client's mistake now and answers its own 4xx at
 * `warn`, by the rule the connector uses (shared/http-error.ts); a handler that
 * throws is still a `500 server_error` at `error`.
 */

import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";

import type { LogLevel } from "../../src/logger.js";
import { registerClaudeClient, startHarness, type Harness } from "../helpers/harness.js";

interface LogLine {
  level: LogLevel;
  message: string;
  extra?: Record<string, unknown>;
}

const lines: LogLine[] = [];
let harness: Harness;

before(async () => {
  harness = await startHarness({
    log: (level, message, extra) => {
      lines.push({ level, message, extra });
    },
  });
});

after(async () => {
  await harness.close();
});

/** The lines logged while `fn` ran. */
async function logged(fn: () => Promise<void>): Promise<LogLine[]> {
  const from = lines.length;
  await fn();
  return lines.slice(from);
}

describe("the last-resort error handler", () => {
  it("answers a form over the parser's limit with 413, logged at warn", async () => {
    const seen = await logged(async () => {
      const res = await fetch(`${harness.baseUrl}/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: `grant_type=authorization_code&padding=${"a".repeat(80 * 1024)}`,
      });
      assert.equal(res.status, 413);
      assert.equal(((await res.json()) as { error: string }).error, "invalid_request");
    });
    assert.deepEqual(
      seen.map((line) => [line.level, line.message]),
      [["warn", "rejected malformed request body"]]
    );
    assert.equal(seen[0].extra?.status, 413);
  });

  it("answers a handler's own failure with 500 server_error, logged at error", async () => {
    const original = harness.store.putClient.bind(harness.store);
    harness.store.putClient = () => {
      throw Object.assign(new Error("ENOSPC: no space left on device, write"), {
        code: "ENOSPC",
      });
    };
    try {
      const seen = await logged(async () => {
        const { status, body } = await registerClaudeClient(harness.baseUrl);
        assert.equal(status, 500);
        assert.deepEqual(body, { error: "server_error" });
      });
      assert.deepEqual(
        seen.map((line) => [line.level, line.message]),
        [["error", "unhandled request error"]]
      );
    } finally {
      harness.store.putClient = original;
    }
  });
});
