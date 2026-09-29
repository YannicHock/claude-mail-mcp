/**
 * What a CalDAV write's guards are made of, with no server behind them: the
 * If-Match a write sends (spec 2026-09-28 §4.1, 2026-09-29 §2.8, #210), how
 * an ETag is compared, what a server's answer to a guarded write means, and
 * the refusals those answers become. Moved out of src/caldav-client.ts
 * (code-health review of PR #231), which calls them from every writer, so
 * that the client holds the requests and this file the rules.
 */

import type { EventTarget } from "./caldav-client.js";
import { ToolRefusal } from "./tool-refusal.js";

/** An ETag's opaque part: without `W/` and without its quotes, so `abc`, `"abc"` and `W/"abc"` compare equal. */
export function opaqueTag(etag: string): string {
  return etag.trim().replace(/^W\//i, "").replace(/^"(.*)"$/, "$1");
}

/** True for a weak ETag, `W/"…"`, which `If-Match`'s strong comparison can never match (RFC 7232 §3.1). */
export function isWeak(etag: string): boolean {
  return /^W\//i.test(etag.trim());
}

/** How {@link requireEtag} treats a caller's ETag that does not match the stored one. */
export interface RequireEtagOptions {
  /**
   * Refuse any mismatch here, before anything is sent, instead of sending a
   * strong one on for the server's 412. For a write the server does not
   * guard: `move_event`, since Radicale ignores `If-Match` on MOVE (R11).
   */
  strict?: boolean;
}

/**
 * The If-Match value for a write, per spec 2026-09-28 §4.1 and 2026-09-29
 * §2.8 (#210), or undefined to send none. The lookup has just read the
 * stored object and its ETag, so the caller's value is checked against that:
 *
 *   - **Quotes (#210.2).** A model that passes `abc` for `"abc"` means the
 *     same ETag; the stored form is sent, instead of a 412 every time.
 *   - **A weak stored ETag (#210.3)** can never satisfy `If-Match`, so every
 *     write would loop on 412. The caller's value is compared with it here,
 *     ignoring `W/` and quotes: a mismatch is refused as a change made since,
 *     before anything is written; a match is written with no `If-Match`. That
 *     keeps what #152 guards against — a change between `list_events` and the
 *     write — and gives up only the moment between this lookup and the PUT.
 *   - **No stored ETag (#210.1):** `*`, "only if it still exists", so a write
 *     cannot recreate an event deleted since. The client's `guardedWrite`
 *     copes with a server that gets `*` wrong.
 *   - **No caller ETag** for an object that has one is refused: writing blind
 *     over it is the overwrite #152 exists to prevent.
 *
 * A strong value that does not match is sent as it is, and the server's 412
 * says so — unless `options.strict`, for a server that would not.
 */
export function requireEtag(
  target: EventTarget,
  stored: { etag: string | null },
  nothingDone = "Nothing was written.",
  options: RequireEtagOptions = {}
): string | undefined {
  if (target.etag === undefined) {
    if (stored.etag === null) return "*";
    throw new ToolRefusal(
      `Pass the etag list_events returned for "${target.uid}", so a change made elsewhere since you read it is not overwritten. ${nothingDone}`
    );
  }
  if (stored.etag === null) return target.etag;
  const same = opaqueTag(target.etag) === opaqueTag(stored.etag);
  if (!same && (options.strict === true || isWeak(stored.etag))) throw changedSinceRead(target.uid, nothingDone);
  if (isWeak(stored.etag)) return undefined;
  return same ? stored.etag : target.etag;
}

export function changedSinceRead(uid: string, nothingDone: string): ToolRefusal {
  return new ToolRefusal(
    `The event "${uid}" changed after you read it. ${nothingDone} Call list_events again for its current state and etag, then retry.`
  );
}

export function notFound(uid: string, calendarUrl: string, nothingDone: string): ToolRefusal {
  return new ToolRefusal(`No event with UID "${uid}" in calendar ${calendarUrl}. ${nothingDone}`);
}

/**
 * 412 and 404 on a guarded write are answers about the event, not server
 * failures: someone else changed it, or it went away, since it was read.
 */
export function refuseLostRace(res: Response, uid: string, calendarUrl: string, nothingDone: string): void {
  if (res.status === 412) throw changedSinceRead(uid, nothingDone);
  if (res.status === 404) throw notFound(uid, calendarUrl, nothingDone);
}

/**
 * A write the server answered with something other than 2xx: a server
 * failure, which goes through `reportingFailures()`. It keeps the status, so
 * a caller that has to know what the server said — `move_event`'s fallback,
 * telling a read-only source from one that may be gone (review of PR #231)
 * — does not read it back out of the message.
 */
export class DavWriteError extends Error {
  readonly status: number;

  constructor(res: Response, method: string) {
    super(`CalDAV server answered ${res.status} ${res.statusText}`.trim() + ` to ${method}`);
    this.status = res.status;
  }
}

/**
 * tsdav returns the raw Response for every write and throws on none of them,
 * which is how `create_event` came to report success for a 403 (spec §0).
 * Any other non-2xx is a {@link DavWriteError}: `throw writeFailure(res, …)`
 * where the answer is already known to be one, so the compiler sees the
 * branch end.
 */
export function assertWritten(res: Response, method: string): void {
  if (!res.ok) throw writeFailure(res, method);
}

/** The {@link DavWriteError} for `res`, to throw. */
export function writeFailure(res: Response, method: string): DavWriteError {
  return new DavWriteError(res, method);
}

/**
 * iCalendar text with CRLF made LF and folded lines joined (RFC 5545
 * §3.1): two texts equal under it are the same object, however each was
 * sent. What `move_event` compares where no strong ETag can guard a
 * DELETE: the copy it put, and the source it is about to remove.
 */
export function unfoldedIcs(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/\n[ \t]/g, "").trimEnd();
}
