/**
 * #247: an accounts.json that already holds an `http://` CalDAV URL to a host
 * that is not local.
 *
 * Saving one is refused (test/integration/settings-mailboxes.test.ts), but a
 * file written before v0.8 may hold one, and an upgrade must not refuse to
 * boot over it (#155). So the file loads, the store marks the account, the
 * start-up logs one `warn` for it, and every calendar tool on it is refused
 * before any request is made — the credentials never leave the process. The
 * mail half of such an account is GreenMail's to show
 * (test/integration/caldav-http-refusal.test.ts).
 *
 * `http://cloud.example.com/` is never resolved — a dotted public name is not
 * local by its form alone — so nothing here reaches a DNS server, and
 * `globalThis.fetch`, which tsdav and the client's own requests both go
 * through, is replaced by one that counts and fails.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createApp, type LogLevel } from "../../src/app.js";
import { ClientPool } from "../../src/client-pool.js";
import { registerCalendarTools } from "../../src/tools-calendar.js";
import { ToolRefusal } from "../../src/tool-refusal.js";
import type { Account } from "../../src/accounts.js";
import { makeAccount, withAccountsStore } from "../helpers/fixtures.js";

const PASSWORD = "dav-secret-never-sent";

function withCalDav(id: string, url: string, extra: Partial<Account> = {}): Account {
  return makeAccount({ id, label: `Label of ${id}`, caldav: { url, user: "dav-user", pass: PASSWORD }, ...extra });
}

const PUBLIC_HTTP = "http://cloud.example.com/dav/";

type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

/** Every calendar tool, with arguments enough to get past its own checks. */
const CALENDAR_CALLS: Array<[string, Record<string, unknown>]> = [
  ["list_calendars", {}],
  ["list_events", { calendar_url: `${PUBLIC_HTTP}cal/`, start: "2026-10-01T00:00:00Z", end: "2026-10-08T00:00:00Z" }],
  [
    "create_event",
    { calendar_url: `${PUBLIC_HTTP}cal/`, summary: "x", start: "2026-10-01T09:00:00Z", end: "2026-10-01T10:00:00Z" },
  ],
  ["update_event", { calendar_url: `${PUBLIC_HTTP}cal/`, uid: "u1", summary: "y" }],
  ["delete_event", { calendar_url: `${PUBLIC_HTTP}cal/`, uid: "u1" }],
  ["move_event", { calendar_url: `${PUBLIC_HTTP}cal/`, uid: "u1", target_calendar_url: `${PUBLIC_HTTP}other/` }],
  [
    "find_free_slot",
    {
      calendar_urls: [`${PUBLIC_HTTP}cal/`],
      range_start: "2026-10-01T00:00:00Z",
      range_end: "2026-10-02T00:00:00Z",
      duration_minutes: 30,
    },
  ],
];

/** Replace `globalThis.fetch` for the length of `run`, counting every request. */
async function countingFetch<T>(run: (requests: string[]) => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    requests.push(String(input instanceof Request ? input.url : input));
    throw new Error("no request may leave this test");
  }) as typeof fetch;
  try {
    return await run(requests);
  } finally {
    globalThis.fetch = original;
  }
}

test("a stored http:// CalDAV URL to a public host loads, and the store marks that account only", async () => {
  await withAccountsStore(
    [
      withCalDav("public", PUBLIC_HTTP, { default: true }),
      withCalDav("loopback", "http://127.0.0.1:5232/"),
      withCalDav("secure", "https://cloud.example.com/dav/"),
      makeAccount({ id: "nocal" }),
    ],
    (store) => {
      assert.deepEqual(store.ids(), ["public", "loopback", "secure", "nocal"], "the file loads whole");
      assert.match(store.caldavProblem("public") ?? "", /https:\/\//);
      assert.equal(store.caldavProblem("loopback"), null);
      assert.equal(store.caldavProblem("secure"), null);
      assert.equal(store.caldavProblem("nocal"), null);
    }
  );
});

test("the start-up warns once for such an account, by id and label, and not for the others", async () => {
  const lines: Array<{ level: LogLevel; message: string; extra?: Record<string, unknown> }> = [];
  await withAccountsStore(
    [
      withCalDav("public", PUBLIC_HTTP, { default: true }),
      withCalDav("loopback", "http://127.0.0.1:5232/"),
      withCalDav("secure", "https://cloud.example.com/dav/"),
    ],
    (store, dir) => {
      createApp({
        store,
        pool: new ClientPool(store),
        authToken: "unit-test-token",
        accountsFile: path.join(dir, "accounts.json"),
        publicUrl: "http://localhost.invalid",
        log: (level, message, extra) => lines.push({ level, message, extra }),
      });
    }
  );
  const warnings = lines.filter((l) => l.level === "warn");
  assert.equal(warnings.length, 1, JSON.stringify(warnings));
  assert.equal(warnings[0]?.extra?.account, "public");
  assert.equal(warnings[0]?.extra?.label, "Label of public");
  assert.match(String(warnings[0]?.extra?.notice), /https:\/\//);
  assert.ok(!JSON.stringify(lines).includes(PASSWORD));
});

test("every calendar tool on that account is refused, saying nothing was read or changed, and no request is made", async () => {
  await withAccountsStore([withCalDav("public", PUBLIC_HTTP, { default: true })], async (store) => {
    const logged: unknown[] = [];
    const pool = new ClientPool(store, (...line) => logged.push(line));
    const handlers = new Map<string, ToolHandler>();
    registerCalendarTools(
      {
        registerTool: (name: string, _config: unknown, handler: ToolHandler) => handlers.set(name, handler),
      } as unknown as McpServer,
      pool
    );
    try {
      await countingFetch(async (requests) => {
        for (const [tool, args] of CALENDAR_CALLS) {
          const handler = handlers.get(tool);
          assert.ok(handler, `${tool} is registered`);
          for (const account of [undefined, "public"]) {
            await assert.rejects(handler({ ...args, ...(account ? { account } : {}) }), (err: unknown) => {
              assert.ok(err instanceof ToolRefusal, `${tool}: expected a ToolRefusal, got ${String(err)}`);
              assert.match(err.message, /"public"/, tool);
              assert.match(err.message, /https:\/\//, tool);
              assert.match(err.message, /Nothing was read or changed\.$/, tool);
              return true;
            });
          }
        }
        assert.deepEqual(requests, [], "no request reached any server");
      });
      assert.equal(handlers.size, CALENDAR_CALLS.length, "every calendar tool was tried");
      assert.deepEqual(logged, [], "a refusal is an answer, not a mailbox failure: no log line");
    } finally {
      await pool.closeAll();
    }
  });
});
