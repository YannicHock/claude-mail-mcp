/**
 * CalDAV client wrapper around tsdav + ical.js.
 *
 * Discovers calendars on demand, lists events in a window, creates new
 * events, and computes free slots between existing busy intervals.
 *
 * v0.1 trade-off: we discover calendars on each call rather than caching,
 * because tsdav's discovery is cheap (one PROPFIND) and stale caches are
 * worse than a small extra request. v0.2 will introduce a short TTL cache.
 *
 * v0.7.4 (spec 2026-09-29 §2.2): recurrence is expanded here, not on the
 * server — `listEvents` asks for every object with an occurrence in the
 * window and src/ical-expand.ts turns each into instances. Every object the
 * server lists is read, whatever its href is called (#211.1), and one that
 * cannot be read is named in `skipped` instead of failing the calendar
 * (#211.2). The expansion itself runs off this thread, in
 * src/ical-worker-pool.ts, where a rule that never ends can be stopped.
 *
 * Nothing else here walks a recurrence rule: the UID lookup and the writes
 * (src/ical-edit.ts) only ask whether an object recurs. Anything that needs
 * an occurrence found by walking — addressing one by `recurrence_id` — goes
 * through the same pool (src/ical-worker-ops.ts).
 */

import {
  createDAVClient,
  DAVCalendar,
  DAVCalendarObject,
} from "tsdav";
import { randomUUID } from "node:crypto";
import { buildIcs, builtZoneName, type NewEventFields } from "./ical-build.js";
import {
  applyEventPatch,
  changesSomething,
  describeSeries,
  touchesTime,
  writtenBy,
  type EventPatch,
  type WriteMark,
} from "./ical-edit.js";
import { instantOfReported, type CalendarEvent, type StoredObject } from "./ical-expand.js";
import { parseCalendar, seriesFor, type ParsedCalendar } from "./ical-parse.js";
import { expansionPool } from "./ical-worker-pool.js";
import { calendarZone, canonicalZone } from "./ical-zones.js";
import { ToolRefusal } from "./tool-refusal.js";
import { classifyFailure } from "../shared/credential-failure.js";
import type { Logger } from "../shared/log.js";

// createDAVClient returns a logged-in client whose type omits the login
// methods. Capture that shape for our field types.
type AuthedDAVClient = Awaited<ReturnType<typeof createDAVClient>>;

export interface CalDavAuth {
  url: string;
  user: string;
  pass: string;
}

export interface CalendarSummary {
  url: string;
  displayName: string;
  description: string | null;
  ctag: string | null;
  timezone: string | null;
  components: string[];
}

/** An object `listEvents` could not list, and why (#211.2). */
export interface SkippedObject {
  url: string;
  reason: string;
}

export interface EventListing {
  events: CalendarEvent[];
  /** Empty when every object in the window was read. */
  skipped: SkippedObject[];
}

export interface NewEventInput extends NewEventFields {
  calendarUrl: string;
  /**
   * The IANA zone to write the event in (spec 2026-09-29 §2.5). Omitted, it is
   * the calendar's own zone when the server reports one, and UTC otherwise.
   */
  timezone?: string;
}

/** What `create_event` answers: where the event went, and the zone it was written in. */
export interface CreatedEvent {
  url: string;
  uid: string;
  /** The IANA zone, `"UTC"`, or `"floating"` for an all-day event — as `list_events` reports it. */
  timezone: string;
}

/** Which event a write is aimed at, and the guards spec §4 puts on it. */
export interface EventTarget {
  calendarUrl: string;
  uid: string;
  /** From `list_events`. Sent as If-Match; see spec §4.1 for when it may be omitted. */
  etag?: string;
  /** Present only to be refused: single occurrences are out of scope (spec §4.3). */
  recurrenceId?: string;
  /** Required to touch a recurring event at all. */
  applyToSeries?: boolean;
}

export interface EventUpdate extends EventTarget, EventPatch {}

/**
 * Where a guarded write goes, and what its refusals end with: the one
 * argument {@link CalDavClient}'s `guardedWrite` takes about the event, in
 * place of the five it took one by one (code-health review of PR 3).
 * `move_event` (#212) passes the source's.
 */
export interface WriteTarget {
  calendar: DAVCalendar;
  uid: string;
  /** The object's URL, as the lookup found it. */
  url: string;
  /** "Nothing was changed." and the like: what a refusal says was not done. */
  nothingDone: string;
}

/** A stored object the UID lookup found, with the one parse of it every write reuses. */
interface FoundObject extends StoredObject {
  parsed: ParsedCalendar;
}

export interface FreeSlot {
  start: string;
  end: string;
}

/** What a {@link CalDavClient} reports through, beside its answers (#210.4). */
export interface CalDavClientOptions {
  /**
   * The tool layer's logger, from `ClientPool` (src/client-pool.ts). It is
   * given the few things that go wrong without failing the call — today, an
   * ETag the connector could not read back after a write. Defaults to a no-op.
   */
  log?: Logger;
  /** The account these calls are for, named in every line logged. */
  accountId?: string;
}

export class CalDavClient {
  private client: AuthedDAVClient | null = null;
  private connecting: Promise<AuthedDAVClient> | null = null;
  private readonly auth: CalDavAuth;
  private readonly log: Logger;
  private readonly accountId: string | undefined;

  constructor(auth: CalDavAuth, options: CalDavClientOptions = {}) {
    this.auth = auth;
    this.log = options.log ?? (() => {});
    this.accountId = options.accountId;
  }

  private async ensureClient(): Promise<AuthedDAVClient> {
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;
    this.connecting = (async (): Promise<AuthedDAVClient> => {
      const client = await createDAVClient({
        serverUrl: this.auth.url,
        credentials: {
          username: this.auth.user,
          password: this.auth.pass,
        },
        authMethod: "Basic",
        defaultAccountType: "caldav",
      });
      this.client = client;
      this.connecting = null;
      return client;
    })();
    return this.connecting;
  }

  async listCalendars(): Promise<CalendarSummary[]> {
    const client = await this.ensureClient();
    const calendars: DAVCalendar[] = await client.fetchCalendars();
    return calendars.map((cal) => ({
      url: cal.url,
      displayName:
        typeof cal.displayName === "string"
          ? cal.displayName
          : (cal.url.split("/").filter(Boolean).pop() ?? cal.url),
      description: (cal as { description?: string }).description ?? null,
      ctag: cal.ctag ?? null,
      timezone: typeof cal.timezone === "string" ? cal.timezone : null,
      components: Array.isArray(cal.components)
        ? cal.components.map(String)
        : [],
    }));
  }

  /**
   * Every instance in the window, expanded in the connector (spec §2.2).
   *
   * The query is a `calendar-query` with a `time-range` and no `expand`: the
   * server only picks the objects with an occurrence in the window, which it
   * does for every shape (R4), and returns them as stored. Asking it to
   * expand as well failed the whole REPORT on an all-day series, a floating
   * series or an override with no master (R1–R3).
   *
   * The expansion runs in src/ical-worker-pool.ts's workers, each object
   * under a deadline: one recurrence rule ical.js never returns from is a
   * `skipped` entry, not a connector that no longer answers anyone (review of
   * #223). `find_free_slot` reads through here, so it is covered too.
   */
  async listEvents(calendarUrl: string, rangeStart: string, rangeEnd: string): Promise<EventListing> {
    const calendar = await this.findCalendar(calendarUrl);
    const client = await this.ensureClient();
    const objects: DAVCalendarObject[] = await client.fetchCalendarObjects({
      calendar,
      timeRange: {
        start: rangeStart,
        end: rangeEnd,
      },
      urlFilter: everyObjectIn(calendar),
    });
    const window = { start: Date.parse(rangeStart), end: Date.parse(rangeEnd) };
    const events: CalendarEvent[] = [];
    const skipped: SkippedObject[] = [];
    const stored: StoredObject[] = [];
    for (const obj of objects) {
      if (typeof obj.data !== "string" || obj.data === "") {
        skipped.push({ url: obj.url, reason: "The server sent no calendar data for it." });
        continue;
      }
      stored.push({ url: obj.url, etag: obj.etag ?? null, data: obj.data });
    }
    // Off this thread, each object under a deadline: see src/ical-worker-pool.ts.
    const expanded = await expansionPool.expand(stored, window);
    expanded.forEach((result, i) => {
      events.push(...result.instances);
      if (result.skipped !== undefined) skipped.push({ url: stored[i].url, reason: result.skipped });
    });
    events.sort((a, b) => instantOfReported(a.start) - instantOfReported(b.start));
    return { events, skipped };
  }

  /**
   * Write a new event. Its zone (spec 2026-09-29 §2.5) is `input.timezone`
   * when given — refused, before the server is contacted, unless it is an
   * IANA name — else the calendar's own `calendar-timezone`, so an event
   * Claude creates behaves like one made in the server's web UI, else UTC as
   * before v0.7.4. The answer says which zone it was.
   */
  async createEvent(input: NewEventInput): Promise<CreatedEvent> {
    const nothingDone = "Nothing was created.";
    let zone: string | null = null;
    if (input.timezone !== undefined) {
      zone = canonicalZone(input.timezone);
      if (zone === null) {
        throw new ToolRefusal(
          `"${input.timezone}" is not an IANA time zone. Pass a name like Europe/Berlin or America/New_York, or omit timezone to use the calendar's own. ${nothingDone}`
        );
      }
    }
    const calendar = await this.findCalendar(input.calendarUrl);
    zone ??= calendarZone(calendar.timezone) ?? "UTC";
    const client = await this.ensureClient();
    const uid = `${randomUUID()}@claude-mail-mcp`;
    const ics = buildIcs({ ...input, uid }, zone, nothingDone);
    const filename = `${uid}.ics`;
    const res = await client.createCalendarObject({
      calendar,
      filename,
      iCalString: ics,
    });
    assertWritten(res, "PUT");
    const base = calendar.url.endsWith("/") ? calendar.url : `${calendar.url}/`;
    return { url: `${base}${filename}`, uid, timezone: builtZoneName(ics) };
  }

  /**
   * Change an existing event in place (#152). Spec §4: the caller's ETag guards
   * the write, a series needs `applyToSeries`, and everything the patch does
   * not name survives — see src/ical-edit.ts.
   */
  async updateEvent(update: EventUpdate): Promise<{ uid: string; url: string; etag: string | null }> {
    const nothingDone = "Nothing was changed, and no event was created.";
    if (update.recurrenceId !== undefined) {
      throw new ToolRefusal(
        "Changing a single occurrence of a recurring event is not supported yet: it needs an override (RECURRENCE-ID) this connector does not write. Nothing was changed. To change every occurrence, omit recurrence_id and pass apply_to_series: true."
      );
    }
    if (!changesSomething(update)) {
      throw new ToolRefusal(
        "Nothing to change: pass at least one of summary, description, location, start, end or all_day."
      );
    }
    const calendar = await this.findCalendar(update.calendarUrl);
    const stored = await this.findStoredEvent(calendar, update.uid, nothingDone);
    const shape = describeSeries(seriesFor(stored.parsed.vcal, update.uid));
    if (shape.overrideOnly) {
      // #211.3: there is no master to patch, so without this the patch threw a
      // plain Error — logged as a server failure — or, without
      // apply_to_series, the call was told this is a series it can change.
      throw new ToolRefusal(
        `"${update.uid}" is a single occurrence of a series whose other occurrences are not in this calendar (an invitation to one instance, for example), and changing such an occurrence is not supported yet. Nothing was changed.`
      );
    }
    if (shape.recurring) {
      if (update.applyToSeries !== true) throw seriesRefusal(update.uid, "change");
      if (touchesTime(update)) {
        throw new ToolRefusal(
          `"${update.uid}" is a recurring series, and changing the time of a whole series is not supported yet. Nothing was changed. Its summary, description and location can be changed with apply_to_series: true.`
        );
      }
    }
    const ifMatch = requireEtag(update, stored, nothingDone);
    const edit = applyEventPatch(stored.parsed, update.uid, update, nothingDone);
    const etag = await this.putEdit({ calendar, uid: update.uid, url: stored.url, nothingDone }, ifMatch, edit);
    return { uid: update.uid, url: stored.url, etag };
  }

  /**
   * PUT an edit of a stored object through {@link guardedWrite}, and return
   * the new ETag: the server's answer's, or read back through
   * {@link etagAfterWrite} when it gave none.
   */
  private async putEdit(target: WriteTarget, ifMatch: string | undefined, edit: { ics: string; mark: WriteMark }): Promise<string | null> {
    const client = await this.ensureClient();
    const res = await this.guardedWrite("PUT", target, ifMatch, (etag) =>
      client.updateCalendarObject({
        calendarObject: { url: target.url, data: edit.ics, ...(etag === undefined ? {} : { etag }) },
      })
    );
    return res.headers.get("etag") ?? (await this.etagAfterWrite(target.calendar, target.url, edit.mark));
  }

  /**
   * The ETag of an object just written, read back with the same UID query the
   * write started from. RFC 4791 §5.3.4 lets a server answer a PUT without an
   * ETag when it stored something other than what was sent, and Nextcloud does
   * exactly that for an event it schedules — found on the v0.7.2 acceptance
   * run, where `update_event` answered `etag: null` and a second change needed
   * a `list_events` in between.
   *
   * The write has already succeeded, so this never turns it into a failure:
   * anything going wrong here is `null`, and the tool text tells the caller to
   * read the event again in that case.
   *
   * An ETag is handed back only for what is recognisably this write: the same
   * object URL, and the SEQUENCE this update just wrote on the VEVENT it
   * changed (`mark`, see `writtenBy` in src/ical-edit.ts). Otherwise someone
   * else's version landed in between (a phone syncing, a server applying an
   * attendee's reply that bumps it), and giving the caller *that* etag would
   * let its next update overwrite the other change unseen — `null` sends it to
   * `list_events` instead.
   *
   * A read-back that fails outright leaves one `info` line with the account
   * and the reason (#210.4) — not `warn`, since the call succeeded, but not
   * nothing either: a server where it always fails would otherwise look like
   * the old `etag: null` with no trace in the log. The reason is
   * `classifyFailure`'s bounded reading of the message, never the error
   * object, which can carry the connection's credentials.
   */
  private async etagAfterWrite(calendar: DAVCalendar, url: string, mark: WriteMark): Promise<string | null> {
    try {
      const now = await this.findStoredEvent(calendar, mark.uid, "");
      if (now.url !== url || !writtenBy(now.data, mark)) return null;
      return now.etag;
    } catch (err) {
      this.log("info", "caldav: the etag of a write could not be read back", {
        account: this.accountId,
        reason: classifyFailure(err).reason,
      });
      return null;
    }
  }

  /**
   * Delete an event, permanently (#153). The same guards as
   * {@link updateEvent}; a series is deleted whole, and only when asked to be.
   */
  async deleteEvent(target: EventTarget): Promise<{ uid: string; url: string }> {
    const nothingDone = "Nothing was deleted.";
    if (target.recurrenceId !== undefined) {
      throw new ToolRefusal(
        "Deleting a single occurrence of a recurring event is not supported yet: that is an EXDATE on the series, not a deletion. Nothing was deleted. To delete every occurrence, omit recurrence_id and pass apply_to_series: true."
      );
    }
    const calendar = await this.findCalendar(target.calendarUrl);
    const stored = await this.findStoredEvent(calendar, target.uid, nothingDone);
    const shape = describeSeries(seriesFor(stored.parsed.vcal, target.uid));
    if (shape.overrideOnly && target.applyToSeries !== true) {
      // #211.3: not "every occurrence" — the object holds only this one.
      throw new ToolRefusal(
        `"${target.uid}" is a single occurrence of a series whose other occurrences are not in this calendar (an invitation to one instance, for example). Deleting it removes the whole stored object. Nothing was deleted. Pass apply_to_series: true if that is what you intend.`
      );
    }
    if (shape.recurring && target.applyToSeries !== true) {
      throw seriesRefusal(target.uid, "delete");
    }
    const ifMatch = requireEtag(target, stored, nothingDone);
    const client = await this.ensureClient();
    await this.guardedWrite("DELETE", { calendar, uid: target.uid, url: stored.url, nothingDone }, ifMatch, (etag) =>
      client.deleteCalendarObject({
        calendarObject: { url: stored.url, ...(etag === undefined ? {} : { etag }) },
      })
    );
    return { uid: target.uid, url: stored.url };
  }

  /**
   * Run a write guarded by `ifMatch` (from {@link requireEtag}) and turn its
   * answer into a result or a refusal. Returns the successful response.
   *
   * `If-Match: *` — sent only for an object the server keeps no ETag for — is
   * RFC 7232's "only if it still exists", so that an update of an event
   * deleted since the lookup cannot recreate it (#210.1). But a server can
   * compare `*` literally, and Radicale does on PUT (R10): 412 for an object
   * that is plainly there. So a 412 to `*` is not taken at its word (spec
   * §2.8):
   *
   *   1. look the event up again; gone, and the answer is the not-found
   *      refusal, with nothing written;
   *   2. still there, and the server mishandles `*`: write once more, guarded
   *      by the ETag that second lookup found if the server now gives one,
   *      and with no `If-Match` otherwise.
   *
   * What that second write answers is taken as it comes, a `201 Created`
   * included. Until the review of #224 a 201 here was read as "the event went
   * away in between and this recreated it", and the connector deleted what it
   * had just written. But a 201 says nothing of the kind: Radicale 3.2.3
   * answers 201 to every PUT, replacement or not, and RFC 9110 does not
   * forbid it — so on such a server every update through this path deleted
   * the user's own event and answered that it did not exist. The second
   * lookup has just proved the event exists; only independent proof that it
   * is gone could justify a DELETE, and a status code is not that proof. The
   * cost is the few milliseconds between that lookup and the write: an event
   * deleted elsewhere inside them comes back with this update applied, which
   * is recoverable, where deleting the user's event is not.
   */
  private async guardedWrite(
    method: "PUT" | "DELETE",
    target: WriteTarget,
    ifMatch: string | undefined,
    write: (ifMatch: string | undefined) => Promise<Response>
  ): Promise<Response> {
    const { calendar, uid, url, nothingDone } = target;
    let res = await write(ifMatch);
    if (ifMatch === "*" && res.status === 412) {
      const again = await this.findStoredEvent(calendar, uid, nothingDone);
      if (again.url !== url) throw notFound(uid, calendar.url, nothingDone);
      // A weak ETag can never satisfy If-Match (RFC 7232 §3.1), so it guards nothing.
      res = await write(again.etag !== null && !isWeak(again.etag) ? again.etag : undefined);
    }
    refuseLostRace(res, uid, calendar.url, nothingDone);
    assertWritten(res, method);
    return res;
  }

  /**
   * The stored object holding `uid`, found by a UID `calendar-query` and then
   * checked exactly: RFC 4791's text-match is a substring match (spec §4.2).
   *
   * Every object the query returns is a candidate, whatever its href is
   * called (#211.1), and one that cannot be parsed is passed over rather than
   * ending the search (#211.2): the query matched it on a substring, so the
   * exact match may well be a later one.
   *
   * The match comes back with its parse, which the write that asked for it
   * reuses rather than parsing the same text again.
   */
  private async findStoredEvent(calendar: DAVCalendar, uid: string, nothingDone: string): Promise<FoundObject> {
    const client = await this.ensureClient();
    const objects: DAVCalendarObject[] = await client.fetchCalendarObjects({
      calendar,
      filters: uidFilter(uid),
      urlFilter: everyObjectIn(calendar),
    });
    for (const obj of objects) {
      if (typeof obj.data !== "string") continue;
      let parsed: ParsedCalendar;
      try {
        parsed = parseCalendar(obj.data);
      } catch {
        continue;
      }
      if (describeSeries(seriesFor(parsed.vcal, uid)).found) {
        return { url: obj.url, etag: obj.etag ?? null, data: obj.data, parsed };
      }
    }
    throw notFound(uid, calendar.url, nothingDone);
  }

  async findFreeSlots(
    calendarUrls: string[],
    rangeStart: string,
    rangeEnd: string,
    durationMinutes: number,
    workingHours?: { startHour: number; endHour: number }
  ): Promise<FreeSlot[]> {
    const busy: Array<{ start: number; end: number }> = [];
    for (const url of calendarUrls) {
      const { events } = await this.listEvents(url, rangeStart, rangeEnd);
      for (const e of events) {
        busy.push({
          start: instantOfReported(e.start),
          end: instantOfReported(e.end),
        });
      }
    }
    busy.sort((a, b) => a.start - b.start);
    const merged: Array<{ start: number; end: number }> = [];
    for (const slot of busy) {
      const last = merged[merged.length - 1];
      if (last && slot.start <= last.end) {
        last.end = Math.max(last.end, slot.end);
      } else {
        merged.push({ ...slot });
      }
    }

    const rangeStartMs = new Date(rangeStart).getTime();
    const rangeEndMs = new Date(rangeEnd).getTime();
    const durationMs = durationMinutes * 60 * 1000;
    const free: FreeSlot[] = [];
    let cursor = rangeStartMs;

    const clampToWork = (start: number, end: number): { s: number; e: number } | null => {
      if (!workingHours) return { s: start, e: end };
      // Anchor to the day of `start` in UTC; users pass ISO with offset, so
      // working hours are interpreted in UTC. v0.2 will accept a timezone.
      const d = new Date(start);
      const dayStart = Date.UTC(
        d.getUTCFullYear(),
        d.getUTCMonth(),
        d.getUTCDate(),
        workingHours.startHour
      );
      const dayEnd = Date.UTC(
        d.getUTCFullYear(),
        d.getUTCMonth(),
        d.getUTCDate(),
        workingHours.endHour
      );
      const s = Math.max(start, dayStart);
      const e = Math.min(end, dayEnd);
      if (e - s < durationMs) return null;
      return { s, e };
    };

    for (const slot of merged) {
      if (cursor + durationMs <= slot.start) {
        const clamped = clampToWork(cursor, slot.start);
        if (clamped) {
          free.push({
            start: new Date(clamped.s).toISOString(),
            end: new Date(clamped.e).toISOString(),
          });
        }
      }
      cursor = Math.max(cursor, slot.end);
    }
    if (cursor + durationMs <= rangeEndMs) {
      const clamped = clampToWork(cursor, rangeEndMs);
      if (clamped) {
        free.push({
          start: new Date(clamped.s).toISOString(),
          end: new Date(clamped.e).toISOString(),
        });
      }
    }
    return free;
  }

  private async findCalendar(url: string): Promise<DAVCalendar> {
    const calendars = await (await this.ensureClient()).fetchCalendars();
    const match = calendars.find((c) => c.url === url || c.url.replace(/\/$/, "") === url.replace(/\/$/, ""));
    if (!match) {
      throw new Error(
        `Calendar not found: ${url}. Use list_calendars to discover available URLs.`
      );
    }
    return match;
  }
}

/**
 * tsdav's `urlFilter` for a query in `calendar`: every href except the
 * collection's own, which a server may list among the answers. tsdav's
 * default keeps only hrefs containing `.ics`, and a server that names its
 * objects without the extension then had events neither `list_events` nor
 * the UID lookup could see (#211.1, R7).
 */
function everyObjectIn(calendar: DAVCalendar): (url: string) => boolean {
  const own = calendar.url.replace(/\/+$/, "");
  return (url) => url !== "" && url.replace(/\/+$/, "") !== own;
}

/**
 * A `calendar-query` filter for one UID, in tsdav's xml-js compact form. The
 * shape mirrors tsdav's own default filter (VCALENDAR > VEVENT), with a
 * `prop-filter` where the time range would go.
 */
function uidFilter(uid: string) {
  return {
    "comp-filter": {
      _attributes: { name: "VCALENDAR" },
      "comp-filter": {
        _attributes: { name: "VEVENT" },
        "prop-filter": {
          _attributes: { name: "UID" },
          "text-match": { _attributes: { collation: "i;octet" }, _text: uid },
        },
      },
    },
  };
}

function notFound(uid: string, calendarUrl: string, nothingDone: string): ToolRefusal {
  return new ToolRefusal(`No event with UID "${uid}" in calendar ${calendarUrl}. ${nothingDone}`);
}

function seriesRefusal(uid: string, verb: "change" | "delete"): ToolRefusal {
  const done = verb === "change" ? "changed" : "deleted";
  return new ToolRefusal(
    `"${uid}" is a recurring series, so this would ${verb} every occurrence. Nothing was ${done}. Pass apply_to_series: true if that is what you intend.`
  );
}

/** An ETag's opaque part: without `W/` and without its quotes, so `abc`, `"abc"` and `W/"abc"` compare equal. */
function opaqueTag(etag: string): string {
  return etag.trim().replace(/^W\//i, "").replace(/^"(.*)"$/, "$1");
}

/** True for a weak ETag, `W/"…"`, which `If-Match`'s strong comparison can never match (RFC 7232 §3.1). */
function isWeak(etag: string): boolean {
  return /^W\//i.test(etag.trim());
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
 *     cannot recreate an event deleted since. {@link CalDavClient}'s
 *     `guardedWrite` copes with a server that gets `*` wrong.
 *   - **No caller ETag** for an object that has one is refused: writing blind
 *     over it is the overwrite #152 exists to prevent.
 *
 * A strong value that does not match is sent as it is, and the server's 412
 * says so.
 */
export function requireEtag(
  target: EventTarget,
  stored: { etag: string | null },
  nothingDone = "Nothing was written."
): string | undefined {
  if (target.etag === undefined) {
    if (stored.etag === null) return "*";
    throw new ToolRefusal(
      `Pass the etag list_events returned for "${target.uid}", so a change made elsewhere since you read it is not overwritten. ${nothingDone}`
    );
  }
  if (stored.etag === null) return target.etag;
  const same = opaqueTag(target.etag) === opaqueTag(stored.etag);
  if (isWeak(stored.etag)) {
    if (!same) throw changedSinceRead(target.uid, nothingDone);
    return undefined;
  }
  return same ? stored.etag : target.etag;
}

function changedSinceRead(uid: string, nothingDone: string): ToolRefusal {
  return new ToolRefusal(
    `The event "${uid}" changed after you read it. ${nothingDone} Call list_events again for its current state and etag, then retry.`
  );
}

/**
 * 412 and 404 on a guarded write are answers about the event, not server
 * failures: someone else changed it, or it went away, since it was read.
 */
function refuseLostRace(res: Response, uid: string, calendarUrl: string, nothingDone: string): void {
  if (res.status === 412) throw changedSinceRead(uid, nothingDone);
  if (res.status === 404) throw notFound(uid, calendarUrl, nothingDone);
}

/**
 * tsdav returns the raw Response for every write and throws on none of them,
 * which is how `create_event` came to report success for a 403 (spec §0).
 * Any other non-2xx is a server failure and goes through reportingFailures().
 */
export function assertWritten(res: Response, method: string): void {
  if (!res.ok) {
    throw new Error(`CalDAV server answered ${res.status} ${res.statusText}`.trim() + ` to ${method}`);
  }
}
