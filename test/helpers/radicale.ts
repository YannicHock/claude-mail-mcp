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

/**
 * A proxy in front of Radicale that drops the ETag header from every PUT
 * answer — what Nextcloud does when it rewrites the object it stores (its
 * scheduling plugin adds SCHEDULE-STATUS), and what RFC 4791 §5.3.4 allows.
 * Found on the v0.7.2 acceptance run: `update_event` then answered
 * `etag: null`. Everything else is passed through untouched.
 */
export async function startEtaglessPutProxy(): Promise<{
  url: string;
  /** PUT answers an ETag was actually removed from — proof the fallback path ran. */
  strippedPuts: () => number;
  close: () => Promise<void>;
}> {
  let stripped = 0;
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
      fetch(new URL(req.url ?? "/", upstream), { method: req.method, headers, body, redirect: "manual" })
        .then(async (answer) => {
          const out: Record<string, string> = {};
          answer.headers.forEach((v, k) => {
            if (dropped.has(k)) return;
            if (req.method === "PUT" && k === "etag") {
              stripped += 1;
              return;
            }
            out[k] = v;
          });
          const payload = Buffer.from(await answer.arrayBuffer());
          res.writeHead(answer.status, answer.statusText, { ...out, "content-length": String(payload.length) });
          res.end(payload);
        })
        .catch((err: unknown) => {
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
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
