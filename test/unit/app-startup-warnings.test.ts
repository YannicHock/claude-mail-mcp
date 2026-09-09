/**
 * Startup warnings emitted by `createApp` (src/app.ts).
 *
 * A mailbox that already exists under a reserved id ("new", "test") keeps
 * loading — refusing the file would take every other mailbox down with it, see
 * RESERVED_IDS in src/accounts.ts — but it cannot be edited in place. The only
 * thing an operator ever saw of that was a Save button that silently did
 * nothing, so the condition is announced at startup, where the connector first
 * has the account list in hand.
 *
 * These run against `createApp` rather than `src/index.ts`: index.ts's `main()`
 * binds a port and installs signal handlers on import, while createApp is the
 * one factory both the process entry point and the test harness go through.
 * Offline like every other unit test — building the app registers tools and
 * routes, and connects to nothing.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { createApp, type LogLevel } from "../../src/app.js";
import { ClientPool } from "../../src/client-pool.js";
import type { Account } from "../../src/accounts.js";
import { makeAccount, withAccountsStore } from "../helpers/fixtures.js";

interface LogLine {
  level: LogLevel;
  message: string;
  extra?: Record<string, unknown>;
}

/** Build the real app over `accounts`, returning everything it logged doing so. */
async function startupLog(accounts: Account[]): Promise<LogLine[]> {
  const lines: LogLine[] = [];
  await withAccountsStore(accounts, (store, dir) => {
    const pool = new ClientPool(store);
    createApp({
      store,
      pool,
      authToken: "unit-test-token",
      accountsFile: path.join(dir, "accounts.json"),
      publicUrl: "http://localhost.invalid",
      log: (level, message, extra) => lines.push({ level, message, extra }),
    });
  });
  return lines;
}

test("a mailbox on a reserved id is warned about at startup, by id and by label", async () => {
  const lines = await startupLog([
    makeAccount({ id: "work", label: "Work", default: true }),
    makeAccount({ id: "test", label: "Old test mailbox" }),
  ]);
  const warnings = lines.filter((l) => l.level === "warn");
  assert.equal(warnings.length, 1, "exactly the one affected mailbox is warned about");
  assert.equal(warnings[0]?.extra?.account, "test");
  assert.equal(warnings[0]?.extra?.label, "Old test mailbox");
  assert.match(String(warnings[0]?.extra?.notice), /recreate it under a different id/);
});

test("both reserved ids are reported, one warning each", async () => {
  const lines = await startupLog([
    makeAccount({ id: "new", label: "New" }),
    makeAccount({ id: "test", label: "Test" }),
  ]);
  assert.deepEqual(
    lines.filter((l) => l.level === "warn").map((l) => l.extra?.account),
    ["new", "test"]
  );
});

test("an ordinary account list produces no startup warning at all", async () => {
  const lines = await startupLog([makeAccount({ id: "work", label: "Work", default: true })]);
  assert.deepEqual(lines.filter((l) => l.level === "warn"), []);
});
