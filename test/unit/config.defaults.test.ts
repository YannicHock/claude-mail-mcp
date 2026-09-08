/**
 * config.ts evaluates `export const config` at module load time, so this
 * scenario (no env overrides) gets its own test file — `node --test` runs
 * each file in its own process, giving us a clean env per constellation
 * instead of having to mutate process.env and cache-bust the import.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

delete process.env.HOST;
delete process.env.PORT;
delete process.env.LOG_LEVEL;
delete process.env.ACCOUNTS_FILE;
delete process.env.PUBLIC_URL;
process.env.AUTH_TOKEN = "test-auth-token";

const { config } = await import("../../src/config.js");

test("defaults apply when no optional env vars are set", () => {
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 3220);
  assert.equal(config.logLevel, "info");
  assert.equal(config.accountsFile, "/root/.config/mail-mcp/accounts.json");
  assert.equal(config.publicUrl, "http://localhost:3220");
  assert.equal(config.authToken, "test-auth-token");
});
