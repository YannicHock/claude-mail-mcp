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
 * A second calendar of `cal`'s user, named `name`: what `move_event` moves
 * an event into (#212). Radicale moves between two calendars of one user
 * (R11), and between users not at all.
 */
export async function addRadicaleCalendar(cal: RadicaleCalendar, name: string): Promise<RadicaleCalendar> {
  const calendarUrl = `${RADICALE_URL}${cal.user}/${name}/`;
  const res = await fetch(calendarUrl, { method: "MKCALENDAR", headers: { authorization: cal.authHeader } });
  if (res.status !== 201) {
    throw new Error(`MKCALENDAR ${calendarUrl} answered ${res.status}`);
  }
  return { ...cal, calendarUrl };
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

/**
 * Every instance Radicale's own `<C:expand>` makes of the objects in
 * `[start, end)`, as `[recurrenceId, start]` pairs of UTC ISO instants sorted
 * by start: how the server — and any client that asks it to expand — reads
 * a series the connector wrote. Radicale writes the expanded DTSTART and
 * RECURRENCE-ID in UTC (spec 2026-09-29 §0.1, R5), which is what this reads.
 * Only for timed series in a zone or UTC: Radicale's expansion fails on the
 * all-day and floating shapes (R1, R2).
 */
export async function serverExpands(cal: RadicaleCalendar, start: string, end: string): Promise<Array<[string | null, string]>> {
  const stamp = (iso: string): string => iso.replace(/[-:]/g, "").replace(/\.\d+/, "");
  const body = `<?xml version="1.0" encoding="utf-8"?>
<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop><C:calendar-data><C:expand start="${stamp(start)}" end="${stamp(end)}"/></C:calendar-data></D:prop>
  <C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT">
    <C:time-range start="${stamp(start)}" end="${stamp(end)}"/>
  </C:comp-filter></C:comp-filter></C:filter>
</C:calendar-query>`;
  const res = await fetch(cal.calendarUrl, {
    method: "REPORT",
    headers: { authorization: cal.authHeader, depth: "1", "content-type": "application/xml; charset=utf-8" },
    body,
  });
  if (res.status !== 207) throw new Error(`REPORT with expand answered ${res.status}`);
  const text = (await res.text()).replace(/&#13;/g, "").replace(/\r/g, "");
  const iso = (value: string): string =>
    `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(9, 11)}:${value.slice(11, 13)}:${value.slice(13, 15)}.000Z`;
  const instances: Array<[string | null, string]> = [];
  for (const [vevent] of text.matchAll(/BEGIN:VEVENT\n[\s\S]*?END:VEVENT/g)) {
    const dtstart = /\nDTSTART:(\d{8}T\d{6})Z/.exec(vevent);
    if (dtstart === null) throw new Error(`an expanded instance has no UTC DTSTART:\n${vevent}`);
    const rid = /\nRECURRENCE-ID:(\d{8}T\d{6})Z/.exec(vevent);
    instances.push([rid === null ? null : iso(rid[1]), iso(dtstart[1])]);
  }
  return instances.sort((a, b) => a[1].localeCompare(b[1]));
}

/** Delete an object behind the connector's back, as a phone would. */
export async function deleteBehindTheBack(cal: RadicaleCalendar, filename: string): Promise<void> {
  const res = await fetch(`${cal.calendarUrl}${filename}`, { method: "DELETE", headers: { authorization: cal.authHeader } });
  if (!res.ok) throw new Error(`DELETE ${filename} answered ${res.status}`);
}
