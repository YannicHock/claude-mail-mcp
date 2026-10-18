/**
 * `move_event`'s move itself (#212, spec 2026-09-29 §2.6): the WebDAV MOVE,
 * what each of its answers means, and the copy-then-delete fallback for a
 * server that refuses it, with every way that can end half done. Moved out of
 * src/caldav-client.ts (#234), which still does the lookups and guards every
 * writer shares — the calendars, the stored event, its ETag, whom the server
 * may notify — and hands the move what they found.
 *
 * It reaches the server only through {@link MoveHost}: the client's plain
 * `fetch` with the account's credentials, its UID lookup, its guarded write
 * and its ETag read-back. Every request of its own goes through `davFetch`,
 * not tsdav (see {@link CalDavMove.copyThenDelete}).
 */

import type { DAVCalendar } from "tsdav";
import { changedSinceRead, DavWriteError, notFound, refuseLostRace, strongOrNone, unfoldedIcs, writeFailure } from "./caldav-etag.js";
import type { FoundObject, MovedEvent, WriteTarget } from "./caldav-types.js";
import { objectName } from "./caldav-url.js";
import { ToolRefusal } from "./tool-refusal.js";
import { classifyFailure } from "../shared/credential-failure.js";
import type { Logger } from "../shared/log.js";

/** What {@link CalDavMove} needs of the client: its requests, and where to log. */
export interface MoveHost {
  /** One request outside tsdav, with the account's credentials (`CalDavClient`'s `davFetch`). */
  davFetch(method: string, url: string, headers?: Record<string, string>, body?: string): Promise<Response>;
  /** The UID lookup, null for "not there" (`CalDavClient`'s `lookUp`). */
  lookUp(calendar: DAVCalendar, uid: string): Promise<FoundObject | null>;
  /** A write guarded by `ifMatch`, its answer read (`CalDavClient`'s `guardedWrite`). */
  guardedWrite(
    method: "PUT" | "DELETE",
    target: WriteTarget,
    ifMatch: string | undefined,
    write: (ifMatch: string | undefined) => Promise<Response>
  ): Promise<Response>;
  /** The ETag of an object just written, matched by URL alone; null when it could not be read back (`CalDavClient`'s `etagAfterWrite`). */
  etagAfterWrite(calendar: DAVCalendar, url: string, uid: string): Promise<string | null>;
  log: Logger;
  /** The account named in every line logged. */
  accountId: string | undefined;
}

/**
 * The statuses by which a server says it does not do MOVE between these two
 * collections, rather than anything about the event (spec §2.6): forbidden,
 * not allowed, not implemented. They say the MOVE was not carried out, so
 * the fallback may run. A 502 is one only as Radicale sends it
 * ({@link moveRefused}).
 */
const MOVE_REFUSED = new Set([403, 405, 501]);

/**
 * True for a MOVE answer that says, for certain, that nothing was moved and
 * the server will not move it: {@link MOVE_REFUSED}, or Radicale's `502` with
 * its "Remote destination not supported" — its answer to a destination on
 * another host, which is what a MOVE looks like to it when a reverse proxy in
 * front rewrites the host.
 *
 * Any other 502, and a 503 or 504, is not: a gateway in front of the server
 * (NPM on Hetzner) answers them when the server was slow or went away, and
 * the MOVE may well have been carried out behind it. Taken for a refusal,
 * the fallback's PUT then met the moved object in the target and the answer
 * said "Nothing was moved" about an event that had moved (review of PR
 * #231). Those go to {@link CalDavMove.whereItWent} instead.
 */
function moveRefused(status: number, body: string): boolean {
  return MOVE_REFUSED.has(status) || (status === 502 && /remote destination/i.test(body));
}

/**
 * What {@link CalDavMove}'s `readBackUnchanged` found at a URL: the status
 * of a read that failed, or whether the text is still what was written and
 * the strong ETag the read gave, if any.
 */
type ReadBack = { status: number; unchanged?: undefined; ifMatch?: undefined } | { status?: undefined; unchanged: boolean; ifMatch: string | undefined };

/** The MOVE of one stored object into another calendar, and every way it can end. */
export class CalDavMove {
  private readonly host: MoveHost;

  constructor(host: MoveHost) {
    this.host = host;
  }

  /**
   * The WebDAV MOVE of `from` to `destination` (RFC 4918 §9.9), with
   * `Overwrite: F`, so an object of the same name in the target is never
   * replaced, and what its answer means:
   *
   *   - **2xx:** moved.
   *   - **409, or `no-uid-conflict` in the body of any status:** the target
   *     holds the UID. Checked before the refusal statuses, so a 403 that
   *     names it is that refusal and not a reason to copy (review of PR
   *     #231).
   *   - **412:** the name is taken in the target, or the event changed.
   *   - **A definite refusal of MOVE itself ({@link moveRefused}):** nothing
   *     was moved, and {@link copyThenDelete} does it instead.
   *   - **Any other 5xx, or no answer at all:** nobody knows. A gateway's 502
   *     or 504 may come after the server carried the MOVE out, and a
   *     connection lost mid-request after it too, so {@link whereItWent}
   *     looks, and the answer says what it found.
   *   - **404:** the event went away since the lookup.
   *
   * Every refusal here ends in "Nothing was moved.", which is true of each.
   */
  async moveObject(
    from: WriteTarget,
    data: string,
    target: DAVCalendar,
    destination: string,
    ifMatch: string | undefined
  ): Promise<Pick<MovedEvent, "etag" | "via">> {
    let res: Response;
    try {
      res = await this.host.davFetch("MOVE", from.url, {
        destination,
        overwrite: "F",
        ...(ifMatch === undefined ? {} : { "if-match": ifMatch }),
      });
    } catch (err) {
      return this.whereItWent(from, target, destination, `the connection failed: ${classifyFailure(err).reason}`);
    }
    if (res.ok) {
      await res.arrayBuffer();
      return { via: "move", etag: res.headers.get("etag") ?? (await this.host.etagAfterWrite(target, destination, from.uid)) };
    }
    const body = await res.text();
    if (uidConflict(res.status, body)) throw uidTaken(from.uid, from.nothingDone);
    if (res.status === 412) {
      throw new ToolRefusal(
        `The target calendar already holds an object named ${objectName(destination)}, or the event changed after you read it. Call list_events on both calendars to see which. ${from.nothingDone}`
      );
    }
    if (moveRefused(res.status, body)) return this.copyThenDelete(from, data, target, destination, ifMatch);
    if (res.status >= 500) return this.whereItWent(from, target, destination, `the server answered ${res.status}`);
    refuseLostRace(res, from.uid, from.calendar.url, from.nothingDone);
    throw writeFailure(res, "MOVE");
  }

  /**
   * Where the event is after a MOVE whose answer said nothing certain
   * (`what`: a gateway's 5xx, or a connection lost): the UID looked up in
   * both calendars, and the answer made of what is there (review of PR
   * #231).
   *
   *   - **In the target only:** it moved; the answer is the move's.
   *   - **In the source only:** it did not; refused, "Nothing was moved.",
   *     to be tried again. Not the fallback: the server may still carry the
   *     MOVE out behind the gateway, and a copy made meanwhile would meet it.
   *   - **In both, or in neither:** refused, naming both URLs, and one `warn`
   *     line, since it needs a person.
   *   - **The lookups fail too:** refused, naming both URLs, saying it may
   *     have moved.
   */
  private async whereItWent(
    from: WriteTarget,
    target: DAVCalendar,
    destination: string,
    what: string
  ): Promise<Pick<MovedEvent, "etag" | "via">> {
    const unclear = `The server gave no clear answer to moving "${from.uid}" from ${from.url} to ${destination} (${what})`;
    let inSource: FoundObject | null;
    let inTarget: FoundObject | null;
    try {
      inSource = await this.host.lookUp(from.calendar, from.uid);
      inTarget = await this.host.lookUp(target, from.uid);
    } catch (err) {
      this.host.log("warn", "caldav: move_event could not tell where an event went", {
        account: this.host.accountId,
        source: from.url,
        target: destination,
      });
      throw new ToolRefusal(
        `${unclear}, and where the event is now could not be checked either (${classifyFailure(err).reason}). It may have moved: check the target calendar with list_events, then the source, before trying again.`
      );
    }
    if (inTarget !== null && inSource === null) {
      return { via: "move", etag: inTarget.url === destination ? inTarget.etag : null };
    }
    if (inSource !== null && inTarget === null) {
      throw new ToolRefusal(`${unclear}. The event is still in ${from.url} and not in the target calendar; try again in a moment. ${from.nothingDone}`);
    }
    this.host.log("warn", "caldav: move_event found an event in both calendars or in neither", {
      account: this.host.accountId,
      source: from.url,
      target: destination,
    });
    const found =
      inSource === null
        ? "it is now in neither calendar: it may have been deleted elsewhere meanwhile"
        : `it is now in both calendars, at ${inSource.url} and at ${inTarget?.url ?? destination}`;
    throw new ToolRefusal(`${unclear}, and ${found}. Call list_events on both calendars, and delete the one that should not be there.`);
  }

  /**
   * The fallback for a server that refuses MOVE (spec §2.6, step 4): PUT the
   * stored text to `copyUrl` in `target`, under the same file name, with
   * `If-None-Match: *`, so nothing there is ever replaced; then DELETE the
   * source through the client's `guardedWrite`, guarded by `ifMatch`.
   *
   * Every request here — the PUT, the checks and both DELETEs — goes through
   * the client's `davFetch`, not tsdav, as the MOVE does: tsdav resolves a file name
   * against a collection its own way, and the copy was put at one URL and
   * answered and removed at another (review of PR #231). One transport for
   * the whole move keeps them the same URL.
   *
   * Where nothing guards the DELETE — the stored ETag was weak, so `ifMatch`
   * is none, or the server keeps none, so it is `*` — the source is read
   * again first and compared with what was copied, as {@link removeCopy}
   * compares the copy: an edit made there since the lookup would otherwise
   * be deleted with the source, and exist nowhere (review of PR #231).
   *
   * What happens to the copy when the source cannot be deleted depends on
   * whether the source is certainly still there:
   *
   *   - **It is** — the DELETE was refused with a definite answer (412, 404,
   *     403 for a read-only calendar, any 4xx), or the check above failed:
   *     the copy is removed again ({@link removeCopy}), the refusal ends in
   *     "Nothing was moved.", and the event is where it was — or, after a
   *     404, nowhere, deleted elsewhere meanwhile.
   *   - **It may not be** — a 5xx, or no answer: the copy is left alone and
   *     the refusal names both URLs. An event in two calendars can be tidied
   *     up; one deleted by a guess cannot be brought back. So is a copy
   *     that cannot be removed. Both leave a `warn` line, since they are the
   *     outcomes of a move that need a person.
   */
  private async copyThenDelete(
    from: WriteTarget,
    data: string,
    target: DAVCalendar,
    copyUrl: string,
    ifMatch: string | undefined
  ): Promise<Pick<MovedEvent, "etag" | "via">> {
    const copyEtag = await this.putCopy(from, data, copyUrl);
    let guard = ifMatch;
    if (ifMatch === undefined || ifMatch === "*") {
      const check = await this.sourceUnchanged(from, data);
      if (check instanceof ToolRefusal) throw await this.rolledBack(from, data, copyUrl, copyEtag, check);
      guard = check.ifMatch ?? ifMatch;
    }
    try {
      await this.host.guardedWrite("DELETE", from, guard, (etag) =>
        this.host.davFetch("DELETE", from.url, etag === undefined ? {} : { "if-match": etag })
      );
    } catch (err) {
      if (err instanceof ToolRefusal) throw await this.rolledBack(from, data, copyUrl, copyEtag, err);
      if (err instanceof DavWriteError && err.status < 500) {
        const refusal = new ToolRefusal(
          `The event "${from.uid}" could not be removed from ${from.url}: the server answered ${err.status} to deleting it (the calendar may be read-only), so the copy put into the target calendar was removed again. ${from.nothingDone}`
        );
        throw await this.rolledBack(from, data, copyUrl, copyEtag, refusal);
      }
      throw this.inBothPlaces(from, copyUrl, `removing it from the source failed (${classifyFailure(err).reason}), so it may still be there`);
    }
    return { via: "copy-then-delete", etag: copyEtag ?? (await this.host.etagAfterWrite(target, copyUrl, from.uid)) };
  }

  /**
   * The fallback's PUT of `data` to `copyUrl`, with `If-None-Match: *`.
   * Returns the ETag it answered, or null. Every way it fails is a refusal:
   * the target holds the UID or the name, or it refused the copy outright —
   * 403 for a read-only calendar, 507 for a full one (review of PR #231).
   * Nothing has been deleted at that point, so each ends "Nothing was
   * moved." — except where a 5xx or a lost connection leaves a copy that may
   * have been written and cannot be removed, which names both URLs.
   */
  private async putCopy(from: WriteTarget, data: string, copyUrl: string): Promise<string | null> {
    const failed = (why: string): ToolRefusal =>
      new ToolRefusal(`The event "${from.uid}" could not be copied into the target calendar: ${why}. It is still in ${from.url}. ${from.nothingDone}`);
    let put: Response;
    try {
      put = await this.host.davFetch(
        "PUT",
        copyUrl,
        { "if-none-match": "*", "content-type": "text/calendar; charset=utf-8" },
        data
      );
    } catch (err) {
      throw await this.rolledBack(from, data, copyUrl, null, failed(`the connection failed (${classifyFailure(err).reason})`));
    }
    if (put.ok) {
      await put.arrayBuffer();
      return put.headers.get("etag");
    }
    const body = await put.text();
    if (uidConflict(put.status, body)) throw uidTaken(from.uid, from.nothingDone);
    if (put.status === 412) {
      throw new ToolRefusal(`The target calendar already holds an object named ${objectName(copyUrl)}. ${from.nothingDone}`);
    }
    const refusal = failed(`the server answered ${put.status} to PUT ${copyUrl}`);
    if (put.status < 500) throw refusal;
    // Behind a gateway, a 5xx may come after the copy was written.
    throw await this.rolledBack(from, data, copyUrl, null, refusal);
  }

  /**
   * Whether the source still holds exactly what was copied, for a DELETE no
   * strong ETag guards: read at `from.url` and compared after line endings
   * and folding. Returns the refusal to give when it does not — changed, gone,
   * or unreadable — and otherwise the strong ETag that read gave, if any, to
   * guard the DELETE with.
   */
  private async sourceUnchanged(from: WriteTarget, data: string): Promise<{ ifMatch: string | undefined } | ToolRefusal> {
    let read: ReadBack;
    try {
      read = await this.readBackUnchanged(from.url, data);
    } catch (err) {
      return new ToolRefusal(
        `The event "${from.uid}" could not be read back from ${from.url} to check that it was not changed since (${classifyFailure(err).reason}). ${from.nothingDone}`
      );
    }
    if (read.status === 404) return notFound(from.uid, from.calendar.url, from.nothingDone);
    if (read.status !== undefined) {
      return new ToolRefusal(
        `The event "${from.uid}" could not be read back from ${from.url} to check that it was not changed since (the server answered ${read.status}). ${from.nothingDone}`
      );
    }
    if (!read.unchanged) return changedSinceRead(from.uid, from.nothingDone);
    return { ifMatch: read.ifMatch };
  }

  /**
   * GET `url` and compare what it holds with `data`, after line endings and
   * folding and nothing else ({@link unfoldedIcs}): the check both
   * {@link sourceUnchanged} and {@link removeCopy} make before a DELETE no
   * strong ETag guards, which each wrote out in full until the code-health
   * review of the v0.7.4 milestone. Answers the status of a read that failed
   * (its body drained), or whether the text is unchanged and the strong ETag
   * the read gave, if any, to guard the DELETE with. A request that fails
   * outright throws, for the caller to word.
   */
  private async readBackUnchanged(url: string, data: string): Promise<ReadBack> {
    const now = await this.host.davFetch("GET", url);
    if (!now.ok) {
      await now.arrayBuffer();
      return { status: now.status };
    }
    const unchanged = unfoldedIcs(await now.text()) === unfoldedIcs(data);
    return { unchanged, ifMatch: strongOrNone(now.headers.get("etag")) };
  }

  /**
   * `refusal`, once the copy at `copyUrl` is removed again
   * ({@link removeCopy}); or, where it cannot be, the refusal that names
   * both URLs instead ({@link inBothPlaces}). Never throws itself: a removal
   * that fails outright leaves the copy, as one that is refused does.
   */
  private async rolledBack(
    from: WriteTarget,
    data: string,
    copyUrl: string,
    copyEtag: string | null,
    refusal: ToolRefusal
  ): Promise<ToolRefusal> {
    let kept: string | null;
    try {
      kept = await this.removeCopy(copyUrl, data, copyEtag);
    } catch (err) {
      kept = `removing the copy failed (${classifyFailure(err).reason})`;
    }
    return kept === null ? refusal : this.inBothPlaces(from, copyUrl, kept);
  }

  /** The refusal for a move that may have left the event in two calendars, and its `warn` line. */
  private inBothPlaces(from: WriteTarget, copyUrl: string, kept: string): ToolRefusal {
    this.host.log("warn", "caldav: move_event left an event in two calendars", {
      account: this.host.accountId,
      source: from.url,
      target: copyUrl,
    });
    return new ToolRefusal(
      `The event "${from.uid}" was copied to ${copyUrl} but not removed from ${from.url}, and the copy was left in place: ${kept}. It may now be in both calendars. Call list_events on both and delete the one that should not be there.`
    );
  }

  /**
   * Remove the copy {@link copyThenDelete} put at `url` — and only that copy.
   * Returns null once it is gone (a 404 included: it was never written, or
   * is gone already), or why it was left in place.
   *
   * With the strong ETag the PUT answered, the DELETE carries it as
   * `If-Match`, so an object changed since cannot be deleted. Without one
   * (Nextcloud answers a PUT without an ETag when it stores something else,
   * RFC 4791 §5.3.4), the object is read first and deleted only if its text
   * is still what was put — compared after line endings and folding, and
   * nothing else, so a server that rewrote it leaves it in place — and then
   * with the ETag that read gave, where it gave a strong one.
   */
  private async removeCopy(url: string, data: string, copyEtag: string | null): Promise<string | null> {
    let guard = strongOrNone(copyEtag);
    if (guard === undefined) {
      const read = await this.readBackUnchanged(url, data);
      if (read.status === 404) return null;
      if (read.status !== undefined) return `it could not be read back to check it (the server answered ${read.status})`;
      if (!read.unchanged) return "it changed after it was written";
      guard = read.ifMatch;
    }
    const res = await this.host.davFetch("DELETE", url, guard === undefined ? {} : { "if-match": guard });
    await res.arrayBuffer();
    if (res.ok || res.status === 404) return null;
    if (res.status === 412) return "it changed after it was written";
    return `the server answered ${res.status} to deleting it`;
  }
}

/** `move_event`'s refusal of a target that is the source. */
export function alreadyThere(nothingDone: string): ToolRefusal {
  return new ToolRefusal(
    `The event is already in that calendar: calendar_url and target_calendar_url name the same one, so there is nothing to do. ${nothingDone}`
  );
}

/**
 * True for a server's answer that the target calendar already holds the
 * UID: 409 (Radicale answers `<C:no-uid-conflict/>` with it, RFC 4791
 * §5.3.2.1), or that precondition named in the body of another status, as
 * a server may send it with 403. Sabre's `400 "already exists"` is not
 * recognisable here; `CalDavClient.moveEvent`'s search of the target is
 * what catches it.
 */
function uidConflict(status: number, body: string): boolean {
  return status === 409 || /no-uid-conflict/i.test(body);
}

/** The refusal of a move into a calendar that already holds `uid` — at `url`, where the search found it. */
export function uidTaken(uid: string, nothingDone: string, url?: string): ToolRefusal {
  const where = url === undefined ? "" : ` (${url})`;
  return new ToolRefusal(`The target calendar already has an event with UID "${uid}"${where}. ${nothingDone}`);
}
