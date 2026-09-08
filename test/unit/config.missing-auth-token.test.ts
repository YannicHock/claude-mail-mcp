/**
 * See config.defaults.test.ts for why each env constellation lives in its
 * own file. AUTH_TOKEN is the only required variable — this documents the
 * import-time failure mode when it's absent.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

delete process.env.AUTH_TOKEN;

test("missing AUTH_TOKEN throws at import time", async () => {
  await assert.rejects(() => import("../../src/config.js"), /AUTH_TOKEN/);
});
