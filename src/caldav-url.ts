/**
 * The URL arithmetic of CalDAV collections and the objects in them, with no
 * server behind it: which two calendar URLs are one collection, and where an
 * object of a given file name lives in one. Moved out of
 * src/caldav-client.ts (code-health review of PR #231), where `move_event`
 * (#212) had grown them, so they can be tested on their own.
 *
 * ## Which CalDAV URLs may be used with the credentials (#247)
 *
 * Every CalDAV request carries the account's Basic credentials, so a request
 * to an `http://` URL sends them in cleartext. The owner's decision (spec
 * 2026-10-18 §2.14, A) is #220's rule: {@link caldavUrlProblem} allows
 * `https://` always, and `http://` only to a host `localMailAddress`
 * (src/mail-tls.ts) calls local — an allow-listed address literal, or a
 * local-form name that resolves only to local addresses. A name written with
 * a trailing dot is refused over `http://`: it is resolved without the search
 * domain the check would have used. A lookup that fails is reported as such,
 * with its own message, rather than as a public host.
 *
 * It is applied at three points:
 *
 *   - **Saving** (src/settings-routes.ts): the configured URL, before the
 *     connection test, which would itself send the credentials.
 *   - **Every calendar tool call** (src/tools-calendar.ts): the configured
 *     URL again, for an accounts.json that already holds one — it still loads
 *     (#155), is warned about (src/app.ts), and its calendar tools are refused
 *     before any request. Checked per call, not at load, so a name that did
 *     not resolve while its server was down is not refused once it is back.
 *   - **Every request** ({@link guardedCaldavFetch}): the URL each request
 *     actually goes to. A server configured as `https://` can still send the
 *     client to `http://` — a `/.well-known/caldav` redirect with an explicit
 *     scheme (a Nextcloud behind a TLS proxy), or an absolute `http://` href
 *     in a PROPFIND answer — and tsdav follows both with the credentials. The
 *     CalDAV client, its own requests and the connection test all go through
 *     this one fetch. A link to `http://` on the host of the configured
 *     `https://` URL itself is not refused but sent over `https://` (see
 *     {@link guardedCaldavFetch}), so such a Nextcloud keeps working.
 *
 * What it does not do is pin the connection to the address it checked, as
 * #220 does for IMAP and SMTP: `fetch` resolves the name again, so a resolver
 * that answers the check privately and the connection publicly, for a name of
 * local form, still gets the credentials. See docs/HARDENING.md.
 */

import { localMailAddress, type MailTlsDeps } from "./mail-tls.js";
import { resolveAddresses } from "./net-address.js";

const defaultDeps: MailTlsDeps = { resolveAddresses };

/** Refusal text for an `http://` CalDAV URL whose host is not local. */
export const CALDAV_HTTP_MESSAGE =
  "This CalDAV URL is not https:// and its host is not local, so the CalDAV password would cross " +
  "the network unencrypted. Use the server's https:// URL; http:// is only accepted for a " +
  "loopback or private host, such as a Radicale on the same machine.";

/** Refusal text for an `http://` CalDAV URL whose local-form name did not resolve. */
export const CALDAV_UNRESOLVED_MESSAGE =
  "This CalDAV URL is http:// and its host could not be resolved to a local address just now, so " +
  "it was not used: http:// is only accepted for a loopback or private host. Check that the " +
  "CalDAV server is running and its name resolves, or use the server's https:// URL.";

/**
 * Why the account's credentials must not be sent to `url`, or `null` when
 * they may: see the module header. Never rejects. A string that is no URL at
 * all is not this check's to judge, and is `null`.
 */
export async function caldavUrlProblem(url: string, deps: MailTlsDeps = defaultDeps): Promise<string | null> {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  if (parsed.protocol === "https:") return null;
  if (parsed.protocol !== "http:" || parsed.hostname.endsWith(".")) return CALDAV_HTTP_MESSAGE;
  let unresolved = false;
  const watched: MailTlsDeps = {
    async resolveAddresses(hostname) {
      try {
        const addresses = await deps.resolveAddresses(hostname);
        if (addresses.length === 0) unresolved = true;
        return addresses;
      } catch (err) {
        unresolved = true;
        throw err;
      }
    },
  };
  if ((await localMailAddress(parsed.hostname, watched)) !== null) return null;
  return unresolved ? CALDAV_UNRESOLVED_MESSAGE : CALDAV_HTTP_MESSAGE;
}

/**
 * The host of the account's configured CalDAV URL, lower case and without a
 * trailing dot, when that URL is `https://`; `null` otherwise — an `http://`
 * configured URL upgrades nothing.
 */
function httpsHost(configuredUrl: string | undefined): string | null {
  if (configuredUrl === undefined) return null;
  try {
    const parsed = new URL(configuredUrl.trim());
    return parsed.protocol === "https:" ? bareHost(parsed.hostname) : null;
  } catch {
    return null;
  }
}

function bareHost(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/, "");
}

/**
 * `url` sent over `https://` instead, when it is `http://` on `host` (from
 * {@link httpsHost}) with no port or port 80; `null` when it is anything else.
 * Only the scheme changes, so the port becomes https's default.
 */
function sameHostHttps(url: URL, host: string | null): URL | null {
  if (host === null || url.protocol !== "http:" || url.port !== "" || bareHost(url.hostname) !== host) return null;
  const upgraded = new URL(url.href);
  upgraded.protocol = "https:";
  return upgraded;
}

/**
 * `url` in its `https://` form when it is an `http://` URL on the host of the
 * account's `https://` configured URL — no port, or port 80 — and `url`
 * unchanged otherwise, a string that is no URL included: the URL the guard
 * sends such a request to. `CalDavClient.findCalendar` compares by it, so a
 * `calendar_url` in either form names the one calendar.
 */
export function upgradedCaldavUrl(url: string, configuredUrl: string): string {
  try {
    return sameHostHttps(new URL(url.trim()), httpsHost(configuredUrl))?.href ?? url;
  } catch {
    return url;
  }
}

/** What {@link guardedCaldavFetch} needs to send same-host `http://` links over `https://`. */
export interface SameHostUpgrade {
  /** The account's configured CalDAV URL. Only an `https://` one upgrades anything. */
  configuredUrl: string;
  /**
   * Called once per guard — once per account's client — the first time a link
   * to `http://` on the configured host is sent or handed on as `https://`,
   * with that host, so the operator can be told the server needs fixing.
   */
  onUpgrade?: (host: string) => void;
}

/**
 * A `fetch` that checks the URL of every request with
 * {@link caldavUrlProblem} and refuses it, before sending anything, when the
 * credentials must not go there. `base` is the fetch it hands the rest to:
 * the platform's, looked up at call time, unless a test passes its own.
 *
 * Redirects `fetch` follows by itself need no check of their own: it drops
 * `Authorization` on a redirect to another origin, and a same-origin redirect
 * cannot change the scheme. tsdav's discovery reads its redirect with
 * `redirect: "manual"` and requests the target itself, through here.
 *
 * ## A Nextcloud behind a TLS proxy (#247 follow-up)
 *
 * With `upgrade`, a server configured as `https://` that speaks of `http://`
 * links on its own host — a Nextcloud behind a TLS-terminating proxy, which
 * believes it runs on http:// — keeps working instead of being refused:
 *
 *   - **A request** to `http://` on the configured host (compared case-
 *     insensitively, a trailing dot ignored), with no port or port 80, is
 *     sent to `https://` on the same host and https's default port. Never
 *     another host, never another port, never a downgrade.
 *   - **An answer** from `https://` on the configured host has those links
 *     rewritten to their `https://` form before tsdav reads it: the
 *     `Location` of a redirect, and the text of every DAV `href` element.
 *     Nothing else in the body is touched — `calendar-data`, the user's own
 *     event, least of all. tsdav resolves later hrefs against the URLs it
 *     holds and compares some as strings (`urlMatches` in its `fetchHomeUrl`,
 *     and `everyObjectIn` in src/caldav-client.ts), so the configured
 *     `https://` root mixed with the server's `http://` links would fail
 *     discovery; rewritten, tsdav holds `https://` URLs only, and the
 *     calendar URLs Claude is shown are the ones requests go to.
 *
 * The first of either is reported through `upgrade.onUpgrade`, once.
 */
export function guardedCaldavFetch(
  base?: typeof fetch,
  deps: MailTlsDeps = defaultDeps,
  upgrade?: SameHostUpgrade
): typeof fetch {
  const host = httpsHost(upgrade?.configuredUrl);
  let reported = false;
  const report = (): void => {
    if (reported || host === null) return;
    reported = true;
    upgrade?.onUpgrade?.(host);
  };
  return async (input, init) => {
    const href = input instanceof Request ? input.url : String(input);
    let target: URL | null = null;
    try {
      target = new URL(href);
    } catch {
      // Not a URL: caldavUrlProblem passes it on, as before.
    }
    const upgraded = target === null ? null : sameHostHttps(target, host);
    if (upgraded !== null) {
      report();
      target = upgraded;
      input = input instanceof Request ? new Request(upgraded.href, input) : upgraded.href;
    } else {
      const problem = await caldavUrlProblem(href, deps);
      if (problem !== null) {
        throw new Error(`The CalDAV request to ${target?.origin ?? href} was not made, and no password was sent: ${problem}`);
      }
    }
    const response = await (base ?? globalThis.fetch)(input, init);
    if (target === null || target.protocol !== "https:" || host === null || bareHost(target.hostname) !== host) {
      return response;
    }
    return httpsLinks(response, host, report);
  };
}

/**
 * `response` with its links to `http://` on `host` — no port or port 80 —
 * given in their `https://` form: the `Location` of a redirect, and the text
 * of every DAV `href` element of an XML answer. The response itself when it
 * has neither. See {@link guardedCaldavFetch}.
 */
async function httpsLinks(response: Response, host: string, report: () => void): Promise<Response> {
  const location = response.headers.get("location");
  const newLocation = location === null ? null : rewriteLocation(location, host);
  const isXml = response.headers.get("content-type")?.toLowerCase().includes("xml") ?? false;
  if (newLocation === null && (!isXml || response.body === null)) return response;
  const body = response.body === null ? null : await response.text();
  const newBody = body === null || !isXml ? null : rewriteHrefs(body, host);
  if (newLocation !== null || newBody !== null) report();
  const headers = new Headers(response.headers);
  if (newLocation !== null) headers.set("location", newLocation);
  // The body is decoded text now, and perhaps of another length.
  headers.delete("content-length");
  headers.delete("content-encoding");
  const rewritten = new Response(newBody ?? body, { status: response.status, statusText: response.statusText, headers });
  // tsdav reports `response.url` as the href of an answer it cannot parse.
  Object.defineProperty(rewritten, "url", { value: response.url });
  return rewritten;
}

/** `location` in its `https://` form when it is `http://` on `host`; `null` when it is not. */
function rewriteLocation(location: string, host: string): string | null {
  try {
    return sameHostHttps(new URL(location), host)?.href ?? null;
  } catch {
    return null;
  }
}

/**
 * `xml` with the text of every DAV `href` element that is an `http://` URL on
 * `host`, with no port or port 80, in its `https://` form; `null` when there
 * is none. An element named `href` with any namespace prefix or none — the
 * prefix is the server's choice — and only its text: an escaped
 * `&lt;href&gt;` inside `calendar-data` is no element.
 */
function rewriteHrefs(xml: string, host: string): string | null {
  const name = host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(<(?:[A-Za-z_][\\w.-]*:)?href(?:\\s[^>]*)?>\\s*)http://${name}\\.?(?::80)?(?=[/?#<\\s])`, "gi");
  let changed = false;
  const out = xml.replace(pattern, (_match, open: string) => {
    changed = true;
    return `${open}https://${host}`;
  });
  return changed ? out : null;
}

/** True when two calendar URLs name one collection: equal but for trailing slashes. */
export function sameCollection(a: string, b: string): boolean {
  return a.replace(/\/+$/, "") === b.replace(/\/+$/, "");
}

/** `url` with one trailing slash, so a file name resolved against it lands inside the collection. */
export function withSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

/** The last path segment of an object's URL, as the server encoded it: the file name a move keeps. */
export function objectName(url: string): string {
  return new URL(url).pathname.replace(/\/+$/, "").split("/").pop() ?? "";
}

/**
 * The URL of the object called `name` — a path segment as {@link objectName}
 * gives it — inside the collection at `collection`, with or without its
 * trailing slash.
 *
 * The name is resolved as `./name`: on its own, `new URL("event:1.ics",
 * base)` is the absolute URL `event:1.ics`, scheme `event:`, and a MOVE's
 * Destination or the fallback's PUT went there instead of into the
 * calendar (review of PR #231). It is not encoded again: a segment from
 * {@link objectName} already is, and `%20` must stay `%20`.
 */
export function objectUrl(collection: string, name: string): string {
  return new URL(`./${name}`, withSlash(collection)).href;
}
