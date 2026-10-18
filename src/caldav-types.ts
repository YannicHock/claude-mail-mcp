/**
 * The shapes src/caldav-client.ts takes and answers: what each calendar tool
 * hands the client and what it gets back, and the few the client shares with
 * `move_event`'s move (src/caldav-move.ts). Moved out of the client (#234),
 * which also ends the type-only cycle between it and src/caldav-etag.ts: both
 * import from here now, and this file from neither.
 */

import type { DAVCalendar } from "tsdav";
import type { FreeSlot, WorkingHours } from "./free-slots.js";
import type { NewEventFields } from "./ical-build.js";
import type { EventPatch } from "./ical-edit.js";
import type { CalendarEvent, StoredObject } from "./ical-expand.js";
import type { ParsedCalendar } from "./ical-parse.js";
import type { Logger } from "../shared/log.js";

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

/** What `update_event` answers: the event, its new ETag, and for a meeting whom the server may now email. */
export interface UpdatedEvent {
  uid: string;
  url: string;
  etag: string | null;
  /**
   * For a write to an event the server schedules: everyone the calendar
   * server may now email about it (`EditResult.mayNotify` in
   * src/ical-edit.ts). For a change to the guest list that is
   * `AttendeeResult.mayNotify` in src/ical-attendees.ts, which names the
   * attendees already listed, too, when this call made the account the
   * event's organizer; for any other change, the meeting's attendees, or
   * the organizer of someone else's (milestone review of v0.7.4). Absent
   * for an event the server does not schedule.
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
  /**
   * For an event the server schedules: whom it may email about the deletion
   * — the meeting's attendees, who may be sent a cancellation, or the
   * organizer of someone else's, who may be sent a decline (`mayNotifyAbout`
   * in src/ical-attendees.ts; milestone review of v0.7.4). Absent otherwise.
   */
  mayNotify?: string[];
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
   * `mayNotifyAbout` in src/ical-attendees.ts. Absent otherwise.
   */
  mayNotify?: string[];
}

/**
 * Where a guarded write goes, and what its refusals end with: the one
 * argument `CalDavClient`'s `guardedWrite` takes about the event, in
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
export interface FoundObject extends StoredObject {
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
  /** The earliest slots, at most `MAX_FREE_SLOTS` (src/free-slots.ts) of them. */
  slots: FreeSlot[];
  /** True when there were more than `MAX_FREE_SLOTS` (src/free-slots.ts) slots, and only the earliest are in `slots`. */
  truncated: boolean;
  /** Objects whose busy time could not be read, as `list_events` names them. Empty when every one was read. */
  skipped: SkippedObject[];
  /**
   * False when the principal's addresses could not be looked up: only the
   * mailbox's own address counted as the account's, so an invitation it
   * declined under another address was counted as busy.
   */
  addressesKnown: boolean;
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
   * principal lists none (R13). See `CalDavClient.ownAddresses`.
   */
  address?: string;
}
