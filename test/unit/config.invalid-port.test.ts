/**
 * See config.defaults.test.ts for why each env constellation lives in its
 * own file. Covers the `int()` parse-failure branch for PORT.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.AUTH_TOKEN = "test-auth-token";
process.env.PORT = "not-a-number";

test("non-numeric PORT throws at import time", async () => {
  await assert.rejects(() => import("../../src/config.js"), /PORT/);
});
