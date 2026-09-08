/**
 * See config.defaults.test.ts for why each env constellation lives in its
 * own file.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.AUTH_TOKEN = "override-auth-token";
process.env.HOST = "0.0.0.0";
process.env.PORT = "8080";
process.env.LOG_LEVEL = "debug";
process.env.ACCOUNTS_FILE = "/custom/path/accounts.json";
process.env.PUBLIC_URL = "https://mail.example.invalid";

const { config } = await import("../../src/config.js");

test("env overrides take effect", () => {
  assert.equal(config.host, "0.0.0.0");
  assert.equal(config.port, 8080);
  assert.equal(config.logLevel, "debug");
  assert.equal(config.accountsFile, "/custom/path/accounts.json");
  assert.equal(config.publicUrl, "https://mail.example.invalid");
  assert.equal(config.authToken, "override-auth-token");
});
