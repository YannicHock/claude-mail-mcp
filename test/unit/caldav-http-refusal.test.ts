/**
 * #247 beyond the rule itself (test/unit/caldav-url.test.ts): an
 * accounts.json that already holds an `http://` CalDAV URL to a host that is
 * not local, and a server configured as `https://` that sends the client to
 * `http://` anyway.
 *
 * The file loads (#155), the start-up warns once, and every calendar tool on
 * the account is refused before any request. The check is made on every call,
 * so a name that failed to resolve once is not refused for good. And the
 * CalDAV client sends no request — tsdav's discovery included — to an
 * `http://` URL on a host that is not local, wherever the URL came from. The
 * mail half of such an account is GreenMail's to show
 * (test/integration/caldav-http-refusal.test.ts).
 *
 * `cloud.example.com` and `public.example` are never resolved — a dotted
 * public name is not local by its form alone — and `globalThis.fetch`, or the
 * fake the client is given, counts what would have been sent.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import dnsPromises from "node:dns/promises";
import path from "node:path";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createDAVClient } from "tsdav";
import { createApp, warnAboutCaldavUrls, type LogLevel } from "../../src/app.js";
import { CalDavClient } from "../../src/caldav-client.js";
import { CALDAV_HTTP_MESSAGE, CALDAV_UNRESOLVED_MESSAGE } from "../../src/caldav-url.js";
import { ClientPool } from "../../src/client-pool.js";
import { probeAccount } from "../../src/probe.js";
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
interface LogLine {
  level: LogLevel;
  message: string;
  extra?: Record<string, unknown>;
}

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

/** Replace `globalThis.fetch` for the length of `run`, counting every request and failing it. */
async function countingFetch<T>(run: (requests: string[]) => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    requests.push(input instanceof Request ? input.url : String(input));
    throw new Error("the request reached the network stand-in");
  }) as typeof fetch;
  try {
    return await run(requests);
  } finally {
    globalThis.fetch = original;
  }
}

/** The calendar tools, registered against a stand-in server, over `store`'s accounts. */
function calendarTools(pool: ClientPool): Map<string, ToolHandler> {
  const handlers = new Map<string, ToolHandler>();
  registerCalendarTools(
    {
      registerTool: (name: string, _config: unknown, handler: ToolHandler) => handlers.set(name, handler),
    } as unknown as McpServer,
    pool
  );
  return handlers;
}

/** Let every pending promise and timer that is already due settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 5));
}

test("a stored http:// CalDAV URL to a public host does not stop the file from loading", async () => {
  await withAccountsStore(
    [withCalDav("public", PUBLIC_HTTP, { default: true }), withCalDav("loopback", "http://127.0.0.1:5232/")],
    (store) => {
      assert.deepEqual(store.ids(), ["public", "loopback"]);
    }
  );
});

test("the start-up warns once for such an account, by id and label, and not for the others", async () => {
  const lines: LogLine[] = [];
  await withAccountsStore(
    [
      withCalDav("public", PUBLIC_HTTP, { default: true }),
      withCalDav("loopback", "http://127.0.0.1:5232/"),
      withCalDav("secure", "https://cloud.example.com/dav/"),
    ],
    async (store, dir) => {
      createApp({
        store,
        pool: new ClientPool(store),
        authToken: "unit-test-token",
        accountsFile: path.join(dir, "accounts.json"),
        publicUrl: "http://localhost.invalid",
        log: (level, message, extra) => lines.push({ level, message, extra }),
      });
      await settle();
    }
  );
  const warnings = lines.filter((l) => l.level === "warn");
  assert.equal(warnings.length, 1, JSON.stringify(warnings));
  assert.equal(warnings[0]?.extra?.account, "public");
  assert.equal(warnings[0]?.extra?.label, "Label of public");
  assert.equal(warnings[0]?.extra?.notice, CALDAV_HTTP_MESSAGE);
  assert.ok(!JSON.stringify(lines).includes(PASSWORD));
});

test("a reload warns only about a refused CalDAV URL it introduced", async () => {
  const lines: LogLine[] = [];
  const log = (level: LogLevel, message: string, extra?: Record<string, unknown>): void => {
    lines.push({ level, message, extra });
  };
  const prev = [withCalDav("old", PUBLIC_HTTP), withCalDav("edited", "https://cloud.example.com/dav/")];
  const next = [
    withCalDav("old", PUBLIC_HTTP),
    withCalDav("edited", PUBLIC_HTTP),
    withCalDav("added", "http://8.8.8.8/dav/"),
    withCalDav("fine", "http://127.0.0.1:5232/"),
  ];
  await warnAboutCaldavUrls(log, next, prev);
  assert.deepEqual(
    lines.map((l) => [l.level, l.extra?.account]).sort(),
    [
      ["warn", "added"],
      ["warn", "edited"],
    ]
  );
});

test("every calendar tool on that account is refused, saying nothing was read or changed, and no request is made", async () => {
  await withAccountsStore([withCalDav("public", PUBLIC_HTTP, { default: true })], async (store) => {
    const logged: unknown[] = [];
    const pool = new ClientPool(store, (...line) => logged.push(line));
    const handlers = calendarTools(pool);
    try {
      await countingFetch(async (requests) => {
        for (const [tool, args] of CALENDAR_CALLS) {
          const handler = handlers.get(tool);
          assert.ok(handler, `${tool} is registered`);
          for (const account of [undefined, "public"]) {
            await assert.rejects(handler({ ...args, ...(account ? { account } : {}) }), (err: unknown) => {
              assert.ok(err instanceof ToolRefusal, `${tool}: expected a ToolRefusal, got ${String(err)}`);
              assert.equal(err.message, `Account "public": ${CALDAV_HTTP_MESSAGE} Nothing was read or changed.`);
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

test("a name that did not resolve is refused for that call only, and used once it resolves", async () => {
  // The case review found sticking: Radicale down when the connector starts.
  // `resolveAddresses` (src/net-address.ts) reads `dns.lookup` at call time.
  const original = dnsPromises.lookup;
  let up = false;
  (dnsPromises as { lookup: unknown }).lookup = async (hostname: string) => {
    if (hostname === "radicale" && up) return [{ address: "172.18.0.3", family: 4 }];
    throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: "ENOTFOUND" });
  };
  try {
    await withAccountsStore([withCalDav("home", "http://radicale:5232/", { default: true })], async (store) => {
      const pool = new ClientPool(store);
      const listCalendars = calendarTools(pool).get("list_calendars")!;
      try {
        await countingFetch(async (requests) => {
          await assert.rejects(listCalendars({}), (err: unknown) => {
            assert.ok(err instanceof ToolRefusal, String(err));
            assert.equal(err.message, `Account "home": ${CALDAV_UNRESOLVED_MESSAGE} Nothing was read or changed.`);
            return true;
          });
          assert.equal(requests.length, 0);

          up = true;
          // Now it is let through: whatever happens next is the server's
          // answer — here the stand-in's failure — not the refusal.
          await assert.rejects(listCalendars({}), (err: unknown) => !(err instanceof ToolRefusal));
          assert.ok(requests.length > 0, "the request went out once the name resolved locally");
          assert.ok(requests.every((url) => url.startsWith("http://radicale:5232/")));
        });
      } finally {
        await pool.closeAll();
      }
    });
  } finally {
    (dnsPromises as { lookup: unknown }).lookup = original;
  }
});

test("the connection test sends no CalDAV request to http:// on a public host either", async () => {
  const closed = { host: "127.0.0.1", port: 1, user: "u", pass: "p", tls: false };
  await countingFetch(async (requests) => {
    const report = await probeAccount(
      { imap: closed, smtp: closed, caldav: { url: PUBLIC_HTTP, user: "u", pass: PASSWORD } },
      { perProbeMs: 2000, totalMs: 5000 }
    );
    assert.equal(report.caldav?.ok, false);
    // The reason, bounded like every probe message (MAX_MESSAGE_LENGTH).
    assert.match(report.caldav && !report.caldav.ok ? report.caldav.message : "", /not made, and no password was sent/);
    assert.deepEqual(requests, []);
  });
});

// ---- an https:// account that the server sends to http:// ----------------

/** A CalDAV server stand-in: answers by `respond`, recording every request and its Authorization header. */
function fakeServer(respond: (url: URL, init: RequestInit | undefined) => Response): {
  fetch: typeof fetch;
  seen: Array<{ url: string; authorized: boolean }>;
} {
  const seen: Array<{ url: string; authorized: boolean }> = [];
  const f = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers = new Headers(init?.headers);
    seen.push({ url: url.href, authorized: headers.has("authorization") });
    return respond(url, init);
  }) as typeof fetch;
  return { fetch: f, seen };
}

function multistatus(href: string, prop: string): Response {
  return new Response(
    `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:response>
    <d:href>${href}</d:href>
    <d:propstat><d:prop>${prop}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  </d:response>
</d:multistatus>`,
    { status: 207, headers: { "content-type": "application/xml; charset=utf-8" } }
  );
}

/** The requests in `seen` that went to the `http://` host, with or without credentials. */
function toPublic(seen: Array<{ url: string; authorized: boolean }>): Array<{ url: string; authorized: boolean }> {
  return seen.filter((r) => new URL(r.url).hostname === "public.example");
}

/**
 * Each case is run twice: through tsdav on its own with the same stand-in,
 * which shows the credentials *would* go to the `http://` host — tsdav tries
 * the next candidate root URL after a failure and reports only the last
 * error, so the error message alone cannot show it — and through
 * `CalDavClient`, whose guard must keep every request away from it.
 */
async function runBothWays(serverUrl: string, respond: (url: URL, init: RequestInit | undefined) => Response): Promise<void> {
  const unguarded = fakeServer(respond);
  await createDAVClient({
    serverUrl,
    credentials: { username: "u", password: PASSWORD },
    authMethod: "Basic",
    defaultAccountType: "caldav",
    fetch: unguarded.fetch,
  })
    .then((c) => c.fetchCalendars())
    .catch(() => undefined);
  assert.ok(
    toPublic(unguarded.seen).some((r) => r.authorized),
    `tsdav alone sends the credentials to the http:// host: ${JSON.stringify(unguarded.seen)}`
  );

  const guarded = fakeServer(respond);
  const client = new CalDavClient({ url: serverUrl, user: "u", pass: PASSWORD }, { fetch: guarded.fetch });
  await assert.rejects(client.listCalendars());
  assert.ok(guarded.seen.length > 0, "the https:// server was asked");
  assert.deepEqual(toPublic(guarded.seen), [], "nothing at all went to the http:// host");
}

test("a /.well-known/caldav redirect to http:// on a public host is not followed with the credentials", async () => {
  await runBothWays("https://dav.example/", (url) => {
    if (url.pathname === "/.well-known/caldav") {
      return new Response(null, { status: 301, headers: { location: "http://public.example/remote.php/dav/" } });
    }
    return new Response("unexpected", { status: 500 });
  });
});

test("an absolute http:// href in a PROPFIND answer is not followed with the credentials", async () => {
  await runBothWays("https://dav.example/dav/", (url, init) => {
    if (url.pathname === "/.well-known/caldav") return new Response(null, { status: 404 });
    if (init?.method === "PROPFIND" && url.hostname === "dav.example") {
      return multistatus(
        url.pathname,
        "<d:current-user-principal><d:href>http://public.example/principals/u/</d:href></d:current-user-principal>"
      );
    }
    return new Response("unexpected", { status: 500 });
  });
});

test("the guard's refusal names the http:// URL and the rule", async () => {
  const client = new CalDavClient(
    { url: "https://dav.example/dav/", user: "u", pass: PASSWORD },
    {
      fetch: fakeServer((url) =>
        url.pathname === "/.well-known/caldav"
          ? new Response(null, { status: 404 })
          : multistatus(url.pathname, "<d:current-user-principal><d:href>/p/</d:href></d:current-user-principal>")
      ).fetch,
    }
  );
  // move_event's own requests go through the same guard as tsdav's.
  await assert.rejects(
    (client as unknown as { davFetch(m: string, u: string): Promise<Response> }).davFetch("MOVE", "http://public.example/x.ics"),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /^The CalDAV request to http:\/\/public\.example was not made/);
      assert.ok(err.message.endsWith(CALDAV_HTTP_MESSAGE));
      return true;
    }
  );
});

