/**
 * A proxy in front of the test Radicale (test/helpers/radicale.ts) that makes
 * it behave like the servers and deployments it is not: Nextcloud's PUT
 * answers with no ETag, a gzip proxy's weak ETags, a gateway's 502 to a MOVE,
 * and the rest of {@link CalDavProxyOptions}. Moved out of radicale.ts
 * (#234), which keeps Radicale itself: its users, its calendars, and the raw
 * requests that go round the connector. Dependency-free (Node stdlib only),
 * matching the rule in fixtures.ts.
 */

import { RADICALE_URL } from "./radicale.js";

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
   * Replace the calendar data of the object with the file name `name`, in
   * every REPORT answer, by something ical.js cannot parse (`X-FOO;BAR:val`,
   * a parameter with no value), and put it first. Radicale normalises what it
   * stores, so a corrupt object cannot be planted in it by content (R16);
   * this is the one bad object among many of #211.2, ahead of the rest.
   *
   * With `data`, that is what replaces it instead of the unparseable text: an
   * object Radicale itself could not be trusted to store or to answer a
   * time-range query for, such as a recurrence rule ical.js never returns
   * from (review of #223).
   */
  corrupt?: { name: string; data?: string };
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
   * Answer every MOVE with `status` itself, never passing it on: a server
   * that refuses a MOVE between two collections (spec 2026-09-29 §2.6 names
   * 403, 405, 501 and 502), so `move_event` has to copy the event into the
   * target and delete it from the source instead (#212).
   *
   * `body` is what it answers with, e.g. Radicale's own "Remote destination
   * not supported" beside its 502, or a `<C:no-uid-conflict/>` precondition
   * beside a 403 (review of PR #231). Empty by default.
   */
  refuseMove?: { status: 403 | 405 | 501 | 502; body?: string };
  /**
   * Pass every MOVE on to Radicale (`perform: true`) or not, and answer it
   * with `answer` either way: a 502 or 504 from a gateway in front of the
   * server (NPM on Hetzner), which says nothing about whether the MOVE
   * happened, or `"drop"`, the connection closed with no answer at all.
   * With `thenDown`, every request after the MOVE is dropped too: the server
   * gone just as the move was sent (review of PR #231).
   */
  garbleMove?: { perform: boolean; answer: 502 | 504 | "drop"; thenDown?: boolean };
  /**
   * Answer `status` (412 Precondition Failed by default) to every DELETE of
   * an object under the path `under` on Radicale — a collection's, e.g.
   * `/u…/cal/`: the source's event changed after `move_event` copied it into
   * the target (412), or the source is read-only (403), so the copy has to
   * be removed again (plan v0.7.4, Review Focus 3).
   */
  failSourceDelete?: { under: string; status?: number };
  /**
   * Answer `status` (403 by default) to every PUT of an object under the
   * path `under` on Radicale: a target calendar that refuses the fallback's
   * copy — 403 for a read-only calendar, 507 for one that is full (review of
   * PR #231).
   */
  failTargetPut?: { under: string; status?: number };
  /**
   * Answer `400 Bad Request` with Sabre's "already exists" message where
   * Radicale answers a PUT `409 <C:no-uid-conflict/>`: how Nextcloud refuses
   * an object whose UID the calendar already holds, with no precondition
   * name to give it away (review of PR #231).
   */
  uidConflictAs400?: boolean;
  /**
   * Answer the PROPFIND for `calendar-user-address-set` as a principal that
   * lists these hrefs, instead of Radicale's own non-`mailto:` one (R13):
   * Nextcloud, whose principal's address may be another than the mailbox's
   * (review of PR #232). Each replaces the hrefs inside the property, with
   * the prefix Radicale wrote them with.
   */
  principalAddresses?: string[];
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

/** How often a mode of {@link CalDavProxyOptions} actually changed something: proof that the path it exists for ran. */
export interface CalDavProxyCounts {
  /** PUT answers an ETag was actually removed from under `etaglessPuts`. */
  strippedPuts: number;
  /** REPORT answers the object of `corrupt` was planted in. */
  corruptedReports: number;
  /** PUTs refused for their `If-Match: *` under `starIfMatchBroken`. */
  starRefusals: number;
  /** MOVEs the proxy answered itself under `refuseMove`. */
  refusedMoves: number;
}

export interface CalDavProxy {
  url: string;
  /** The counts so far. */
  counts: () => CalDavProxyCounts;
  /** Every request the proxy was sent, in order. */
  requests: () => ProxiedRequest[];
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

/**
 * An answer the proxy gives itself, without asking Radicale — or, with
 * `drop`, none: the connection is closed, as a server that went away does.
 */
interface ShortAnswer {
  status: number;
  statusText: string;
  body?: string;
  drop?: boolean;
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
const DROPPED: ShortAnswer = { status: 0, statusText: "", drop: true };

/**
 * A proxy in front of Radicale that behaves the way {@link CalDavProxyOptions}
 * says: what Radicale itself cannot be made to do, faked at the HTTP layer
 * (spec 2026-09-29 §6). Point a CalDavClient at `url` instead of
 * {@link RADICALE_URL}; the paths are the same.
 *
 * Each option is one rewriter of the request, of the answer, or of both
 * (health review P3), and the handler at the bottom only runs them: a new
 * mode is one more rewriter, not one more branch in a single function.
 *
 * **The order they are pushed in below is their precedence**, and a new
 * mode goes where its precedence over the others is the one a real server
 * would show (#234). The request rewriters run in that order, and the first
 * one that answers itself ends the exchange there, so where two modes claim
 * one request the earlier wins: `starIfMatchBroken` refuses a PUT with
 * `If-Match: *` before `noEtags` could take the header off and pass it on,
 * `refuseMove` answers a MOVE before `garbleMove` could carry it out, and
 * `garbleMove.thenDown` drops a request ahead of every mode pushed after it.
 * The answer rewriters all run, in that order, on what Radicale said, after
 * the `after` hook, each on what the ones before it left: `noEtags` has
 * removed the ETag header before `etaglessPuts` could count it stripped or
 * `weakEtags` weaken it, and `uidConflictAs400` has turned a 409 into a 400
 * before `createdOnOverwrite` looks at the status.
 *
 * One rewrite is not a mode: a MOVE's `Destination` names the proxy, and
 * Radicale answers 502 to a destination on any host but its own (its
 * `move.py`), so it is pointed at Radicale, as a reverse proxy in front of a
 * real server leaves the host the server knows itself by.
 */
export async function startCalDavProxy(options: CalDavProxyOptions = {}): Promise<CalDavProxy> {
  const counts: CalDavProxyCounts = { strippedPuts: 0, corruptedReports: 0, starRefusals: 0, refusedMoves: 0 };
  let failedLookups = 0;
  /** Set by `garbleMove.thenDown` once the MOVE is through: every request after it is dropped. */
  let down = false;
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
      counts.starRefusals += 1;
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
  if (options.garbleMove?.thenDown) {
    requestRewriters.push(async () => (down ? DROPPED : null));
  }
  if (options.refuseMove !== undefined) {
    const { status, body } = options.refuseMove;
    requestRewriters.push(async (ex) => {
      if (ex.seen.method !== "MOVE") return null;
      counts.refusedMoves += 1;
      return { status, statusText: "Refused by the proxy", ...(body === undefined ? {} : { body }) };
    });
  }
  if (options.garbleMove !== undefined) {
    const { perform, answer, thenDown } = options.garbleMove;
    requestRewriters.push(async (ex) => {
      if (ex.seen.method !== "MOVE") return null;
      if (perform) {
        const moved = await fetch(ex.upstreamUrl, { method: "MOVE", headers: ex.headers, redirect: "manual" });
        await moved.arrayBuffer();
      }
      if (thenDown === true) down = true;
      if (answer === "drop") return DROPPED;
      return { status: answer, statusText: answer === 502 ? "Bad Gateway" : "Gateway Timeout", body: "<html>gateway</html>" };
    });
  }
  if (options.failSourceDelete !== undefined) {
    const collection = options.failSourceDelete.under;
    const status = options.failSourceDelete.status ?? 412;
    requestRewriters.push(async (ex) => {
      if (ex.seen.method !== "DELETE" || !ex.seen.path.startsWith(collection)) return null;
      return status === 412 ? PRECONDITION_FAILED : { status, statusText: "Refused by the proxy" };
    });
  }
  if (options.failTargetPut !== undefined) {
    const collection = options.failTargetPut.under;
    const status = options.failTargetPut.status ?? 403;
    requestRewriters.push(async (ex) => {
      if (ex.seen.method !== "PUT" || !ex.seen.path.startsWith(collection)) return null;
      return { status, statusText: "Refused by the proxy" };
    });
  }
  if (options.uidConflictAs400) {
    responseRewriters.push((ex, answer) => {
      if (ex.seen.method !== "PUT" || answer.status !== 409) return;
      answer.status = 400;
      answer.statusText = "Bad Request";
      answer.headers["content-type"] = "application/xml; charset=utf-8";
      answer.payload = Buffer.from(
        '<?xml version="1.0" encoding="utf-8"?>\n<d:error xmlns:d="DAV:" xmlns:s="http://sabredav.org/ns"><s:message>Calendar object with uid already exists in this calendar collection.</s:message></d:error>',
        "utf8"
      );
    });
  }
  if (options.etaglessPuts) {
    responseRewriters.push((ex, answer) => {
      if (ex.seen.method !== "PUT" || answer.headers.etag === undefined) return;
      counts.strippedPuts += 1;
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
  if (options.corrupt !== undefined) {
    const { name, data } = options.corrupt;
    responseRewriters.push((ex, answer) => {
      if (ex.seen.method !== "REPORT") return;
      const { xml, planted } = plantCorruptObject(answer.payload.toString("utf8"), name, data);
      if (!planted) return;
      counts.corruptedReports += 1;
      answer.payload = Buffer.from(xml, "utf8");
    });
  }
  if (options.principalAddresses !== undefined) {
    const hrefs = options.principalAddresses;
    responseRewriters.push((ex, answer) => {
      if (ex.seen.method !== "PROPFIND" || !ex.body?.toString("utf8").includes("calendar-user-address-set")) return;
      const xml = answer.payload.toString("utf8");
      const listed = xml.replace(
        /<((?:\w+:)?calendar-user-address-set)([^>]*)>([\s\S]*?)<\/\1>/,
        (_m, tag: string, attrs: string, inner: string) => {
          const hrefTag = /<((?:\w+:)?href)>/.exec(inner)?.[1] ?? "D:href";
          return `<${tag}${attrs}>${hrefs.map((h) => `<${hrefTag}>${h}</${hrefTag}>`).join("")}</${tag}>`;
        }
      );
      answer.payload = Buffer.from(listed, "utf8");
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
          if (short.drop === true) {
            res.socket?.destroy();
            return;
          }
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
    counts: () => ({ ...counts }),
    requests: () => [...log],
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
