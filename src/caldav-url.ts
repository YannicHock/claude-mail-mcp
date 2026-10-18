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
 *     this one fetch.
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
 * A `fetch` that checks the URL of every request with
 * {@link caldavUrlProblem} and refuses it, before sending anything, when the
 * credentials must not go there. `base` is the fetch it hands the rest to:
 * the platform's, looked up at call time, unless a test passes its own.
 *
 * Redirects `fetch` follows by itself need no check of their own: it drops
 * `Authorization` on a redirect to another origin, and a same-origin redirect
 * cannot change the scheme. tsdav's discovery reads its redirect with
 * `redirect: "manual"` and requests the target itself, through here.
 */
export function guardedCaldavFetch(base?: typeof fetch, deps: MailTlsDeps = defaultDeps): typeof fetch {
  return async (input, init) => {
    const href = input instanceof Request ? input.url : String(input);
    const problem = await caldavUrlProblem(href, deps);
    if (problem !== null) {
      let origin = href;
      try {
        origin = new URL(href).origin;
      } catch {
        // Not a URL: caldavUrlProblem passed it, so this is unreachable in practice.
      }
      throw new Error(`The CalDAV request to ${origin} was not made, and no password was sent: ${problem}`);
    }
    return (base ?? globalThis.fetch)(input, init);
  };
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
