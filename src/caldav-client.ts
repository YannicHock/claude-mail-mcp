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
  calendarUserAddresses,
  mayNotifyOnMove,
  notifyChoice,
  schedulable,
  schedulingObject,
  touchesAttendees,
} from "./ical-attendees.js";
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
import {
  assertWritten,
  changedSinceRead,
  DavWriteError,
  isWeak,
  notFound,
  refuseLostRace,
  requireEtag,
  unfoldedIcs,
  writeFailure,
} from "./caldav-etag.js";
import { objectName, objectUrl, sameCollection } from "./caldav-url.js";
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

/** Which event `move_event` moves, and where to (#212, spec 2026-09-29 §2.6). */
export interface EventMove extends EventTarget {
  /** The calendar to move it into: another calendar of the same account. */
  targetCalendarUrl: string;
}

/**
 * Which way a move went, for acceptance A5: `"move"` when the server moved
 * the object itself (WebDAV MOVE, RFC 4918 §9.9), `"copy-then-delete"` when
 * it refused that and the event was put into the target and then deleted
 * from the source.
 */
export type MoveMethod = "move" | "copy-then-delete";

/** What `move_event` answers: the event at its new place. */
export interface MovedEvent {
  uid: string;
  /** The object's URL in the target calendar. It keeps its file name. */
  url: string;
  /**
   * Its ETag there: a move changes no content, so on Radicale it is the one
   * it had (R11). Null when the server gave none and it could not be read
   * back.
   */
  etag: string | null;
  via: MoveMethod;
  /**
   * For an event the server schedules: whom it may email about the move —
   * `mayNotifyOnMove` in src/ical-attendees.ts. Absent otherwise.
   */
  mayNotify?: string[];
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
 * #231). Those go to {@link CalDavClient}'s `whereItWent` instead.
 */
function moveRefused(status: number, body: string): boolean {
  return MOVE_REFUSED.has(status) || (status === 502 && /remote destination/i.test(body));
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
  /** The `Authorization` header {@link davFetch} sends: the account's Basic credentials, built once. Never logged. */
  private readonly authorization: string;

  constructor(auth: CalDavAuth, options: CalDavClientOptions = {}) {
    this.auth = auth;
    this.authorization = `Basic ${Buffer.from(`${auth.user}:${auth.pass}`, "latin1").toString("base64")}`;
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
   * #223). `find_free_slot` reads its objects through the same pool, with
   * its own operation ({@link findFreeSlots}).
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
   * The MOVE itself is {@link moveObject}; the answer's `via` says whether the
   * server moved the object or the fallback ({@link copyThenDelete}) ran,
   * which acceptance A5 records.
   *
   * For an event the server schedules, the answer's `mayNotify` names whom
   * it may email ({@link mayNotifyOnMove}), which needs the account's
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
    const vevents = [...(series.master === undefined ? [] : [series.master]), ...series.overrides];
    const own = schedulingObject(vevents) ? await this.ownFor(nothingDone) : [];
    const mayNotify = mayNotifyOnMove(vevents, own);
    const twin = await this.lookUp(target, move.uid);
    if (twin !== null) throw uidTaken(move.uid, nothingDone, twin.url);
    const from: WriteTarget = { calendar: source, uid: move.uid, url: stored.url, nothingDone };
    const destination = objectUrl(target.url, objectName(stored.url));
    const moved = await this.moveObject(from, stored.data, target, destination, ifMatch);
    return {
      uid: move.uid,
      url: destination,
      ...moved,
      ...(mayNotify === undefined ? {} : { mayNotify }),
    };
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
  private async moveObject(
    from: WriteTarget,
    data: string,
    target: DAVCalendar,
    destination: string,
    ifMatch: string | undefined
  ): Promise<Pick<MovedEvent, "etag" | "via">> {
    let res: Response;
    try {
      res = await this.davFetch("MOVE", from.url, {
        destination,
        overwrite: "F",
        ...(ifMatch === undefined ? {} : { "if-match": ifMatch }),
      });
    } catch (err) {
      return this.whereItWent(from, target, destination, `the connection failed: ${classifyFailure(err).reason}`);
    }
    if (res.ok) {
      await res.arrayBuffer();
      return { via: "move", etag: res.headers.get("etag") ?? (await this.etagAfterWrite(target, destination, from.uid)) };
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
      inSource = await this.lookUp(from.calendar, from.uid);
      inTarget = await this.lookUp(target, from.uid);
    } catch (err) {
      this.log("warn", "caldav: move_event could not tell where an event went", {
        account: this.accountId,
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
    this.log("warn", "caldav: move_event found an event in both calendars or in neither", {
      account: this.accountId,
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
   * source through {@link guardedWrite}, guarded by `ifMatch`.
   *
   * Every request here — the PUT, the checks and both DELETEs — goes through
   * {@link davFetch}, not tsdav, as the MOVE does: tsdav resolves a file name
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
      await this.guardedWrite("DELETE", from, guard, (etag) =>
        this.davFetch("DELETE", from.url, etag === undefined ? {} : { "if-match": etag })
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
    return { via: "copy-then-delete", etag: copyEtag ?? (await this.etagAfterWrite(target, copyUrl, from.uid)) };
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
      put = await this.davFetch(
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
    let now: Response;
    try {
      now = await this.davFetch("GET", from.url);
    } catch (err) {
      return new ToolRefusal(
        `The event "${from.uid}" could not be read back from ${from.url} to check that it was not changed since (${classifyFailure(err).reason}). ${from.nothingDone}`
      );
    }
    if (!now.ok) {
      await now.arrayBuffer();
      if (now.status === 404) return notFound(from.uid, from.calendar.url, from.nothingDone);
      return new ToolRefusal(
        `The event "${from.uid}" could not be read back from ${from.url} to check that it was not changed since (the server answered ${now.status}). ${from.nothingDone}`
      );
    }
    if (unfoldedIcs(await now.text()) !== unfoldedIcs(data)) return changedSinceRead(from.uid, from.nothingDone);
    const tag = now.headers.get("etag");
    return { ifMatch: tag !== null && !isWeak(tag) ? tag : undefined };
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
    this.log("warn", "caldav: move_event left an event in two calendars", {
      account: this.accountId,
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
    let guard: string | undefined;
    if (copyEtag !== null && !isWeak(copyEtag)) {
      guard = copyEtag;
    } else {
      const now = await this.davFetch("GET", url);
      if (!now.ok) {
        await now.arrayBuffer();
        if (now.status === 404) return null;
        return `it could not be read back to check it (the server answered ${now.status})`;
      }
      if (unfoldedIcs(await now.text()) !== unfoldedIcs(data)) return "it changed after it was written";
      const tag = now.headers.get("etag");
      guard = tag !== null && !isWeak(tag) ? tag : undefined;
    }
    const res = await this.davFetch("DELETE", url, guard === undefined ? {} : { "if-match": guard });
    await res.arrayBuffer();
    if (res.ok || res.status === 404) return null;
    if (res.status === 412) return "it changed after it was written";
    return `the server answered ${res.status} to deleting it`;
  }

  /**
   * One request to the CalDAV server outside tsdav, which has no MOVE and
   * whose `davRequest` would parse the answer as XML: the account's Basic
   * credentials, as tsdav sends them (built once, in the constructor), the
   * headers given, and a body for a PUT. `move_event` sends every request of
   * its own through here (see {@link copyThenDelete}); the other tools write
   * through tsdav.
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

/** `move_event`'s refusal of a target that is the source. */
function alreadyThere(nothingDone: string): ToolRefusal {
  return new ToolRefusal(
    `The event is already in that calendar: calendar_url and target_calendar_url name the same one, so there is nothing to do. ${nothingDone}`
  );
}

/**
 * True for a server's answer that the target calendar already holds the
 * UID: 409 (Radicale answers `<C:no-uid-conflict/>` with it, RFC 4791
 * §5.3.2.1), or that precondition named in the body of another status, as
 * a server may send it with 403. Sabre's `400 "already exists"` is not
 * recognisable here; `moveEvent`'s search of the target is what catches it.
 */
function uidConflict(status: number, body: string): boolean {
  return status === 409 || /no-uid-conflict/i.test(body);
}

/** The refusal of a move into a calendar that already holds `uid` — at `url`, where the search found it. */
function uidTaken(uid: string, nothingDone: string, url?: string): ToolRefusal {
  const where = url === undefined ? "" : ` (${url})`;
  return new ToolRefusal(`The target calendar already has an event with UID "${uid}"${where}. ${nothingDone}`);
}

function seriesRefusal(uid: string, verb: "change" | "delete"): ToolRefusal {
  const done = verb === "change" ? "changed" : "deleted";
  return new ToolRefusal(
    `"${uid}" is a recurring series, so this would ${verb} every occurrence. Nothing was ${done}. Pass apply_to_series: true if that is what you intend.`
  );
}

