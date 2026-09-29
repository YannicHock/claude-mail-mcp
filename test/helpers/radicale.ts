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
  /** The request's If-Match header, or null when it had none. */
  ifMatch: string | null;
}

/**
 * What {@link startCalDavProxy} does to the traffic it passes. Each option is
 * one way a real server or a real deployment differs from Radicale, and each
 * was found somewhere specific; everything not named is passed through
 * untouched.
 *
 * Each is one rewriter in {@link startCalDavProxy}: of the request, of
 * Radicale's answer, or of both.
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
   * What `corruptObject` is replaced by, instead of the unparseable text: an
   * object Radicale itself could not be trusted to store or to answer a
   * time-range query for, such as a recurrence rule ical.js never returns
   * from (review of #223).
   */
  corruptWith?: string;
  /**
   * Hand out every ETag weak, `W/"…"`, in headers and in `getetag` — what a
   * proxy that compresses the answer does to a strong one (nginx with gzip
   * does). Requests are passed on untouched, so an `If-Match` naming a weak
   * ETag meets Radicale's strong comparison and 412s (R9), as it would behind
   * such a proxy (#210.3).
   */
  weakEtags?: boolean;
  /**
   * Hand out no ETag at all, neither as a header nor as `getetag` (#210.1),
   * and give `If-Match: *` its RFC 7232 meaning, which Radicale does not on
   * PUT (R10): the proxy answers 412 itself when the object is missing, and
   * passes the request on without the header when it exists.
   */
  noEtags?: boolean;
  /**
   * Answer 412 to every PUT carrying `If-Match: *`, existing object or not —
   * the literal comparison Radicale itself makes (R10), made explicit so the
   * test does not depend on a Radicale version keeping it.
   */
  starIfMatchBroken?: boolean;
  /**
   * Answer `201 Created` to every PUT Radicale accepted, replacing an object
   * or not — what Radicale 3.2.3 itself does (its `put.py` answers CREATED to
   * every PUT; only later versions answer 204 to a replacement), and what
   * RFC 9110 does not forbid. A client that reads a 201 as "this did not
   * exist before" deletes the user's own event on such a server (review of
   * #224).
   */
  createdOnOverwrite?: boolean;
  /**
   * Answer `503 Service Unavailable` to the first this many PROPFINDs asking
   * for `calendar-user-address-set` — the account's own addresses — and pass
   * the rest on: a server that fails for a moment and then answers (review
   * of PR #230). tsdav turns such a 503 into the same error as a principal
   * that lists no address, which the connector once took for "no address"
   * and cached for the client's lifetime.
   */
  failAddressLookups?: number;
  /**
   * Answer every MOVE with this status itself, never passing it on: a server
   * that refuses a MOVE between two collections (spec 2026-09-29 §2.6 names
   * 403, 405, 501 and 502), so `move_event` has to copy the event into the
   * target and delete it from the source instead (#212).
   */
  refuseMove?: 403 | 405 | 501 | 502;
  /**
   * Answer `412 Precondition Failed` to every DELETE of an object under this
   * path on Radicale — a collection's, e.g. `/u…/cal/`: the source's event
   * changed after `move_event` copied it into the target, so the copy has to
   * be removed again (plan v0.7.4, Review Focus 3).
   */
  failSourceDelete?: string;
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
  /** Every request the proxy was sent, in order. */
  requests: () => ProxiedRequest[];
  /** PUTs refused for their `If-Match: *` under `starIfMatchBroken`. */
  starRefusals: () => number;
  /** MOVEs the proxy answered itself under `refuseMove`: proof the fallback was needed. */
  refusedMoves: () => number;
  close: () => Promise<void>;
}

/** The calendar-data a reader has to survive: a parameter with no value. */
const UNPARSEABLE = "BEGIN:VCALENDAR\nBEGIN:VEVENT\nX-FOO;BAR:val\nEND:VEVENT\nEND:VCALENDAR\n";

/**
 * In a multistatus body, replace the named object's calendar data and move its
 * `<response>` to the front. Radicale answers with an unprefixed DAV
 * namespace and `C:` for CalDAV, but the match allows any prefix.
 */
function plantCorruptObject(xml: string, name: string, data: string = UNPARSEABLE): { xml: string; planted: boolean } {
  const responses = [...xml.matchAll(/<(?:\w+:)?response>[\s\S]*?<\/(?:\w+:)?response>/g)].map((m) => m[0]);
  const index = responses.findIndex((r) => new RegExp(`<(?:\\w+:)?href>[^<]*/${name.replace(/\./g, "\\.")}</`).test(r));
  if (index === -1) return { xml, planted: false };
  const corrupt = responses[index].replace(
    /(<(\w+:)?calendar-data[^>]*>)[\s\S]*?(<\/(\w+:)?calendar-data>)/,
    (_m, open: string, _p: string, close: string) => `${open}${data.replaceAll("&", "&amp;").replaceAll("<", "&lt;")}${close}`
  );
  const reordered = [corrupt, ...responses.filter((_, i) => i !== index)];
  const first = xml.indexOf(responses[0]);
  const last = xml.lastIndexOf(responses[responses.length - 1]) + responses[responses.length - 1].length;
  return { xml: xml.slice(0, first) + reordered.join("") + xml.slice(last), planted: true };
}

/** An ETag made weak: `"abc"` becomes `W/"abc"`, and one already weak is left alone. */
function weakened(etag: string): string {
  return /^W\//i.test(etag) ? etag : `W/${etag}`;
}

/** Rewrite, or with `null` remove, every `getetag` element in a multistatus body. */
function rewriteGetetags(xml: string, change: ((etag: string) => string) | null): string {
  return xml.replace(/<((?:\w+:)?getetag)>([^<]*)<\/\1>/g, (_m, tag: string, value: string) => {
    if (change === null) return "";
    // Radicale sends the quotes as `&quot;`; the rewrite is on the unescaped value.
    const plain = value.replaceAll("&quot;", '"');
    return `<${tag}>${change(plain).replaceAll('"', "&quot;")}</${tag}>`;
  });
}

/**
 * One request on its way through the proxy: what a {@link RequestRewriter}
 * may change before it is forwarded. `headers` are already the ones that
 * will be sent upstream.
 */
interface Exchange {
  seen: ProxiedRequest;
  /** The request's URL on Radicale. */
  upstreamUrl: URL;
  headers: Headers;
  body: ReturnType<typeof Buffer.concat> | undefined;
}

/** An answer the proxy gives itself, without asking Radicale. */
interface ShortAnswer {
  status: number;
  statusText: string;
  body?: string;
}

/** Radicale's answer on its way back: what a {@link ResponseRewriter} may change before it is passed on. */
interface Answer {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  payload: Buffer;
}

/**
 * One mode's change to a request: an answer of its own, which ends the
 * exchange there, or null, and the request goes on (with whatever it
 * changed in the exchange's headers).
 */
type RequestRewriter = (ex: Exchange) => Promise<ShortAnswer | null>;

/** One mode's change to Radicale's answer, made in place. */
type ResponseRewriter = (ex: Exchange, answer: Answer) => void;

const PRECONDITION_FAILED: ShortAnswer = { status: 412, statusText: "Precondition Failed" };

/**
 * A proxy in front of Radicale that behaves the way {@link CalDavProxyOptions}
 * says: what Radicale itself cannot be made to do, faked at the HTTP layer
 * (spec 2026-09-29 §6). Point a CalDavClient at `url` instead of
 * {@link RADICALE_URL}; the paths are the same.
 *
 * Each option is one rewriter of the request, of the answer, or of both
 * (health review P3), and the handler at the bottom only runs them: a new
 * mode is one more rewriter, not one more branch in a single function. The
 * request rewriters run in the order they are pushed below, and the first
 * one that answers itself ends the exchange there; the answer rewriters run
 * on what Radicale said, after the `after` hook.
 *
 * One rewrite is not a mode: a MOVE's `Destination` names the proxy, and
 * Radicale answers 502 to a destination on any host but its own (its
 * `move.py`), so it is pointed at Radicale, as a reverse proxy in front of a
 * real server leaves the host the server knows itself by.
 */
export async function startCalDavProxy(options: CalDavProxyOptions = {}): Promise<CalDavProxy> {
  let stripped = 0;
  let corrupted = 0;
  let starRefused = 0;
  let failedLookups = 0;
  let movesRefused = 0;
  const log: ProxiedRequest[] = [];
  const { createServer } = await import("node:http");
  const upstream = new URL(RADICALE_URL);
  // Hop-by-hop, or no longer true once fetch has decoded the body.
  const dropped = new Set(["connection", "transfer-encoding", "content-length", "content-encoding", "keep-alive"]);

  const requestRewriters: RequestRewriter[] = [];
  const responseRewriters: ResponseRewriter[] = [];
  const isStarWrite = (ex: Exchange): boolean =>
    ex.seen.ifMatch?.trim() === "*" && (ex.seen.method === "PUT" || ex.seen.method === "DELETE");

  if (options.failAddressLookups !== undefined) {
    const limit = options.failAddressLookups;
    requestRewriters.push(async (ex) => {
      if (ex.seen.method !== "PROPFIND" || failedLookups >= limit) return null;
      if (!ex.body?.toString("utf8").includes("calendar-user-address-set")) return null;
      failedLookups += 1;
      return { status: 503, statusText: "Service Unavailable", body: "unavailable" };
    });
  }
  if (options.starIfMatchBroken) {
    requestRewriters.push(async (ex) => {
      if (!isStarWrite(ex) || ex.seen.method !== "PUT") return null;
      starRefused += 1;
      return PRECONDITION_FAILED;
    });
  }
  if (options.noEtags) {
    requestRewriters.push(async (ex) => {
      if (!isStarWrite(ex)) return null;
      const exists = await fetch(ex.upstreamUrl, {
        method: "GET",
        headers: { authorization: ex.headers.get("authorization") ?? "" },
      });
      await exists.arrayBuffer();
      if (exists.status === 404) return PRECONDITION_FAILED;
      ex.headers.delete("if-match");
      return null;
    });
    responseRewriters.push((ex, answer) => {
      delete answer.headers.etag;
      if (ex.seen.method === "REPORT" || ex.seen.method === "PROPFIND") {
        answer.payload = Buffer.from(rewriteGetetags(answer.payload.toString("utf8"), null), "utf8");
      }
    });
  }
  if (options.refuseMove !== undefined) {
    const status = options.refuseMove;
    requestRewriters.push(async (ex) => {
      if (ex.seen.method !== "MOVE") return null;
      movesRefused += 1;
      return { status, statusText: "Refused by the proxy" };
    });
  }
  if (options.failSourceDelete !== undefined) {
    const collection = options.failSourceDelete;
    requestRewriters.push(async (ex) => {
      if (ex.seen.method !== "DELETE" || !ex.seen.path.startsWith(collection)) return null;
      return PRECONDITION_FAILED;
    });
  }
  if (options.etaglessPuts) {
    responseRewriters.push((ex, answer) => {
      if (ex.seen.method !== "PUT" || answer.headers.etag === undefined) return;
      stripped += 1;
      delete answer.headers.etag;
    });
  }
  if (options.weakEtags) {
    responseRewriters.push((ex, answer) => {
      if (answer.headers.etag !== undefined) answer.headers.etag = weakened(answer.headers.etag);
      if (ex.seen.method === "REPORT" || ex.seen.method === "PROPFIND") {
        answer.payload = Buffer.from(rewriteGetetags(answer.payload.toString("utf8"), weakened), "utf8");
      }
    });
  }
  if (options.corruptObject !== undefined) {
    const name = options.corruptObject;
    responseRewriters.push((ex, answer) => {
      if (ex.seen.method !== "REPORT") return;
      const { xml, planted } = plantCorruptObject(answer.payload.toString("utf8"), name, options.corruptWith);
      if (!planted) return;
      corrupted += 1;
      answer.payload = Buffer.from(xml, "utf8");
    });
  }
  if (options.createdOnOverwrite) {
    responseRewriters.push((ex, answer) => {
      if (ex.seen.method !== "PUT" || answer.status < 200 || answer.status > 299) return;
      answer.status = 201;
      answer.statusText = "Created";
    });
  }

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (v === undefined || k === "host" || dropped.has(k)) continue;
        headers.set(k, Array.isArray(v) ? v.join(", ") : v);
      }
      const destination = headers.get("destination");
      if (destination !== null) {
        const named = new URL(destination);
        headers.set("destination", new URL(named.pathname + named.search, upstream).href);
      }
      const upstreamUrl = new URL(req.url ?? "/", upstream);
      const seen: ProxiedRequest = {
        method: req.method ?? "GET",
        path: upstreamUrl.pathname,
        ifMatch: headers.get("if-match"),
      };
      log.push(seen);
      const ex: Exchange = { seen, upstreamUrl, headers, body: chunks.length > 0 ? Buffer.concat(chunks) : undefined };
      (async () => {
        await options.before?.(seen);
        for (const rewrite of requestRewriters) {
          const short = await rewrite(ex);
          if (short === null) continue;
          const body = short.body ?? "";
          res.writeHead(short.status, short.statusText, {
            ...(body === "" ? {} : { "content-type": "text/plain" }),
            "content-length": String(Buffer.byteLength(body)),
          });
          res.end(body);
          return;
        }
        const upstreamAnswer = await fetch(upstreamUrl, {
          method: seen.method,
          headers: ex.headers,
          body: ex.body,
          redirect: "manual",
        });
        const answer: Answer = {
          status: upstreamAnswer.status,
          statusText: upstreamAnswer.statusText,
          headers: {},
          payload: Buffer.from(await upstreamAnswer.arrayBuffer()),
        };
        upstreamAnswer.headers.forEach((v, k) => {
          if (!dropped.has(k)) answer.headers[k] = v;
        });
        await options.after?.(seen, answer.status);
        for (const rewrite of responseRewriters) rewrite(ex, answer);
        res.writeHead(answer.status, answer.statusText, { ...answer.headers, "content-length": String(answer.payload.length) });
        res.end(answer.payload);
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
    requests: () => [...log],
    starRefusals: () => starRefused,
    refusedMoves: () => movesRefused,
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
