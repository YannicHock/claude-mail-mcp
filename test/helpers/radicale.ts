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
