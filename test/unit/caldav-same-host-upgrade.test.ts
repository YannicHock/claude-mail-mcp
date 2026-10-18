/**
 * #247 follow-up: a Nextcloud behind a TLS-terminating proxy.
 *
 * Nextcloud believes it runs on http://, so its `/.well-known/caldav`
 * redirect and the absolute hrefs in its PROPFIND and REPORT answers name
 * `http://` on the very host the account is configured with as `https://`.
 * The guard (src/caldav-url.ts) refuses `http://` to a host that is not local
 * — but a link to `http://` on the configured `https://` host is sent over
 * `https://` to the same host instead, so the calendar keeps working and the
 * password is never sent in cleartext. Another host, or an explicit port
 * other than 80, is still refused.
 *
 * `cloud.example.com` and `other.example` are never resolved, and nothing
 * here reaches a network: every request goes to the fake handed to the
 * client, or to the stand-in put in place of `globalThis.fetch`.
 */

import { describe, it, test } from "node:test";
import assert from "node:assert/strict";

import { CalDavClient } from "../../src/caldav-client.js";
import { CALDAV_HTTP_MESSAGE, guardedCaldavFetch, upgradedCaldavUrl } from "../../src/caldav-url.js";
import type { MailTlsDeps } from "../../src/mail-tls.js";
import { probeAccount } from "../../src/probe.js";
import type { LogLevel } from "../../src/app.js";

const PASSWORD = "dav-secret-never-in-cleartext";
const CONFIGURED = "https://cloud.example.com/";
const DAV = "/remote.php/dav/";
const PRINCIPAL = `${DAV}principals/users/u/`;
const HOME = `${DAV}calendars/u/`;
const CAL = `${HOME}personal/`;
/** What list_calendars reports: the https:// form, though the server spoke of http://. */
const CAL_HTTPS = `https://cloud.example.com${CAL}`;
/** A link inside the event's own data, which must reach Claude and the server unchanged. */
const EVENT_LINK = "URL:http://cloud.example.com/apps/meeting/1";

const STORED_ICS = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//test//EN",
  "BEGIN:VEVENT",
  "UID:ev1",
  "DTSTAMP:20261001T000000Z",
  "DTSTART:20261005T090000Z",
  "DTEND:20261005T100000Z",
  "SUMMARY:Standup",
  EVENT_LINK,
  "END:VEVENT",
  "END:VCALENDAR",
  "",
].join("\r\n");

interface Seen {
  method: string;
  url: string;
  authorized: boolean;
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function multistatus(responses: Array<{ href: string; prop: string }>): Response {
  const body = responses
    .map(
      (r) =>
        `<d:response><d:href>${r.href}</d:href><d:propstat><d:prop>${r.prop}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`
    )
    .join("");
  return new Response(
    `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/">${body}</d:multistatus>`,
    { status: 207, headers: { "content-type": "application/xml; charset=utf-8" } }
  );
}

interface FakeOptions {
  /** Where `/.well-known/caldav` sends the client; `null` for no redirect at all (404). */
  location?: string | null;
  /** The origin the absolute hrefs in the answers name. */
  hrefOrigin?: string;
}

/**
 * A Nextcloud behind a TLS proxy, as the connector sees it: it answers on
 * https://cloud.example.com, and speaks of http://cloud.example.com. A
 * request that reaches it over http:// — or to any other host — is recorded
 * and fails.
 */
function proxiedNextcloud(options: FakeOptions = {}): {
  fetch: typeof fetch;
  seen: Seen[];
  objects: Map<string, { data: string; etag: string }>;
} {
  const location = options.location === undefined ? "http://cloud.example.com/remote.php/dav/" : options.location;
  const origin = options.hrefOrigin ?? "http://cloud.example.com";
  const seen: Seen[] = [];
  const objects = new Map<string, { data: string; etag: string }>([["ev1.ics", { data: STORED_ICS, etag: '"e1"' }]]);
  let etags = 1;
  const f = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    seen.push({ method, url: url.href, authorized: headers.has("authorization") });
    if (url.protocol !== "https:" || url.host !== "cloud.example.com") {
      throw new Error(`the request reached ${url.origin}`);
    }
    const path = url.pathname;
    if (path === "/.well-known/caldav") {
      if (location === null) return new Response(null, { status: 404 });
      return new Response(null, { status: 301, headers: { location } });
    }
    if (method === "GET" && path === "/") return new Response("Nextcloud", { status: 200 });
    if (method === "PROPFIND" && path === DAV) {
      return multistatus([
        {
          href: `${origin}${DAV}`,
          prop: `<d:current-user-principal><d:href>${origin}${PRINCIPAL}</d:href></d:current-user-principal>`,
        },
      ]);
    }
    if (method === "PROPFIND" && path === PRINCIPAL) {
      // A relative href for the principal itself, an absolute http:// one for
      // the home: tsdav compares the principal URL it holds with this one.
      return multistatus([
        { href: PRINCIPAL, prop: `<c:calendar-home-set><d:href>${origin}${HOME}</d:href></c:calendar-home-set>` },
      ]);
    }
    if (method === "PROPFIND" && path === HOME) {
      return multistatus([
        { href: `${origin}${HOME}`, prop: "<d:resourcetype><d:collection/></d:resourcetype>" },
        {
          // Upper case and an explicit :80, both still the configured host.
          href: `${origin.replace("cloud.example.com", "CLOUD.example.com:80")}${CAL}`,
          prop:
            "<d:resourcetype><d:collection/><c:calendar/></d:resourcetype><d:displayname>Personal</d:displayname>" +
            '<c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set>',
        },
      ]);
    }
    if (method === "PROPFIND" && path === CAL) {
      return multistatus([{ href: `${origin}${CAL}`, prop: "<d:supported-report-set/>" }]);
    }
    if (method === "REPORT" && path === CAL) {
      return multistatus(
        [...objects].map(([name, o]) => ({
          href: `${origin}${CAL}${name}`,
          prop: `<d:getetag>${xmlEscape(o.etag)}</d:getetag><c:calendar-data>${xmlEscape(o.data)}</c:calendar-data>`,
        }))
      );
    }
    if (method === "PUT" && path.startsWith(CAL)) {
      const name = path.slice(CAL.length);
      const existing = objects.get(name);
      const ifMatch = headers.get("if-match");
      if (headers.get("if-none-match") === "*" && existing) return new Response(null, { status: 412 });
      if (ifMatch !== null && ifMatch !== "*" && existing?.etag !== ifMatch) return new Response(null, { status: 412 });
      const etag = `"e${++etags}"`;
      objects.set(name, { data: String(init?.body ?? ""), etag });
      return new Response(null, { status: existing ? 204 : 201, headers: { etag } });
    }
    return new Response("not here", { status: 404 });
  }) as typeof fetch;
  return { fetch: f, seen, objects };
}

interface LogLine {
  level: LogLevel;
  message: string;
  extra?: Record<string, unknown>;
}

function client(fake: { fetch: typeof fetch }, lines: LogLine[] = [], url = CONFIGURED): CalDavClient {
  return new CalDavClient(
    { url, user: "u", pass: PASSWORD },
    { fetch: fake.fetch, accountId: "home", log: (level, message, extra) => lines.push({ level, message, extra }) }
  );
}

function resolver(): MailTlsDeps {
  return {
    async resolveAddresses(hostname) {
      throw new Error(`ENOTFOUND ${hostname}`);
    },
  };
}

test("a Nextcloud that speaks of http:// on the configured https:// host keeps working, and only over https://", async () => {
  const fake = proxiedNextcloud();
  const lines: LogLine[] = [];
  const caldav = client(fake, lines);

  const calendars = await caldav.listCalendars();
  assert.deepEqual(
    calendars.map((c) => c.url),
    [CAL_HTTPS],
    "the calendar is reported by its https:// URL"
  );

  const listed = await caldav.listEvents(calendars[0]!.url, "2026-10-01T00:00:00Z", "2026-10-10T00:00:00Z");
  assert.equal(listed.events.length, 1, JSON.stringify(listed));
  const event = listed.events[0]!;
  assert.equal(event.uid, "ev1");
  assert.equal(event.url, `${CAL_HTTPS}ev1.ics`);

  const created = await caldav.createEvent({
    calendarUrl: calendars[0]!.url,
    summary: "Planning",
    start: "2026-10-06T09:00:00Z",
    end: "2026-10-06T10:00:00Z",
  });
  assert.ok(created.url.startsWith(CAL_HTTPS), created.url);
  assert.ok(fake.objects.has(created.url.slice(CAL_HTTPS.length)), "the new event was stored");

  const updated = await caldav.updateEvent({
    calendarUrl: calendars[0]!.url,
    uid: "ev1",
    etag: event.etag ?? undefined,
    summary: "Daily standup",
  });
  assert.equal(updated.uid, "ev1");
  const stored = fake.objects.get("ev1.ics")!.data;
  assert.match(stored, /SUMMARY:Daily standup/);
  assert.ok(stored.includes(EVENT_LINK), "a link inside the event's own data is not rewritten");

  assert.ok(fake.seen.length > 0);
  assert.deepEqual(
    fake.seen.filter((r) => !r.url.startsWith("https://cloud.example.com/")),
    [],
    "every request was sent over https:// to the configured host"
  );

  const warnings = lines.filter((l) => l.level === "warn");
  assert.equal(warnings.length, 1, JSON.stringify(lines));
  assert.equal(warnings[0]!.extra?.account, "home");
  assert.equal(warnings[0]!.extra?.host, "cloud.example.com");
  assert.match(warnings[0]!.message, /http:\/\//);
  assert.match(JSON.stringify(warnings[0]), /overwriteprotocol/);
  assert.ok(!JSON.stringify(lines).includes(PASSWORD));
});

test("with no redirect, absolute http:// hrefs under the configured https:// root still resolve", async () => {
  // tsdav holds the configured https:// root here, and compares the principal
  // URL from the server's http:// href with the principal's own, relative,
  // href resolved against that root: only one scheme throughout can match.
  const fake = proxiedNextcloud({ location: null });
  const lines: LogLine[] = [];
  const calendars = await client(fake, lines, `https://cloud.example.com${DAV}`).listCalendars();
  assert.deepEqual(calendars.map((c) => c.url), [CAL_HTTPS]);
  assert.deepEqual(fake.seen.filter((r) => !r.url.startsWith("https://cloud.example.com/")), []);
  assert.equal(lines.filter((l) => l.level === "warn").length, 1);
});

test("a calendar_url in its http:// form, from the server or an older answer, names the same calendar", async () => {
  const fake = proxiedNextcloud();
  const caldav = client(fake);
  for (const url of [
    `http://cloud.example.com${CAL}`,
    `http://cloud.example.com:80${CAL.slice(0, -1)}`,
    CAL_HTTPS,
  ]) {
    const listed = await caldav.listEvents(url, "2026-10-01T00:00:00Z", "2026-10-10T00:00:00Z");
    assert.equal(listed.events.length, 1, url);
    assert.equal(listed.events[0]!.url, `${CAL_HTTPS}ev1.ics`, url);
  }
  // Another host or port is not the configured one, and names no calendar here.
  await assert.rejects(caldav.listEvents(`http://cloud.example.com:8080${CAL}`, "2026-10-01T00:00:00Z", "2026-10-10T00:00:00Z"), /Calendar not found/);
  assert.deepEqual(fake.seen.filter((r) => !r.url.startsWith("https://cloud.example.com/")), []);
});

test("a redirect to http:// on another host is still not followed with the credentials", async () => {
  const fake = proxiedNextcloud({ location: "http://other.example/remote.php/dav/" });
  // Without the redirect's help tsdav finds nothing at the configured root.
  await assert.rejects(client(fake).listCalendars());
  assert.deepEqual(fake.seen.filter((r) => new URL(r.url).hostname !== "cloud.example.com"), []);
  assert.deepEqual(fake.seen.filter((r) => r.url.startsWith("http:")), []);
});

test("an href to http:// on another host is still refused", async () => {
  const fake = proxiedNextcloud({ hrefOrigin: "http://other.example" });
  await assert.rejects(client(fake).listCalendars());
  assert.deepEqual(fake.seen.filter((r) => new URL(r.url).hostname !== "cloud.example.com"), []);
});

test("a redirect to http:// on the configured host but another port is still refused", async () => {
  const fake = proxiedNextcloud({
    location: "http://cloud.example.com:8080/remote.php/dav/",
    hrefOrigin: "http://cloud.example.com:8080",
  });
  await assert.rejects(client(fake).listCalendars());
  assert.deepEqual(fake.seen.filter((r) => !r.url.startsWith("https://cloud.example.com/")), []);
});

test("the connection test passes against the same server, over https:// only", async () => {
  const fake = proxiedNextcloud();
  const original = globalThis.fetch;
  globalThis.fetch = fake.fetch;
  try {
    const closed = { host: "127.0.0.1", port: 1, user: "u", pass: "p", tls: false };
    const report = await probeAccount(
      { imap: closed, smtp: closed, caldav: { url: CONFIGURED, user: "u", pass: PASSWORD } },
      { perProbeMs: 2000, totalMs: 5000 }
    );
    assert.deepEqual(report.caldav, { ok: true });
  } finally {
    globalThis.fetch = original;
  }
  assert.ok(fake.seen.some((r) => r.method === "REPORT" || r.url.endsWith(HOME)), "discovery reached the calendars");
  assert.deepEqual(fake.seen.filter((r) => !r.url.startsWith("https://cloud.example.com/")), []);
});

// ---- the guard on its own ---------------------------------------------------

describe("guardedCaldavFetch with the configured https:// URL", () => {
  function recordingFetch(respond: () => Response = () => new Response("ok")): {
    fetch: typeof fetch;
    urls: string[];
  } {
    const urls: string[] = [];
    const f = (async (input: Parameters<typeof fetch>[0]) => {
      urls.push(input instanceof Request ? input.url : String(input));
      return respond();
    }) as typeof fetch;
    return { fetch: f, urls };
  }

  it("sends a request to http:// on the configured host over https:// instead, and says so once", async () => {
    const base = recordingFetch();
    const hosts: string[] = [];
    const guarded = guardedCaldavFetch(base.fetch, resolver(), {
      configuredUrl: "https://Cloud.Example.com./remote.php/dav",
      onUpgrade: (host) => hosts.push(host),
    });
    await guarded("http://cloud.example.com/remote.php/dav/");
    await guarded("http://CLOUD.example.com:80/x?y=1");
    await guarded(new Request("http://cloud.example.com./z", { method: "PROPFIND" }));
    await guarded("https://cloud.example.com/already");
    assert.deepEqual(base.urls, [
      "https://cloud.example.com/remote.php/dav/",
      "https://cloud.example.com/x?y=1",
      "https://cloud.example.com./z",
      "https://cloud.example.com/already",
    ]);
    assert.deepEqual(hosts, ["cloud.example.com"]);
  });

  it("still refuses another host, another port, and a configured URL that is not https://", async () => {
    const base = recordingFetch();
    const guarded = guardedCaldavFetch(base.fetch, resolver(), { configuredUrl: CONFIGURED });
    for (const url of ["http://other.example/", "http://cloud.example.com:8080/", "http://sub.cloud.example.com/"]) {
      await assert.rejects(guarded(url), (err: unknown) => err instanceof Error && err.message.endsWith(CALDAV_HTTP_MESSAGE), url);
    }
    const plain = guardedCaldavFetch(base.fetch, resolver(), { configuredUrl: "http://cloud.example.com/" });
    await assert.rejects(plain("http://cloud.example.com/"), /was not made/);
    assert.deepEqual(base.urls, []);
  });

  it("rewrites a same-host http:// redirect target to https://, and leaves another host's alone", async () => {
    const same = guardedCaldavFetch(
      recordingFetch(() => new Response(null, { status: 301, headers: { location: "http://cloud.example.com/remote.php/dav/" } })).fetch,
      resolver(),
      { configuredUrl: CONFIGURED }
    );
    const res = await same("https://cloud.example.com/.well-known/caldav", { redirect: "manual" });
    assert.equal(res.status, 301);
    assert.equal(res.headers.get("location"), "https://cloud.example.com/remote.php/dav/");

    const other = guardedCaldavFetch(
      recordingFetch(() => new Response(null, { status: 301, headers: { location: "http://other.example/dav/" } })).fetch,
      resolver(),
      { configuredUrl: CONFIGURED }
    );
    const res2 = await other("https://cloud.example.com/.well-known/caldav", { redirect: "manual" });
    assert.equal(res2.headers.get("location"), "http://other.example/dav/");
  });

  it("rewrites same-host http:// DAV hrefs, and nothing else in the answer", async () => {
    const body =
      '<d:multistatus xmlns:d="DAV:"><d:response><d:href>http://cloud.example.com/a/</d:href>' +
      "<d:propstat><d:prop><D:href >http://cloud.example.com:80/b/</D:href><x:href>http://cloud.example.com:8080/c/</x:href>" +
      "<href>http://other.example/d/</href><c:calendar-data>&lt;d:href&gt;http://cloud.example.com/e/" +
      "URL:http://cloud.example.com/f</c:calendar-data></d:prop></d:propstat></d:response></d:multistatus>";
    const guarded = guardedCaldavFetch(
      recordingFetch(() => new Response(body, { status: 207, headers: { "content-type": "application/xml" } })).fetch,
      resolver(),
      { configuredUrl: CONFIGURED }
    );
    const res = await guarded("https://cloud.example.com/a/", { method: "PROPFIND" });
    assert.equal(res.status, 207);
    const text = await res.text();
    assert.ok(text.includes("<d:href>https://cloud.example.com/a/</d:href>"), text);
    assert.ok(text.includes("<D:href >https://cloud.example.com/b/</D:href>"), text);
    assert.ok(text.includes("<x:href>http://cloud.example.com:8080/c/</x:href>"), text);
    assert.ok(text.includes("<href>http://other.example/d/</href>"), text);
    assert.ok(text.includes("&lt;d:href&gt;http://cloud.example.com/e/"), text);
    assert.ok(text.includes("URL:http://cloud.example.com/f"), text);
  });

  it("leaves the answers of a server on another host untouched", async () => {
    const body = '<d:multistatus xmlns:d="DAV:"><d:response><d:href>http://cloud.example.com/a/</d:href></d:response></d:multistatus>';
    const guarded = guardedCaldavFetch(
      recordingFetch(() => new Response(body, { status: 207, headers: { "content-type": "application/xml" } })).fetch,
      resolver(),
      { configuredUrl: CONFIGURED }
    );
    // A local http:// server, allowed as before, is not the configured host.
    const local = await guarded("http://127.0.0.1:5232/");
    assert.equal(await local.text(), body);
  });
});

describe("upgradedCaldavUrl", () => {
  it("gives the https:// form of a same-host http:// URL, and every other URL unchanged", () => {
    assert.equal(upgradedCaldavUrl(`http://cloud.example.com${CAL}`, CONFIGURED), CAL_HTTPS);
    assert.equal(upgradedCaldavUrl(`http://cloud.example.com:80${CAL}`, CONFIGURED), CAL_HTTPS);
    assert.equal(upgradedCaldavUrl(`http://cloud.example.com:8080${CAL}`, CONFIGURED), `http://cloud.example.com:8080${CAL}`);
    assert.equal(upgradedCaldavUrl(`http://other.example${CAL}`, CONFIGURED), `http://other.example${CAL}`);
    assert.equal(upgradedCaldavUrl(`http://cloud.example.com${CAL}`, "http://cloud.example.com/"), `http://cloud.example.com${CAL}`);
    assert.equal(upgradedCaldavUrl("not a url", CONFIGURED), "not a url");
  });
});
