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
 *
 * What the calls take and answer is src/caldav-types.ts, `move_event`'s
 * MOVE and its fallback src/caldav-move.ts, and `find_free_slot`'s checks of
 * its arguments src/free-slots.ts (#234): this file holds the requests every
 * tool shares, and the lookups and guards in front of each write.
 */

import {
  createDAVClient,
  DAVCalendar,
  DAVCalendarObject,
} from "tsdav";
import { randomUUID } from "node:crypto";
import type ICAL from "ical.js";
import { buildIcs, builtZoneName } from "./ical-build.js";
import {
  addressKey,
  calendarUserAddresses,
  mailtoOf,
  mayNotifyAbout,
  notifyChoice,
  schedulable,
  schedulingObject,
  touchesAttendees,
} from "./ical-attendees.js";
import { applyEventPatch, changesSomething, describeSeries, writtenBy } from "./ical-edit.js";
import { everyVevent, touchesTime, type EditResult, type WriteMark } from "./ical-edit-kit.js";
import { applyOccurrencePatch, excludeOccurrence } from "./ical-occurrence-edit.js";
import { shiftSeries } from "./ical-series-shift.js";
import {
  instantOfReported,
  type CalendarEvent,
  type FoundOccurrence,
  type OccurrenceLookup,
  type StoredObject,
} from "./ical-expand.js";
import { freeSlots, freeSlotSearch, MAX_FREE_SLOTS, workingZone, type BusyInterval } from "./free-slots.js";
import { zoneOrRefuse } from "./ical-input.js";
import { parseCalendar, seriesFor, type ParsedCalendar } from "./ical-parse.js";
import { expansionPool, reasonOf } from "./ical-worker-pool.js";
import type { WorkerOps } from "./ical-worker-ops.js";
import { calendarZone } from "./ical-zones.js";
import { DAY_MS } from "./ical-zones-intl.js";
import { assertWritten, notFound, refuseLostRace, requireEtag, strongOrNone } from "./caldav-etag.js";
import { alreadyThere, CalDavMove, uidTaken } from "./caldav-move.js";
import type {
  CalDavAuth,
  CalDavClientOptions,
  CalendarSummary,
  CreatedEvent,
  DeletedEvent,
  EventListing,
  EventMove,
  EventTarget,
  EventUpdate,
  FoundObject,
  FreeSlotAnswer,
  FreeSlotQuery,
  MovedEvent,
  NewEventInput,
  SkippedObject,
  UpdatedEvent,
  WriteTarget,
} from "./caldav-types.js";
import { objectName, objectUrl, sameCollection } from "./caldav-url.js";
import { ToolRefusal } from "./tool-refusal.js";
import { classifyFailure } from "../shared/credential-failure.js";
import type { Logger } from "../shared/log.js";

// createDAVClient returns a logged-in client whose type omits the login
// methods. Capture that shape for our field types.
type AuthedDAVClient = Awaited<ReturnType<typeof createDAVClient>>;

export class CalDavClient {
  private client: AuthedDAVClient | null = null;
  private connecting: Promise<AuthedDAVClient> | null = null;
  private readonly auth: CalDavAuth;
  private readonly log: Logger;
  private readonly accountId: string | undefined;
  private readonly address: string | undefined;
  /** {@link ownAddresses}' answer, asked for once per client; dropped again when the asking failed. */
  private addresses: Promise<readonly string[]> | null = null;
  /** The `Authorization` header {@link davFetch} sends: the account's Basic credentials, built once. Never logged. */
  private readonly authorization: string;
  /** `move_event`'s move (src/caldav-move.ts), reaching the server through this client's own requests. */
  private readonly mover: CalDavMove;

  constructor(auth: CalDavAuth, options: CalDavClientOptions = {}) {
    this.auth = auth;
    this.authorization = `Basic ${Buffer.from(`${auth.user}:${auth.pass}`, "latin1").toString("base64")}`;
    this.log = options.log ?? (() => {});
    this.accountId = options.accountId;
    this.address = options.address;
    this.mover = new CalDavMove({
      davFetch: (method, url, headers, body) => this.davFetch(method, url, headers, body),
      lookUp: (calendar, uid) => this.lookUp(calendar, uid),
      guardedWrite: (method, target, ifMatch, write) => this.guardedWrite(method, target, ifMatch, write),
      etagAfterWrite: (calendar, url, uid) => this.etagAfterWrite(calendar, url, uid),
      log: this.log,
      accountId: this.accountId,
    });
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
   * #223). `find_free_slot` reads its objects through the same pool, with
   * its own operation ({@link findFreeSlots}).
   */
  async listEvents(calendarUrl: string, rangeStart: string, rangeEnd: string): Promise<EventListing> {
    const calendar = await this.findCalendar(calendarUrl);
    const window = { start: Date.parse(rangeStart), end: Date.parse(rangeEnd) };
    const skipped: SkippedObject[] = [];
    const expanded = await this.readEach(calendar, { start: rangeStart, end: rangeEnd }, skipped, "expand", (o) => [
      o.data,
      window,
      { url: o.url, etag: o.etag },
    ]);
    const events: CalendarEvent[] = expanded.flatMap((result) => result.instances);
    events.sort((a, b) => instantOfReported(a.start) - instantOfReported(b.start));
    return { events, skipped };
  }

  /**
   * Every stored object of `calendar` the server finds in `timeRange`, read
   * through the worker operation `op` — off this thread, each object under
   * its deadline, all of them one request (src/ical-worker-pool.ts) — with
   * what could not be read pushed onto `skipped`: an object the server sent
   * no data for, one whose worker timed out or failed, and the `skipped`
   * sentence the operation itself gave. The one path `list_events` and
   * `find_free_slot` read a calendar by (code-health review of PR #232), so
   * the two cannot disagree about what could be read.
   *
   * Answers what each object that was read gave, in the server's order.
   */
  private async readEach<K extends "expand" | "busyTimes">(
    calendar: DAVCalendar,
    timeRange: { start: string; end: string },
    skipped: SkippedObject[],
    op: K,
    argsOf: (object: StoredObject) => Parameters<WorkerOps[K]>
  ): Promise<ReturnType<WorkerOps[K]>[]> {
    const client = await this.ensureClient();
    const objects: DAVCalendarObject[] = await client.fetchCalendarObjects({
      calendar,
      timeRange,
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
    const settled = await expansionPool.runOnEach(stored, op, argsOf);
    const read: ReturnType<WorkerOps[K]>[] = [];
    settled.forEach((result, i) => {
      if (result.status === "rejected") {
        skipped.push({ url: stored[i].url, reason: reasonOf(result.reason) });
        return;
      }
      read.push(result.value);
      const reason = (result.value as { skipped?: string }).skipped;
      if (reason !== undefined) skipped.push({ url: stored[i].url, reason });
    });
    return read;
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
    let zone = input.timezone === undefined ? null : zoneOrRefuse(input.timezone, "the calendar's own", nothingDone);
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
    const created: CreatedEvent = { url: objectUrl(calendar.url, filename), uid, timezone: builtZoneName(ics) };
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
   * a refusal too, ending in "Nothing was changed" ({@link ownFor}).
   *
   * Milestone review of v0.7.4: the answer's `mayNotify` names whom the
   * server may now email after any write to an event it schedules — a new
   * title or time, a series moved, one occurrence changed — not only after
   * a guest-list change (`mayNotifyOf` in src/ical-edit.ts), so the account's
   * addresses are looked up for every such write ({@link ownIfNeeded}). And
   * a new time is refused at once in an object the worker pool remembers
   * running out its deadline ({@link refuseKnownHanging}): the times are
   * placed on this thread.
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
    if (touchesTime(update)) refuseKnownHanging(stored, update.uid, nothingDone);
    const series = seriesFor(stored.parsed.vcal, update.uid);
    const own = await this.ownIfNeeded(touchesAttendees(update), everyVevent(series), nothingDone);
    const shape = describeSeries(series);
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
    return this.etagAfterWrite(target.calendar, target.url, edit.mark.uid, edit.mark);
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
   * `move_event` (#212) passes no `mark`: a move writes no SEQUENCE of its
   * own, so only the URL tells its object from another. It read its ETag
   * back through a copy of this, `etagAt`, until the code-health review of
   * PR #231.
   *
   * A read-back that fails outright leaves one `info` line with the account
   * and the reason (#210.4) — not `warn`, since the call succeeded, but not
   * nothing either: a server where it always fails would otherwise look like
   * the old `etag: null` with no trace in the log. The reason is
   * `classifyFailure`'s bounded reading of the message, never the error
   * object, which can carry the connection's credentials.
   */
  private async etagAfterWrite(calendar: DAVCalendar, url: string, uid: string, mark?: WriteMark): Promise<string | null> {
    try {
      const now = await this.findStoredEvent(calendar, uid, "");
      if (now.url !== url || (mark !== undefined && !writtenBy(now.data, mark))) return null;
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
   *
   * For an event the server schedules, the answer's `mayNotify` names whom
   * it may email about the deletion (milestone review of v0.7.4): the
   * meeting's attendees, who may be sent a cancellation, or the organizer of
   * someone else's, who may be sent a decline — for one occurrence as for
   * the whole event. That needs the account's addresses, and a lookup of
   * them that fails is a refusal ({@link ownIfNeeded}).
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
    const series = seriesFor(stored.parsed.vcal, target.uid);
    const vevents = everyVevent(series);
    const shape = describeSeries(series);
    const writeTarget: WriteTarget = { calendar, uid: target.uid, url: stored.url, nothingDone };
    if (recurrenceId !== undefined) {
      const ifMatch = requireEtag(target, stored, nothingDone);
      const found = await this.occurrence(stored, target.uid, recurrenceId, nothingDone);
      const own = await this.ownIfNeeded(false, vevents, nothingDone);
      const edit = excludeOccurrence(stored.parsed, target.uid, found, { nothingDone, now: new Date(), own });
      const notified = edit.mayNotify === undefined ? {} : { mayNotify: edit.mayNotify };
      if (!(shape.overrideOnly && edit.seriesEmpty)) {
        const etag = await this.putEdit(writeTarget, ifMatch, edit);
        const note =
          edit.seriesEmpty
            ? "That was the series' last occurrence: it has no occurrences left, but the event itself was kept. Delete it with apply_to_series: true to remove it."
            : undefined;
        return { uid: target.uid, url: stored.url, etag, ...(note === undefined ? {} : { note }), ...notified };
      }
      // The only occurrence of an object with no master: nothing would be left.
      await this.deleteObject(writeTarget, ifMatch);
      return { uid: target.uid, url: stored.url, ...notified };
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
    const ifMatch = requireEtag(target, stored, nothingDone);
    const mayNotify = mayNotifyAbout(vevents, await this.ownIfNeeded(false, vevents, nothingDone));
    await this.deleteObject(writeTarget, ifMatch);
    return { uid: target.uid, url: stored.url, ...(mayNotify === undefined ? {} : { mayNotify }) };
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
   * Move an event, whole, into another calendar of the same account (#212,
   * spec 2026-09-29 §2.6). Moving is not an edit: the object's text, its UID,
   * SEQUENCE and file name stay what they were, and on Radicale its ETag too
   * (R11).
   *
   * Refused before the server is contacted: any `recurrenceId` — one
   * occurrence cannot live in another calendar — and a target that is the
   * source. Refused after the lookups, before anything is written: a series
   * without `applyToSeries`, an `etag` that is not the stored one, and a
   * target calendar that already holds the UID.
   *
   * The ETag comparison is made here, strictly ({@link requireEtag}'s
   * `strict`), because Radicale ignores `If-Match` on MOVE (R11: its
   * `move.py` has no precondition code), so an event changed on a phone since
   * `list_events` would otherwise be moved with the change unseen. `If-Match`
   * is still sent, for servers that honour it.
   *
   * The target is searched for the UID first, for the same reason: RFC 4791
   * §5.3.2.1's `no-uid-conflict` is a server's to enforce, and Radicale does
   * (409), but Sabre — Nextcloud — is not known to on MOVE, and on the
   * fallback's PUT it answers `400 "already exists"`, which names no
   * precondition (review of PR #231). A UID twice in one calendar is what no
   * client expects to meet, so this connector does not rely on the server to
   * prevent it. A 409 or `no-uid-conflict` from the server is still read as
   * the same refusal, for a twin that arrived since the search.
   *
   * The MOVE itself is `CalDavMove.moveObject` (src/caldav-move.ts); the
   * answer's `via` says whether the server moved the object or the fallback
   * (`copyThenDelete` there) ran, which acceptance A5 records.
   *
   * For an event the server schedules, the answer's `mayNotify` names whom
   * it may email ({@link mayNotifyAbout}), which needs the account's
   * addresses: a lookup of them that fails is a refusal ({@link ownFor}).
   */
  async moveEvent(move: EventMove): Promise<MovedEvent> {
    const nothingDone = "Nothing was moved.";
    if (move.recurrenceId !== undefined) {
      throw new ToolRefusal(
        `One occurrence of a series cannot be moved to another calendar: a series moves whole, with apply_to_series: true. Omit recurrence_id. ${nothingDone}`
      );
    }
    if (sameCollection(move.calendarUrl, move.targetCalendarUrl)) throw alreadyThere(nothingDone);
    const source = await this.findCalendar(move.calendarUrl);
    const target = await this.findCalendar(move.targetCalendarUrl);
    if (sameCollection(source.url, target.url)) throw alreadyThere(nothingDone);
    const stored = await this.findStoredEvent(source, move.uid, nothingDone);
    const series = seriesFor(stored.parsed.vcal, move.uid);
    if (describeSeries(series).recurring && move.applyToSeries !== true) {
      throw new ToolRefusal(
        `"${move.uid}" is a recurring series, so this would move every occurrence. Pass apply_to_series: true if that is what you intend. ${nothingDone}`
      );
    }
    // R11: Radicale moves whatever If-Match says, so any mismatch is refused here.
    const ifMatch = requireEtag(move, stored, nothingDone, { strict: true });
    const vevents = everyVevent(series);
    const mayNotify = mayNotifyAbout(vevents, await this.ownIfNeeded(false, vevents, nothingDone));
    const twin = await this.lookUp(target, move.uid);
    if (twin !== null) throw uidTaken(move.uid, nothingDone, twin.url);
    const from: WriteTarget = { calendar: source, uid: move.uid, url: stored.url, nothingDone };
    const destination = objectUrl(target.url, objectName(stored.url));
    const moved = await this.mover.moveObject(from, stored.data, target, destination, ifMatch);
    return {
      uid: move.uid,
      url: destination,
      ...moved,
      ...(mayNotify === undefined ? {} : { mayNotify }),
    };
  }


  /**
   * One request to the CalDAV server outside tsdav, which has no MOVE and
   * whose `davRequest` would parse the answer as XML: the account's Basic
   * credentials, as tsdav sends them (built once, in the constructor), the
   * headers given, and a body for a PUT. `move_event` sends every request of
   * its own through here (see `copyThenDelete` in src/caldav-move.ts); the
   * other tools write through tsdav.
   */
  private async davFetch(method: string, url: string, headers: Record<string, string> = {}, body?: string): Promise<Response> {
    return fetch(url, { method, headers: { authorization: this.authorization, ...headers }, ...(body === undefined ? {} : { body }) });
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
      res = await write(strongOrNone(again.etag));
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
   * reuses rather than parsing the same text again. None is the not-found
   * refusal, ending in `nothingDone`; {@link lookUp} answers null instead.
   */
  private async findStoredEvent(calendar: DAVCalendar, uid: string, nothingDone: string): Promise<FoundObject> {
    const found = await this.lookUp(calendar, uid);
    if (found === null) throw notFound(uid, calendar.url, nothingDone);
    return found;
  }

  /**
   * {@link findStoredEvent}'s search, with null for "not there": for a
   * question whose answer either way is fine — whether `move_event`'s target
   * already holds the UID, and where an event went after a MOVE with no
   * clear answer (review of PR #231). A failed request still throws.
   */
  private async lookUp(calendar: DAVCalendar, uid: string): Promise<FoundObject | null> {
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
    return null;
  }

  /**
   * Free time across `calendarUrls` (#213, R14, spec 2026-09-29 §2.7): a thin
   * wrapper — the busy filter is src/ical-busy.ts, run in the worker pool, and
   * the slots are src/free-slots.ts.
   *
   * - **The zone:** `query.timezone`, else the calendars' own when they all
   *   report the same one, else UTC ({@link workingZone}). The answer names it.
   * - **The account's own addresses,** to know whose `PARTSTAT=DECLINED`
   *   frees time, are spec §2.7's: every `mailto:` the principal lists
   *   ({@link ownAddresses}) *and* the mailbox's `mail.defaultFrom` — {@link
   *   freeBusyAddresses}. Wider than the ORGANIZER rule, on purpose: an
   *   address too many here only frees an invitation the account declined.
   * - **A lookup that fails** is no refusal: the mailbox's address alone
   *   counts, an invitation declined under another one blocks time as anyone
   *   else's does — the safe side for "is this free?" — one `info` line says
   *   why, and `addressesKnown` is false, for the tool's warning.
   * - **What could not be read is said,** in `skipped`, the way `list_events`
   *   says it ({@link readEach}): an object with no data, one ical.js cannot
   *   read, one cut short, one that timed out in its worker. Its time is
   *   unknown, and never reported as free in silence.
   * - **A calendar named twice** — with and without its trailing slash — is
   *   read once ({@link sameCollection}), so its objects are not named twice.
   * - **At most {@link MAX_FREE_SLOTS} slots,** the earliest, with
   *   `truncated` when there were more.
   *
   * The objects are asked for, and walked, a day either side of the range: a
   * floating or all-day time is placed on the working zone's clock, up to 14
   * hours from where the server's UTC filter put it. Busy time outside the
   * range is then ignored by `freeSlots`.
   *
   * Refused before any request, with `ToolRefusal`, by `freeSlotSearch`
   * (src/free-slots.ts): a `timezone` that is no IANA name; working hours
   * that end at or before they start; a range that is not two date-times with
   * an offset, the first before the second; and a range longer than
   * `MAX_FREE_SLOT_RANGE_DAYS`, whose per-day work runs on this thread.
   */
  async findFreeSlots(query: FreeSlotQuery): Promise<FreeSlotAnswer> {
    const nothingDone = "No calendar was read.";
    const { zone, range } = freeSlotSearch(query, nothingDone);
    const hours = query.workingHours;

    const calendars: DAVCalendar[] = [];
    for (const url of query.calendarUrls) {
      if (calendars.some((c) => sameCollection(c.url, url))) continue;
      const calendar = await this.findCalendar(url);
      if (!calendars.some((c) => sameCollection(c.url, calendar.url))) calendars.push(calendar);
    }
    const timezone = zone ?? workingZone(calendars.map((c) => c.timezone));
    const { own, addressesKnown } = await this.freeBusyAddresses();

    const window = { start: range.start - DAY_MS, end: range.end + DAY_MS };
    const timeRange = { start: new Date(window.start).toISOString(), end: new Date(window.end).toISOString() };
    const busy: BusyInterval[] = [];
    const skipped: SkippedObject[] = [];
    for (const calendar of calendars) {
      const read = await this.readEach(calendar, timeRange, skipped, "busyTimes", (o) => [o.data, window, own, timezone]);
      for (const result of read) busy.push(...result.busy);
    }
    const found = freeSlots(busy, range, query.durationMinutes, { workingHours: hours, timezone, limit: MAX_FREE_SLOTS + 1 });
    return {
      timezone,
      slots: found.slice(0, MAX_FREE_SLOTS),
      truncated: found.length > MAX_FREE_SLOTS,
      skipped,
      addressesKnown,
    };
  }

  /**
   * The addresses `find_free_slot` counts as the account's own (spec
   * 2026-09-29 §2.7): every one {@link ownAddresses} gives, and the mailbox's
   * `mail.defaultFrom` besides, each once by `addressKey`. {@link
   * ownAddresses} leaves the mailbox's out where the principal lists
   * addresses of its own — the ORGANIZER rule of PR #230, unchanged — but an
   * invitation sent to the mailbox and declined there is the account's own
   * declined one all the same (review of PR #232).
   *
   * A lookup that fails is not passed on: the mailbox's address alone is
   * used, `addressesKnown` is false, and one `info` line says why.
   */
  private async freeBusyAddresses(): Promise<{ own: string[]; addressesKnown: boolean }> {
    let listed: readonly string[] = [];
    let addressesKnown = true;
    try {
      listed = await this.ownAddresses();
    } catch (err) {
      addressesKnown = false;
      this.log("info", "caldav: find_free_slot counts only the mailbox's address as the account's; the principal's addresses could not be looked up", {
        account: this.accountId,
        reason: classifyFailure(err).reason,
      });
    }
    const own = [...listed];
    const mailbox = this.address;
    if (mailbox && addressKey(mailbox) !== "" && !own.some((a) => addressKey(a) === addressKey(mailbox))) {
      own.push(mailtoOf(mailbox));
    }
    return { own, addressesKnown };
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
   * account's own declined one — with the mailbox's address added whatever
   * the principal lists ({@link freeBusyAddresses}).
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

  /**
   * The account's own addresses for a write that needs them — one that
   * changes the guest list (`guestList`), or any write to an event the
   * server schedules (`schedulingObject` of `vevents`, every VEVENT of its
   * UID), whose `may_notify` tells the account's own meeting from someone
   * else's by them (milestone review of v0.7.4) — through {@link ownFor}, so
   * a lookup that fails is a refusal ending in `nothingDone`, before
   * anything is written. None for any other write: nothing is looked up for
   * an event no server mails anyone about.
   */
  private async ownIfNeeded(
    guestList: boolean,
    vevents: readonly ICAL.Component[],
    nothingDone: string
  ): Promise<readonly string[]> {
    return guestList || schedulingObject(vevents) ? this.ownFor(nothingDone) : [];
  }

  /**
   * The calendar `url` names, among the account's: compared by
   * {@link sameCollection}, the one test of "one collection" (code-health
   * review of the v0.7.4 milestone; this kept a copy of its own that allowed
   * one trailing slash, not several). A URL that names none is an error
   * pointing at `list_calendars`.
   */
  private async findCalendar(url: string): Promise<DAVCalendar> {
    const calendars = await (await this.ensureClient()).fetchCalendars();
    const match = calendars.find((c) => sameCollection(c.url, url));
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

/**
 * `update_event`'s refusal of a time written into `stored` when the pool
 * remembers this version of it (URL and ETag) running out its deadline
 * (`ExpansionPool.hangingFor` in src/ical-worker-pool.ts; milestone review
 * of v0.7.4). The writers place times on the connector's own thread; an
 * object whose expansion never finished in a worker is not one to be the
 * first to find out on that thread why. Ends in `nothingDone`.
 */
function refuseKnownHanging(stored: FoundObject, uid: string, nothingDone: string): void {
  const known = expansionPool.hangingFor({ url: stored.url, etag: stored.etag, data: stored.data });
  if (known === null) return;
  throw new ToolRefusal(
    `"${uid}" could not be read in time when it was last listed: ${known.message} Its times cannot be changed safely until it can be read. ${nothingDone}`
  );
}

/** What `updateEvent` answers for a write of `edit`: its `mayNotify` whenever the edit gave one (`mayNotifyOf` in src/ical-edit.ts). */
function updated(uid: string, url: string, etag: string | null, edit: EditResult): UpdatedEvent {
  return { uid, url, etag, ...(edit.mayNotify === undefined ? {} : { mayNotify: edit.mayNotify }) };
}


function seriesRefusal(uid: string, verb: "change" | "delete"): ToolRefusal {
  const done = verb === "change" ? "changed" : "deleted";
  return new ToolRefusal(
    `"${uid}" is a recurring series, so this would ${verb} every occurrence. Nothing was ${done}. Pass apply_to_series: true if that is what you intend.`
  );
}

