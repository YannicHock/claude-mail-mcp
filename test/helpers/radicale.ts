/**
 * The Radicale half of docker-compose.test.yml: a real CalDAV server for the
 * calendar tools, the way GreenMail is a real IMAP/SMTP server for the mail
 * tools (spec 2026-09-28 §6).
 *
 * `test/helpers/fake-caldav.ts` stays what it is — two servers that speak no
 * CalDAV, for the probe. ETags, If-Match and 412 are exactly what a hand-rolled
 * fake would get subtly wrong, which is why the writes are tested here instead.
 *
 * Radicale's image ships with `[auth] type = none`: any Basic credentials are
 * accepted, and the username becomes the owner of `/<user>/`. Each test file
 * makes a fresh random user, so nothing a previous run left behind is visible
 * and no teardown between tests is needed.
 *
 * The container is started by `composeUp()` in test/helpers/docker.ts together
 * with GreenMail — one compose file, one lifecycle. Dependency-free (Node
 * stdlib only), matching the rule in fixtures.ts.
 */

import { randomUUID } from "node:crypto";

export const RADICALE_URL = "http://127.0.0.1:5232/";

/** Any password works under `auth = none`; this one only has to be non-empty. */
export const RADICALE_PASSWORD = "radicale-test-password";

/** One Radicale user and one calendar of theirs, ready for a CalDavClient. */
export interface RadicaleCalendar {
  user: string;
  /** The collection URL, with trailing slash, as list_calendars reports it. */
  calendarUrl: string;
  authHeader: string;
}

/**
 * Poll until Radicale answers HTTP at all. It is up within a second or two of
 * `compose up`, but the first request can still race the bind.
 */
export async function waitForRadicaleReady(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(RADICALE_URL, { redirect: "manual" });
      if (res.status < 500) return;
      lastError = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Radicale did not answer on ${RADICALE_URL} within ${timeoutMs}ms: ${String(lastError)}`);
}

/** A fresh user with one empty calendar, created with MKCALENDAR. */
export async function makeRadicaleCalendar(): Promise<RadicaleCalendar> {
  const user = `u${randomUUID().replaceAll("-", "")}`;
  const authHeader = `Basic ${Buffer.from(`${user}:${RADICALE_PASSWORD}`).toString("base64")}`;
  const calendarUrl = `${RADICALE_URL}${user}/cal/`;
  const res = await fetch(calendarUrl, { method: "MKCALENDAR", headers: { authorization: authHeader } });
  if (res.status !== 201) {
    throw new Error(`MKCALENDAR ${calendarUrl} answered ${res.status}`);
  }
  return { user, calendarUrl, authHeader };
}

/**
 * Store an object exactly as given, the way another client would — so a test
 * can start from properties this connector never writes (VALARM, X-, RRULE).
 * Returns the new ETag.
 */
export async function putRawEvent(
  cal: RadicaleCalendar,
  filename: string,
  ics: string
): Promise<string> {
  const res = await fetch(`${cal.calendarUrl}${filename}`, {
    method: "PUT",
    headers: {
      authorization: cal.authHeader,
      "content-type": "text/calendar; charset=utf-8",
      "if-none-match": "*",
    },
    body: ics,
  });
  if (res.status !== 201) throw new Error(`PUT ${filename} answered ${res.status}`);
  const etag = res.headers.get("etag");
  if (etag === null) throw new Error(`PUT ${filename} returned no ETag`);
  return etag;
}

/** The stored object as the server now holds it, or null if it is gone. */
export async function getRawEvent(cal: RadicaleCalendar, filename: string): Promise<string | null> {
  const res = await fetch(`${cal.calendarUrl}${filename}`, { headers: { authorization: cal.authHeader } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET ${filename} answered ${res.status}`);
  return res.text();
}

/**
 * Change an object behind the connector's back, as a phone would between
 * list_events and update_event. Returns the new ETag.
 */
export async function editBehindTheBack(
  cal: RadicaleCalendar,
  filename: string,
  ics: string
): Promise<string> {
  const res = await fetch(`${cal.calendarUrl}${filename}`, {
    method: "PUT",
    headers: { authorization: cal.authHeader, "content-type": "text/calendar; charset=utf-8" },
    body: ics,
  });
  if (!res.ok) throw new Error(`PUT ${filename} answered ${res.status}`);
  return res.headers.get("etag") ?? "";
}

/** One request as the proxy saw it, for a hook to decide whether it cares. */
export interface ProxiedRequest {
  method: string;
  /** The path on Radicale, e.g. `/u…/cal/event.ics`. */
  path: string;
}

/**
 * What {@link startCalDavProxy} does to the traffic it passes. Each option is
 * one way a real server or a real deployment differs from Radicale, and each
 * was found somewhere specific; everything not named is passed through
 * untouched.
 *
 * The plan (v0.7.4 Task 2) names five behaviours in all. The ones the read
 * path needs are here; `weakEtags`, `noEtags` and `starIfMatchBroken` (#210,
 * Task 4b) and `refuseMove` (#212, Task 7) join them with the changes that
 * test them, as further answer rewrites beside `etaglessPuts`.
 */
export interface CalDavProxyOptions {
  /**
   * Drop the ETag header from every PUT answer — what Nextcloud does when it
   * rewrites the object it stores (its scheduling plugin adds
   * SCHEDULE-STATUS), and what RFC 4791 §5.3.4 allows. Found on the v0.7.2
   * acceptance run: `update_event` then answered `etag: null`.
   */
  etaglessPuts?: boolean;
  /**
   * Replace the calendar data of the object with this file name, in every
   * REPORT answer, by something ical.js cannot parse (`X-FOO;BAR:val`, a
   * parameter with no value), and put it first. Radicale normalises what it
   * stores, so a corrupt object cannot be planted in it by content (R16);
   * this is the one bad object among many of #211.2, ahead of the rest.
   */
  corruptObject?: string;
  /**
   * Run before a request is forwarded, e.g. to delete an event between the
   * connector's lookup and its write.
   */
  before?: (req: ProxiedRequest) => Promise<void>;
  /**
   * Run after Radicale has answered and before the answer is passed on, e.g.
   * to land another version between a PUT and the connector's read-back.
   */
  after?: (req: ProxiedRequest, status: number) => Promise<void>;
}

export interface CalDavProxy {
  url: string;
  /** PUT answers an ETag was actually removed from — proof the fallback path ran. */
  strippedPuts: () => number;
  /** REPORT answers the corrupt object was planted in — proof the reader met it. */
  corruptedReports: () => number;
  close: () => Promise<void>;
}

/** The calendar-data a reader has to survive: a parameter with no value. */
const UNPARSEABLE = "BEGIN:VCALENDAR\nBEGIN:VEVENT\nX-FOO;BAR:val\nEND:VEVENT\nEND:VCALENDAR\n";

/**
 * In a multistatus body, replace the named object's calendar data and move its
 * `<response>` to the front. Radicale answers with an unprefixed DAV
 * namespace and `C:` for CalDAV, but the match allows any prefix.
 */
function plantCorruptObject(xml: string, name: string): { xml: string; planted: boolean } {
  const responses = [...xml.matchAll(/<(?:\w+:)?response>[\s\S]*?<\/(?:\w+:)?response>/g)].map((m) => m[0]);
  const index = responses.findIndex((r) => new RegExp(`<(?:\\w+:)?href>[^<]*/${name.replace(/\./g, "\\.")}</`).test(r));
  if (index === -1) return { xml, planted: false };
  const corrupt = responses[index].replace(
    /(<(\w+:)?calendar-data[^>]*>)[\s\S]*?(<\/(\w+:)?calendar-data>)/,
    (_m, open: string, _p: string, close: string) => `${open}${UNPARSEABLE}${close}`
  );
  const reordered = [corrupt, ...responses.filter((_, i) => i !== index)];
  const first = xml.indexOf(responses[0]);
  const last = xml.lastIndexOf(responses[responses.length - 1]) + responses[responses.length - 1].length;
  return { xml: xml.slice(0, first) + reordered.join("") + xml.slice(last), planted: true };
}

/**
 * A proxy in front of Radicale that behaves the way {@link CalDavProxyOptions}
 * says: what Radicale itself cannot be made to do, faked at the HTTP layer
 * (spec 2026-09-29 §6). Point a CalDavClient at `url` instead of
 * {@link RADICALE_URL}; the paths are the same.
 */
export async function startCalDavProxy(options: CalDavProxyOptions = {}): Promise<CalDavProxy> {
  let stripped = 0;
  let corrupted = 0;
  const { createServer } = await import("node:http");
  const upstream = new URL(RADICALE_URL);
  // Hop-by-hop, or no longer true once fetch has decoded the body.
  const dropped = new Set(["connection", "transfer-encoding", "content-length", "content-encoding", "keep-alive"]);
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (v === undefined || k === "host" || dropped.has(k)) continue;
        headers.set(k, Array.isArray(v) ? v.join(", ") : v);
      }
      const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
      const seen: ProxiedRequest = { method: req.method ?? "GET", path: new URL(req.url ?? "/", upstream).pathname };
      (async () => {
        await options.before?.(seen);
        const answer = await fetch(new URL(req.url ?? "/", upstream), {
          method: req.method,
          headers,
          body,
          redirect: "manual",
        });
        const out: Record<string, string> = {};
        answer.headers.forEach((v, k) => {
          if (dropped.has(k)) return;
          if (options.etaglessPuts && req.method === "PUT" && k === "etag") {
            stripped += 1;
            return;
          }
          out[k] = v;
        });
        let payload = Buffer.from(await answer.arrayBuffer());
        if (options.corruptObject !== undefined && req.method === "REPORT") {
          const { xml, planted } = plantCorruptObject(payload.toString("utf8"), options.corruptObject);
          if (planted) {
            corrupted += 1;
            payload = Buffer.from(xml, "utf8");
          }
        }
        await options.after?.(seen, answer.status);
        res.writeHead(answer.status, answer.statusText, { ...out, "content-length": String(payload.length) });
        res.end(payload);
      })().catch((err: unknown) => {
        res.writeHead(502);
        res.end(String(err));
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("proxy has no port");
  return {
    url: `http://127.0.0.1:${address.port}/`,
    strippedPuts: () => stripped,
    corruptedReports: () => corrupted,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * The file names of the objects Radicale's own `time-range` filter puts in
 * `[start, end)` (UTC ISO instants): how the server itself — and so any
 * client that asks it — places what the connector wrote. Radicale converts a
 * TZID time to an instant with its own zone data, so a window an hour either
 * side of where the event should be tells a right zone from a wrong one.
 */
export async function serverFindsIn(cal: RadicaleCalendar, start: string, end: string): Promise<string[]> {
  const stamp = (iso: string): string => iso.replace(/[-:]/g, "").replace(/\.\d+/, "");
  const body = `<?xml version="1.0" encoding="utf-8"?>
<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop><D:getetag/></D:prop>
  <C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT">
    <C:time-range start="${stamp(start)}" end="${stamp(end)}"/>
  </C:comp-filter></C:comp-filter></C:filter>
</C:calendar-query>`;
  const res = await fetch(cal.calendarUrl, {
    method: "REPORT",
    headers: { authorization: cal.authHeader, depth: "1", "content-type": "application/xml; charset=utf-8" },
    body,
  });
  if (res.status !== 207) throw new Error(`REPORT with a time-range answered ${res.status}`);
  const text = await res.text();
  return [...text.matchAll(/<(?:\w+:)?href>[^<]*\/([^/<]+)<\/(?:\w+:)?href>/g)].map((m) => decodeURIComponent(m[1])).sort();
}

/** Delete an object behind the connector's back, as a phone would. */
export async function deleteBehindTheBack(cal: RadicaleCalendar, filename: string): Promise<void> {
  const res = await fetch(`${cal.calendarUrl}${filename}`, { method: "DELETE", headers: { authorization: cal.authHeader } });
  if (!res.ok) throw new Error(`DELETE ${filename} answered ${res.status}`);
}
