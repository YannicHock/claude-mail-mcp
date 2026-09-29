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
import { calendarUserAddresses, notifyChoice, schedulable, touchesAttendees } from "./ical-attendees.js";
import {
  applyEventPatch,
  changesSomething,
  describeSeries,
  touchesTime,
  writtenBy,
  type EditResult,
  type EventPatch,
  type WriteMark,
} from "./ical-edit.js";
import { applyOccurrencePatch, excludeOccurrence } from "./ical-occurrence-edit.js";
import { shiftSeries } from "./ical-series-shift.js";
import {
  instantOfReported,
  type CalendarEvent,
  type FoundOccurrence,
  type OccurrenceLookup,
  type StoredObject,
} from "./ical-expand.js";
import { freeSlots, workingZone, type BusyInterval, type FreeSlot, type WorkingHours } from "./free-slots.js";
import { parseCalendar, seriesFor, type ParsedCalendar } from "./ical-parse.js";
import { expansionPool, reasonOf } from "./ical-worker-pool.js";
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
  /**
   * For an event with attendees: whom the calendar server may now email
   * about it (review of PR #230) — every attendee with `notifyAttendees:
   * true`, none with `false`. Absent for an event with none.
   */
  mayNotify?: string[];
}

/** What `update_event` answers: the event, its new ETag, and for a guest-list change whom the server may now email. */
export interface UpdatedEvent {
  uid: string;
  url: string;
  etag: string | null;
  /**
   * For a change to the guest list: everyone the calendar server may now
   * email about the event — `mayNotify` in src/ical-attendees.ts, which
   * names the attendees already listed, too, when this call made the
   * account the event's organizer. Absent for any other change.
   */
  mayNotify?: string[];
}

/** Which event a write is aimed at, and the guards spec §4 puts on it. */
export interface EventTarget {
  calendarUrl: string;
  uid: string;
  /** From `list_events`. Sent as If-Match; see spec §4.1 for when it may be omitted. */
  etag?: string;
  /**
   * One occurrence of a series, as `list_events` reported its `recurrenceId`
   * (spec 2026-09-29 §2.3, #206). With `applyToSeries`, only the occurrence a
   * series' new start or end describes (§2.4, #207).
   */
  recurrenceId?: string;
  /** Required to touch a recurring event at all, unless `recurrenceId` names one occurrence. */
  applyToSeries?: boolean;
}

export interface EventUpdate extends EventTarget, EventPatch {}

/** What `delete_event` answers. */
export interface DeletedEvent {
  uid: string;
  url: string;
  /**
   * The object's new ETag, for a deletion of one occurrence that wrote the
   * rest of the series back (#206); absent when the object was deleted, and
   * null when the server gave none.
   */
  etag?: string | null;
  /** Said when deleting one occurrence left the series with none. */
  note?: string;
}

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

/** What `find_free_slot` asks for (#213, spec 2026-09-29 §2.7). */
export interface FreeSlotQuery {
  calendarUrls: string[];
  rangeStart: string;
  rangeEnd: string;
  durationMinutes: number;
  /** Whole hours on the working zone's clock, applied to every day in the range. */
  workingHours?: WorkingHours;
  /** An IANA name; omitted, the calendars' own when they agree, else UTC. */
  timezone?: string;
}

/** What `find_free_slot` answers: the zone it worked in, the slots in it, and what it could not check. */
export interface FreeSlotAnswer {
  /** The IANA zone, or `"UTC"`, the working hours were applied in and the slots are given in. */
  timezone: string;
  slots: FreeSlot[];
  /** Objects whose busy time could not be read, as `list_events` names them. Empty when every one was read. */
  skipped: SkippedObject[];
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
  /**
   * The mailbox's own address, `mail.defaultFrom` (from `ClientPool`): one of
   * the account's calendar user addresses, and the only one on a server whose
   * principal lists none (R13). See {@link CalDavClient.ownAddresses}.
   */
  address?: string;
}

export class CalDavClient {
  private client: AuthedDAVClient | null = null;
  private connecting: Promise<AuthedDAVClient> | null = null;
  private readonly auth: CalDavAuth;
  private readonly log: Logger;
  private readonly accountId: string | undefined;
  private readonly address: string | undefined;
  /** {@link ownAddresses}' answer, asked for once per client; dropped again when the asking failed. */
  private addresses: Promise<readonly string[]> | null = null;

  constructor(auth: CalDavAuth, options: CalDavClientOptions = {}) {
    this.auth = auth;
    this.log = options.log ?? (() => {});
    this.accountId = options.accountId;
    this.address = options.address;
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
   *
   * With attendees (#204, spec §2.1) the event is written with the account as
   * ORGANIZER — the first of {@link ownAddresses} — and `notifyAttendees`
   * decides whether the server may mail them (`buildIcs` in
   * src/ical-build.ts). Without it the call is refused before the server is
   * contacted, and so is one whose address lookup fails ({@link ownFor}).
   * The answer's `mayNotify` names whom the server may now email.
   */
  async createEvent(input: NewEventInput): Promise<CreatedEvent> {
    const nothingDone = "Nothing was created.";
    const invites = (input.attendees ?? []).length > 0;
    // Before the server is contacted; see `notifyChoice` for the three guards.
    if (invites) notifyChoice(input.notifyAttendees, nothingDone);
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
    const own = invites ? await this.ownFor(nothingDone) : [];
    const ics = buildIcs({ ...input, uid, own }, zone, nothingDone);
    const filename = `${uid}.ics`;
    const res = await client.createCalendarObject({
      calendar,
      filename,
      iCalString: ics,
    });
    assertWritten(res, "PUT");
    const base = calendar.url.endsWith("/") ? calendar.url : `${calendar.url}/`;
    const created: CreatedEvent = { url: `${base}${filename}`, uid, timezone: builtZoneName(ics) };
    if (!invites) return created;
    return { ...created, mayNotify: schedulable(parseCalendar(ics).vcal.getAllSubcomponents("vevent"), [], own) };
  }

  /**
   * Change an existing event in place (#152). Spec §4: the caller's ETag guards
   * the write, a series needs `applyToSeries`, and everything the patch does
   * not name survives — see src/ical-edit.ts.
   *
   * v0.7.4 (spec 2026-09-29 §2.3, #206): with `recurrenceId` the patch goes
   * to that one occurrence — its override, made from the master if it has
   * none — and `applyToSeries` is not needed. The occurrence is found by
   * {@link occurrence}, off this thread. An object holding only an override
   * (an invitation to one instance, #211.3) is that occurrence, changed with
   * or without `recurrenceId`.
   *
   * v0.7.4 (§2.4, #207): a series' `start` and `end`, with `applyToSeries`,
   * give every occurrence a new clock time and/or length, each keeping its
   * date — `shiftSeries` in src/ical-series-shift.ts, which carries EXDATE, RDATE,
   * the overrides' RECURRENCE-IDs and UNTIL along. The times describe the
   * series' first occurrence, or the one `recurrenceId` names: that is the
   * one meaning `recurrenceId` has beside `applyToSeries: true`. For a change
   * that moves no time the two contradict each other, and the call is refused
   * before the server is contacted.
   *
   * v0.7.4 (§2.1, #205): `addAttendees` and `removeAttendees` change the
   * guest list — of the event, of the whole series with `applyToSeries`, or of
   * the one occurrence `recurrenceId` names — through `applyAttendeePatch` in
   * src/ical-attendees.ts, with {@link ownAddresses} to tell the account's own
   * meeting from someone else's. Without `notifyAttendees` the call is refused
   * before the server is contacted; a lookup of those addresses that fails is
   * a refusal too, ending in "Nothing was changed" ({@link ownFor}). The
   * answer's `mayNotify` names whom the server may now email.
   */
  async updateEvent(update: EventUpdate): Promise<UpdatedEvent> {
    const nothingDone = "Nothing was changed, and no event was created.";
    if (!changesSomething(update)) {
      throw new ToolRefusal(
        "Nothing to change: pass at least one of summary, description, location, start, end, all_day, add_attendees or remove_attendees."
      );
    }
    // Before the server is contacted; see `notifyChoice` for the three guards.
    if (touchesAttendees(update)) notifyChoice(update.notifyAttendees, nothingDone);
    const recurrenceId = update.recurrenceId;
    if (recurrenceId !== undefined && update.applyToSeries === true && !touchesTime(update)) {
      throw new ToolRefusal(
        `recurrence_id and apply_to_series: true contradict each other for a change that moves no time: recurrence_id changes that one occurrence, and apply_to_series every occurrence. Together they only say which occurrence a series' new start or end describes. Omit one of them. ${nothingDone}`
      );
    }
    const calendar = await this.findCalendar(update.calendarUrl);
    const stored = await this.findStoredEvent(calendar, update.uid, nothingDone);
    const own = touchesAttendees(update) ? await this.ownFor(nothingDone) : [];
    const shape = describeSeries(seriesFor(stored.parsed.vcal, update.uid));
    const target: WriteTarget = { calendar, uid: update.uid, url: stored.url, nothingDone };
    const ctx = { nothingDone, now: new Date(), own };
    let edit: EditResult;
    // #211.3: an object with no master has no series here to change; the one
    // occurrence it holds is changed like any other, with or without its
    // recurrence_id.
    if (shape.overrideOnly && update.applyToSeries === true && touchesTime(update)) {
      throw new ToolRefusal(
        `"${update.uid}" is a single occurrence of a series whose other occurrences are not in this calendar (an invitation to one instance, for example), so the series' time cannot be changed here. To move this one occurrence, omit apply_to_series. ${nothingDone}`
      );
    }
    if (shape.overrideOnly || (recurrenceId !== undefined && update.applyToSeries !== true)) {
      const ifMatch = requireEtag(update, stored, nothingDone);
      const found = await this.occurrence(stored, update.uid, recurrenceId ?? null, nothingDone);
      edit = applyOccurrencePatch(stored.parsed, update.uid, found, update, ctx);
      return updated(update.uid, stored.url, await this.putEdit(target, ifMatch, edit), edit);
    }
    if (shape.recurring && update.applyToSeries !== true) throw seriesRefusal(update.uid, "change");
    const ifMatch = requireEtag(update, stored, nothingDone);
    // With apply_to_series, recurrence_id names the occurrence a series' new
    // time describes (§2.4); on an event that does not recur the lookup
    // refuses it, saying so.
    const anchor = recurrenceId === undefined ? null : await this.occurrence(stored, update.uid, recurrenceId, nothingDone);
    edit =
      shape.recurring && touchesTime(update)
        ? shiftSeries(stored.parsed, update.uid, anchor, update, ctx)
        : applyEventPatch(stored.parsed, update.uid, update, ctx);
    return updated(update.uid, stored.url, await this.putEdit(target, ifMatch, edit), edit);
  }

  /**
   * The occurrence of `uid`'s series that `recurrenceId` names — or, for an
   * object holding only an override, with `null`, its one occurrence — found
   * by src/ical-expand.ts's `findOccurrence` in a worker (spec §2.3: matched
   * against the expanded series, never built), since it walks the recurrence
   * rule. A worker that times out or fails, and a `recurrence_id` that names
   * no occurrence, are refusals ending in `nothingDone`.
   */
  private async occurrence(
    stored: FoundObject,
    uid: string,
    recurrenceId: string | null,
    nothingDone: string
  ): Promise<FoundOccurrence> {
    let found: OccurrenceLookup;
    try {
      found = await expansionPool.runOn(
        { url: stored.url, etag: stored.etag, data: stored.data },
        "findOccurrence",
        stored.data,
        uid,
        recurrenceId
      );
    } catch (err) {
      throw new ToolRefusal(`The occurrences of "${uid}" could not be looked up. ${reasonOf(err)} ${nothingDone}`);
    }
    if (!found.found) throw new ToolRefusal(`${found.reason} ${nothingDone}`);
    return found;
  }

  /**
   * PUT an edit of a stored object through {@link guardedWrite}, and return
   * the new ETag: the server's answer's, or read back through
   * {@link etagAfterWrite} when it gave none.
   */
  private async putEdit(target: WriteTarget, ifMatch: string | undefined, edit: EditResult): Promise<string | null> {
    const client = await this.ensureClient();
    const res = await this.guardedWrite("PUT", target, ifMatch, (etag) =>
      client.updateCalendarObject({
        calendarObject: { url: target.url, data: edit.ics, ...(etag === undefined ? {} : { etag }) },
      })
    );
    const answered = res.headers.get("etag");
    if (answered !== null || edit.mark === null) return answered;
    return this.etagAfterWrite(target.calendar, target.url, edit.mark);
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
   *
   * v0.7.4 (spec 2026-09-29 §2.3, #206): with `recurrenceId`, one occurrence
   * — an `EXDATE` on the series, its override removed, the rest of the
   * object written back with a PUT, so the answer carries the new `etag`. If
   * that was the series' last occurrence the object is kept and the answer's
   * `note` says the series has none left. An object holding only overrides
   * (#211.3) has no series to exclude from: the occurrence is removed, and
   * the object deleted when it held nothing else. `recurrenceId` with
   * `applyToSeries: true` is contradictory and refused before the server is
   * contacted.
   */
  async deleteEvent(target: EventTarget): Promise<DeletedEvent> {
    const nothingDone = "Nothing was deleted.";
    const recurrenceId = target.recurrenceId;
    if (recurrenceId !== undefined && target.applyToSeries === true) {
      throw new ToolRefusal(
        `recurrence_id and apply_to_series: true contradict each other: recurrence_id deletes that one occurrence, and apply_to_series the whole series. Omit one of them. ${nothingDone}`
      );
    }
    const calendar = await this.findCalendar(target.calendarUrl);
    const stored = await this.findStoredEvent(calendar, target.uid, nothingDone);
    const shape = describeSeries(seriesFor(stored.parsed.vcal, target.uid));
    const writeTarget: WriteTarget = { calendar, uid: target.uid, url: stored.url, nothingDone };
    if (recurrenceId !== undefined) {
      const ifMatch = requireEtag(target, stored, nothingDone);
      const found = await this.occurrence(stored, target.uid, recurrenceId, nothingDone);
      const edit = excludeOccurrence(stored.parsed, target.uid, found, nothingDone);
      if (!(shape.overrideOnly && edit.seriesEmpty)) {
        const etag = await this.putEdit(writeTarget, ifMatch, edit);
        const note =
          edit.seriesEmpty
            ? "That was the series' last occurrence: it has no occurrences left, but the event itself was kept. Delete it with apply_to_series: true to remove it."
            : undefined;
        return { uid: target.uid, url: stored.url, etag, ...(note === undefined ? {} : { note }) };
      }
      // The only occurrence of an object with no master: nothing would be left.
      await this.deleteObject(writeTarget, ifMatch);
      return { uid: target.uid, url: stored.url };
    }
    if (shape.overrideOnly && target.applyToSeries !== true) {
      // #211.3: not "every occurrence" — the object holds only this one.
      throw new ToolRefusal(
        `"${target.uid}" is a single occurrence of a series whose other occurrences are not in this calendar (an invitation to one instance, for example). Deleting it removes the whole stored object: pass its recurrence_id, or apply_to_series: true, if that is what you intend. ${nothingDone}`
      );
    }
    if (shape.recurring && target.applyToSeries !== true) {
      throw seriesRefusal(target.uid, "delete");
    }
    await this.deleteObject(writeTarget, requireEtag(target, stored, nothingDone));
    return { uid: target.uid, url: stored.url };
  }

  /** DELETE the stored object `target` names, guarded by `ifMatch` through {@link guardedWrite}. */
  private async deleteObject(target: WriteTarget, ifMatch: string | undefined): Promise<void> {
    const client = await this.ensureClient();
    await this.guardedWrite("DELETE", target, ifMatch, (etag) =>
      client.deleteCalendarObject({
        calendarObject: { url: target.url, ...(etag === undefined ? {} : { etag }) },
      })
    );
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

  /**
   * Free time across `calendarUrls` (#213, R14, spec 2026-09-29 §2.7): a thin
   * wrapper — the busy filter is src/ical-busy.ts, run in the worker pool, and
   * the slots are src/free-slots.ts.
   *
   * - **The zone:** `query.timezone`, else the calendars' own when they all
   *   report the same one, else UTC ({@link workingZone}). The answer names it.
   * - **The account's own addresses** come from {@link ownAddresses} and go
   *   into the worker as data, to know whose `PARTSTAT=DECLINED` frees time. A
   *   lookup that fails leaves them empty rather than failing the search: a
   *   declined event then blocks time as anyone else's does — the safe side for
   *   "is this free?" — and one `info` line says why.
   * - **What could not be read is said,** in `skipped`, the way `list_events`
   *   says it: an object with no data, one ical.js cannot read, one cut short,
   *   one that timed out in its worker. Its time is unknown, and never
   *   reported as free in silence.
   *
   * The objects are asked for, and walked, a day either side of the range: a
   * floating or all-day time is placed on the working zone's clock, up to 14
   * hours from where the server's UTC filter put it. Busy time outside the
   * range is then ignored by `freeSlots`.
   *
   * Refused before any request, with `ToolRefusal`: a `timezone` that is no
   * IANA name, working hours that end at or before they start, and a range
   * that is not two date-times, the first before the second.
   */
  async findFreeSlots(query: FreeSlotQuery): Promise<FreeSlotAnswer> {
    const nothingDone = "No calendar was read.";
    let zone: string | null = null;
    if (query.timezone !== undefined) {
      zone = canonicalZone(query.timezone);
      if (zone === null) {
        throw new ToolRefusal(
          `"${query.timezone}" is not an IANA time zone. Pass a name like Europe/Berlin or America/New_York, or omit timezone to use the calendars' own. ${nothingDone}`
        );
      }
    }
    const hours = query.workingHours;
    if (hours !== undefined && hours.endHour <= hours.startHour) {
      throw new ToolRefusal(
        `working_hours.end_hour (${hours.endHour}) must be after start_hour (${hours.startHour}): working hours are one span within each day. ${nothingDone}`
      );
    }
    const range = { start: Date.parse(query.rangeStart), end: Date.parse(query.rangeEnd) };
    if (!Number.isFinite(range.start) || !Number.isFinite(range.end) || range.end <= range.start) {
      throw new ToolRefusal(
        `range_start and range_end must be ISO 8601 date-times with an offset, range_start the earlier. ${nothingDone}`
      );
    }

    const calendars: DAVCalendar[] = [];
    for (const url of query.calendarUrls) calendars.push(await this.findCalendar(url));
    const timezone = zone ?? workingZone(calendars.map((c) => c.timezone));
    let own: readonly string[];
    try {
      own = await this.ownAddresses();
    } catch (err) {
      this.log("info", "caldav: find_free_slot counts every declined event as busy; the account's addresses could not be looked up", {
        account: this.accountId,
        reason: classifyFailure(err).reason,
      });
      own = [];
    }

    const margin = 86_400_000;
    const window = { start: range.start - margin, end: range.end + margin };
    const client = await this.ensureClient();
    const busy: BusyInterval[] = [];
    const skipped: SkippedObject[] = [];
    for (const calendar of calendars) {
      const objects: DAVCalendarObject[] = await client.fetchCalendarObjects({
        calendar,
        timeRange: { start: new Date(window.start).toISOString(), end: new Date(window.end).toISOString() },
        urlFilter: everyObjectIn(calendar),
      });
      const stored: StoredObject[] = [];
      for (const obj of objects) {
        if (typeof obj.data !== "string" || obj.data === "") {
          skipped.push({ url: obj.url, reason: "The server sent no calendar data for it." });
          continue;
        }
        stored.push({ url: obj.url, etag: obj.etag ?? null, data: obj.data });
      }
      // Off this thread, each object under a deadline, all of them one request.
      const results = await expansionPool.runOnEach(stored, "busyTimes", (o) => [o.data, window, own, timezone]);
      results.forEach((result, i) => {
        if (result.status === "rejected") {
          skipped.push({ url: stored[i].url, reason: reasonOf(result.reason) });
          return;
        }
        busy.push(...result.value.busy);
        if (result.value.skipped !== undefined) skipped.push({ url: stored[i].url, reason: result.value.skipped });
      });
    }
    const slots = freeSlots(busy, range, query.durationMinutes, { workingHours: hours, timezone });
    return { timezone, slots, skipped };
  }

  /**
   * The account's own calendar user addresses (spec 2026-09-29 §2.1), as
   * `mailto:` URIs: every `mailto:` in the principal's
   * `calendar-user-address-set` (RFC 6638 §2.4.1), then the mailbox's
   * `mail.defaultFrom` — `calendarUserAddresses` in src/ical-attendees.ts, which
   * also says why in that order. The first is the one an ORGANIZER is written
   * with; any of them makes an event "the account's own meeting".
   *
   * Asked for once per client and kept: a principal's addresses change about
   * as often as its password, and `ClientPool` builds a new client when the
   * account is edited. A lookup that fails is not kept, so the next call asks
   * again.
   *
   * A principal that answers and lists no `mailto:` has no address of its
   * own here, and the mailbox's is used. Any other outcome (the server
   * unreachable, a 401, a 5xx) is passed on, and not kept: taking the
   * mailbox's address on a transient error could make a Nextcloud with a
   * different address read the account's own meeting as an invitation
   * received, and mail people accordingly. See {@link lookUpAddresses}.
   *
   * `find_free_slot` (#213) reads it too, to know which ATTENDEE is the
   * account's own declined one.
   */
  async ownAddresses(): Promise<readonly string[]> {
    this.addresses ??= this.lookUpAddresses().catch((err: unknown) => {
      this.addresses = null;
      throw err;
    });
    return this.addresses;
  }

  /**
   * The PROPFIND behind {@link ownAddresses}, and what its answer means.
   *
   * tsdav's `fetchCalendarUserAddresses` does not throw on a failed request:
   * its `davRequest` hands back `[{ ok: false }]` for any non-2xx, and the
   * function then throws "cannot find calendarUserAddresses" — the very error
   * it throws for a principal it cannot find in a good answer. Taking that
   * error for "the principal lists no address" (as the first version of
   * this did) turned a 503 or a 401 into the mailbox's address, cached for
   * the client's lifetime: on Nextcloud, where the principal's address is a
   * different one, an ORGANIZER the server does not recognise, and the
   * account's own meeting read as someone else's (review of PR #230).
   *
   * So the answer is looked at itself, through a `fetch` that records its
   * status. The mailbox's address stands in only for a `207 Multi-Status` in
   * which the principal lists no `mailto:` — the property absent or `404`,
   * which tsdav reads as no hrefs, or only non-`mailto:` hrefs, as Radicale's
   * (R13). Anything else — another status, no answer, a 207 tsdav cannot
   * find the principal in — throws, is not cached, and refuses the attendee
   * call that asked ({@link ownFor}).
   */
  private async lookUpAddresses(): Promise<readonly string[]> {
    const client = await this.ensureClient();
    // tsdav's declaration asks for the account, but the client createDAVClient
    // hands back fills in the one it discovered at login (its `defaultParam`
    // over `commonDefaultsWithAccount`); passing it would need that account,
    // which the client does not expose. What is passed is merged over it.
    const fetchAddresses = client.fetchCalendarUserAddresses as unknown as (params: {
      fetch: typeof fetch;
    }) => Promise<string[]>;
    let status: number | undefined;
    const recording: typeof fetch = async (input, init) => {
      const res = await fetch(input, init);
      status = res.status;
      return res;
    };
    let hrefs: string[];
    try {
      hrefs = await fetchAddresses({ fetch: recording });
    } catch (err) {
      if (status === undefined || status === 207) throw err;
      throw new Error(`the CalDAV server answered ${status} to the lookup of the account's addresses`);
    }
    if (status !== 207) {
      throw new Error(`the CalDAV server answered ${status ?? "nothing"} to the lookup of the account's addresses`);
    }
    return Object.freeze(calendarUserAddresses(hrefs, this.address));
  }

  /**
   * {@link ownAddresses} for a call that is about to write an attendee: a
   * lookup that fails is a refusal ending in `nothingDone`, before anything
   * is written, rather than a guess at the account's address — which is the
   * ORGANIZER the server compares, and decides by whom it mails. The reason
   * is `classifyFailure`'s bounded reading, never the error object.
   */
  private async ownFor(nothingDone: string): Promise<readonly string[]> {
    try {
      return await this.ownAddresses();
    } catch (err) {
      throw new ToolRefusal(
        `The account's own calendar address could not be looked up (${classifyFailure(err).reason}), so this connector cannot tell whose meeting this is, or write the account as its organizer. Try again in a moment. ${nothingDone}`
      );
    }
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

/** What `updateEvent` answers for a write of `edit`: its `mayNotify` only when it changed the guest list. */
function updated(uid: string, url: string, etag: string | null, edit: EditResult): UpdatedEvent {
  return { uid, url, etag, ...(edit.mayNotify === undefined ? {} : { mayNotify: edit.mayNotify }) };
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
