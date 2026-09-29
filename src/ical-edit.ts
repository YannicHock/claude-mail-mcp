/**
 * Reading and editing a stored iCalendar object, for `update_event` and
 * `delete_event` (#152, #153). No network access: `CalDavClient` fetches and
 * writes, this module decides what the new object says.
 *
 * The one rule everything here serves: **an update edits the stored object, it
 * does not rebuild it.** The object is parsed, the main VEVENT for the UID is
 * changed in place, and the whole thing is serialised again — so VTIMEZONE,
 * VALARM, ATTENDEE with all its parameters, ORGANIZER, X- properties and any
 * override VEVENTs come out as they went in. Rebuilding from the fields this
 * connector models would silently drop every one of them, which #152 names as
 * the failure mode to design against.
 *
 * See docs/planning/specs/2026-09-28-v0.7.2-the-other-half-of-the-calendar.md §4.
 *
 * v0.7.4 (spec 2026-09-29 §2.5, #208, #209): that includes the event's zone.
 * A new time goes back in the zone the old one was stored in, through the
 * writing half of src/ical-zones.ts, and the object is read through
 * `parseCalendar` exactly as `list_events` reads it — so a TZID with no
 * VTIMEZONE is Berlin to both, not Berlin to one and floating to the other.
 *
 * Two conventions since the code-health review of PR 3. Every refusal here
 * ends in the `nothingDone` its caller passes — "Nothing was changed.",
 * "Nothing was deleted.", "Nothing was created." — rather than a sentence
 * this module picks for it. And an edit takes the caller's one parse of the
 * stored text (`ParsedCalendar`), changes it in place, and hands back the
 * text to write: a write parses the stored object once.
 *
 * What lives where since the code-health review of PR #229, which split this
 * module before the attendee edits land in it:
 *
 *   - here: the patch and what it is checked for, the read-back's
 *     {@link WriteMark}, and the edit of one VEVENT — {@link patchText},
 *     {@link patchTimes}, {@link stampRevision} — that every writer below
 *     uses for whichever VEVENT it changes, and {@link applyEventPatch}, the
 *     edit of a main event;
 *   - src/ical-attendees.ts (#204, #205, spec 2026-09-29 §2.1): a guest list
 *     changed, which every writer here calls the way it calls
 *     {@link patchText}. Those are the edits that decide whether a calendar
 *     server mails real people, and they live on their own so that the
 *     worker can read a guest list without importing an editor;
 *   - src/ical-occurrence-edit.ts: one occurrence of a series changed or
 *     deleted (#206);
 *   - src/ical-series-shift.ts: a whole series moved to a new time (#207);
 *   - src/ical-input.ts: a caller's date or time read, shared with
 *     `create_event`'s builder (src/ical-build.ts);
 *   - src/ical-series.ts: which VEVENT is which occurrence and which counts,
 *     shared with the reader (src/ical-expand.ts), which this module no
 *     longer imports.
 */

import ICAL from "ical.js";
import { patchSeriesAttendees, touchesAttendees, type AttendeePatch, type AttendeeResult } from "./ical-attendees.js";
import { calendarDate, dateMs, isoDate, timedBound } from "./ical-input.js";
import { parseCalendar, seriesFor, type ParsedCalendar, type Series } from "./ical-parse.js";
import { allDaySeries, currentOverrides, sequenceOf } from "./ical-series.js";
import {
  coverGeneratedVtimezone,
  hasOffset,
  storedInstant,
  UTC_ZONE,
  writeZoneOf,
  writtenTime,
  type WriteZone,
} from "./ical-zones.js";
import { ToolRefusal } from "./tool-refusal.js";

/**
 * The fields `update_event` can change. Everything else is left alone. The
 * guest list (#205) is {@link AttendeePatch}'s, in src/ical-attendees.ts.
 */
export interface EventPatch extends AttendeePatch {
  summary?: string;
  /** `""` removes the property. */
  description?: string;
  /** `""` removes the property. */
  location?: string;
  /** ISO 8601 with offset, or `YYYY-MM-DD` for an all-day event. */
  start?: string;
  end?: string;
  allDay?: boolean;
}

/**
 * What every writer of a stored object is handed besides the patch (the
 * code-health review of PR #230 replaced the positional parameters that kept
 * growing): the sentence its refusals end with, the time its revision is
 * stamped with, and the account's own calendar user addresses.
 */
export interface EditContext {
  /** "Nothing was changed." and the like: what a refusal says was not done. */
  nothingDone: string;
  /** DTSTAMP and LAST-MODIFIED of every VEVENT the write changes. */
  now: Date;
  /**
   * The account's calendar user addresses (`ownAddresses` in
   * src/caldav-client.ts), which an attendee change needs to tell the
   * account's own meeting from someone else's and to write its ORGANIZER.
   * No default: a writer handed none has been told the account has none,
   * and an attendee change is then refused.
   */
  own: readonly string[];
}

export interface StoredEventShape {
  /** Some VEVENT in the object carries exactly this UID. */
  found: boolean;
  /** RRULE or RDATE on the main VEVENT, or any VEVENT with a RECURRENCE-ID. */
  recurring: boolean;
  /**
   * Only overrides for the UID, no main VEVENT: one occurrence of a series
   * that lives elsewhere, as an invitation to a single instance is stored
   * (#211.3, R3). `recurring` is true for it as well.
   */
  overrideOnly: boolean;
}

/** True when the patch touches the event's time, which a series refuses (§4.3). */
export function touchesTime(patch: EventPatch): boolean {
  return patch.start !== undefined || patch.end !== undefined || patch.allDay !== undefined;
}

/** True when the patch changes anything at all. */
export function changesSomething(patch: EventPatch): boolean {
  return (
    patch.summary !== undefined ||
    patch.description !== undefined ||
    patch.location !== undefined ||
    touchesTime(patch) ||
    touchesAttendees(patch)
  );
}

/**
 * What one UID's VEVENTs are, for the checks that come before any write. The
 * caller has found them with `seriesFor` (src/ical-parse.ts), which compares
 * the UID exactly: the server-side lookup is a CalDAV `text-match`, which
 * RFC 4791 defines as a substring match, so the object it hands back for
 * `ev1` may be `ev10`'s. `found` is false for that one.
 */
export function describeSeries({ master, overrides }: Series): StoredEventShape {
  if (master === undefined && overrides.length === 0) {
    return { found: false, recurring: false, overrideOnly: false };
  }
  const recurring =
    overrides.length > 0 || master?.hasProperty("rrule") === true || master?.hasProperty("rdate") === true;
  return { found: true, recurring, overrideOnly: master === undefined };
}

/**
 * What a write made, for the read-back that follows it: the new object's
 * text, and the {@link WriteMark} by which that version is told from one
 * written since.
 */
export interface EditResult {
  ics: string;
  /** Null when the write left no VEVENT it changed to know it by (see `excludeOccurrence` in src/ical-occurrence-edit.ts). */
  mark: WriteMark | null;
  /**
   * For a write that changed the guest list (#205): whom the calendar server
   * may now email about the event — `AttendeeResult.mayNotify` in
   * src/ical-attendees.ts, which `update_event` answers as `may_notify`.
   * Absent for any other write.
   */
  mayNotify?: string[];
}

/**
 * Which VEVENT a write changed and the SEQUENCE it left there. `CalDavClient`
 * reads the object back when the server's answer to a PUT carried no ETag
 * (Nextcloud), and hands that ETag out only if the object still says this
 * ({@link writtenBy}): the same VEVENT at the same SEQUENCE.
 */
export interface WriteMark {
  uid: string;
  sequence: number;
  /**
   * The occurrence whose override the write changed, by `keyOf`
   * (src/ical-series.ts) of its RECURRENCE-ID; absent for the main VEVENT.
   */
  override?: string;
}

/**
 * True when `ics` still holds the version `mark` describes: the VEVENT the
 * write changed — the main one, or the current override of the occurrence
 * it names — carries the SEQUENCE the write gave it. False for an object that
 * no longer holds it, or that cannot be read.
 */
export function writtenBy(ics: string, mark: WriteMark): boolean {
  try {
    const { master, overrides } = seriesFor(parseCalendar(ics).vcal, mark.uid);
    if (mark.override === undefined) return master !== undefined && sequenceOf(master) === mark.sequence;
    const current = currentOverrides(overrides, allDaySeries(master)).get(mark.override);
    return current !== undefined && sequenceOf(current.ve) === mark.sequence;
  } catch {
    return false;
  }
}

/**
 * The bookkeeping every edit of a VEVENT ends with (spec 2026-09-28 §4.4,
 * kept in v0.7.4 §4): SEQUENCE raised by one — read through
 * {@link sequenceOf} — and DTSTAMP and LAST-MODIFIED set to `now`. Returns
 * the new SEQUENCE.
 */
export function stampRevision(vevent: ICAL.Component, now: Date): number {
  const sequence = sequenceOf(vevent) + 1;
  vevent.updatePropertyWithValue("sequence", sequence);
  const stamp = ICAL.Time.fromJSDate(now, true);
  vevent.updatePropertyWithValue("dtstamp", stamp);
  vevent.updatePropertyWithValue("last-modified", stamp);
  return sequence;
}
/**
 * Write `time` into the VEVENT's `name` property, in place when it has one —
 * so the property keeps its position and every parameter but the two this
 * decides — with `TZID` as `zone` says: set for a zoned time, gone for UTC, a
 * floating time and a date. `zone` is the one the time is actually written
 * in (`WrittenTime` in src/ical-zones.ts), which for the second pass through
 * an autumn overlap is UTC whatever the event's zone.
 */
export function setTime(vevent: ICAL.Component, name: "dtstart" | "dtend", time: ICAL.Time, zone: WriteZone | null): void {
  let prop = vevent.getFirstProperty(name);
  if (prop === null) {
    prop = new ICAL.Property(name);
    vevent.addProperty(prop);
  }
  prop.setValue(time);
  if (zone?.kind === "zoned") prop.setParameter("tzid", zone.tzid);
  else prop.removeParameter("tzid");
}

/**
 * After a write moved times in `zones`: the VTIMEZONE this connector
 * generated for any of them (`create_event`'s, marked as ours) is regenerated
 * to cover the object's times again (`coverGeneratedVtimezone` in
 * src/ical-zones.ts), since outside its span it would read the zone wrong.
 * Any other VTIMEZONE is left byte for byte (review of #224). `vcal` is the
 * VCALENDAR the written VEVENT sits in; null for a VEVENT outside one, which
 * has no block to cover.
 */
export function coverGenerated(vcal: ICAL.Component | null, zones: Iterable<WriteZone>): void {
  if (vcal === null) return;
  for (const zone of new Set(zones)) {
    if (zone.kind === "zoned" && zone.generated === true) coverGeneratedVtimezone(vcal, zone.tzid);
  }
}

/** How a timed bound is shown in a refusal: clock time for a floating one, an instant otherwise. */
export function shown(ms: number, zone: WriteZone): string {
  const iso = new Date(ms).toISOString();
  return zone.kind === "floating" ? iso.slice(0, 19) : iso;
}

/** Set, or with `""` remove, the text fields the patch names on `vevent`. */
export function patchText(vevent: ICAL.Component, patch: EventPatch): void {
  if (patch.summary !== undefined) vevent.updatePropertyWithValue("summary", patch.summary);
  for (const name of ["description", "location"] as const) {
    const value = patch[name];
    if (value === undefined) continue;
    if (value === "") vevent.removeAllProperties(name);
    else vevent.updatePropertyWithValue(name, value);
  }
}

/**
 * Apply `patch` to the main VEVENT of `uid` in `parsed` — an object read by
 * `parseCalendar` (src/ical-parse.ts), which the caller has already used to
 * establish that the UID is there — and return the new object with its
 * {@link WriteMark}. `parsed` is changed in place: it is the caller's one
 * parse of the stored text, for this one write (code-health review of PR 3:
 * a write parsed the same text three times).
 *
 * The attendees first, by `patchSeriesAttendees` (src/ical-attendees.ts) —
 * so its refusals come before anything is changed — then the text fields as
 * given and the time by {@link patchTimes}; the VEVENT's revision is
 * stamped, and that of every other VEVENT the attendee change wrote. Throws
 * {@link ToolRefusal} ending in `ctx.nothingDone` for a patch that cannot be
 * applied as asked.
 */
export function applyEventPatch(parsed: ParsedCalendar, uid: string, patch: EventPatch, ctx: EditContext): EditResult {
  const { nothingDone, now, own } = ctx;
  const { vcal } = parsed;
  const { master, overrides } = seriesFor(vcal, uid);
  if (master === undefined) {
    throw new Error(`applyEventPatch: no main VEVENT for UID ${uid}`);
  }
  const guests = patchSeriesAttendees(master, overrides, patch, own, nothingDone);
  patchText(master, patch);
  if (touchesTime(patch)) patchTimes(master, patch, nothingDone);
  const sequence = stampRevision(master, now);
  stampOthers(guests, master, now);
  return { ics: vcal.toString(), mark: { uid, sequence }, ...mayNotifyOf(guests) };
}

/**
 * Stamp the revision of every VEVENT an attendee change wrote besides
 * `stamped`, which the writer stamps itself — each once, however many of
 * the change's steps reached it (the ORGANIZER, a SCHEDULE-AGENT, the guest
 * list).
 */
export function stampOthers(guests: AttendeeResult | null, stamped: ICAL.Component, now: Date): void {
  for (const vevent of guests?.changed ?? []) if (vevent !== stamped) stampRevision(vevent, now);
}

/** The {@link EditResult.mayNotify} of a write whose attendee change answered `guests`; nothing for a write that made none. */
export function mayNotifyOf(guests: AttendeeResult | null): Pick<EditResult, "mayNotify"> {
  return guests === null ? {} : { mayNotify: guests.mayNotify };
}
/**
 * Write the time `patch` asks for into `vevent` — a main VEVENT or an
 * override, the same rules for either — in the zone the event was stored in
 * (spec 2026-09-29 §2.5, #208, #209): TZID local time for a zoned event —
 * the object's VTIMEZONE left byte for byte, and none added where it had
 * none — UTC for a UTC one, a date for an all-day one, and clock time for a
 * floating one. A switch from all-day to timed is written in UTC, as before.
 * DURATION gives way to DTEND.
 *
 * Three refinements from the review of #224. A wall time in the gap or the
 * overlap is read by RFC 5545 §3.3.5's rule whether the zone comes from the
 * object's VTIMEZONE or from `Intl`, so the two write the same times. A bound
 * that lands on the second pass through an autumn overlap, which no wall
 * time names, is written in UTC rather than as a wall time that means an
 * hour earlier. And the one VTIMEZONE whose bytes may change is the one this
 * connector generated for `create_event`: it is regenerated to cover the new
 * times, since outside its span it would read the zone wrong. That block is
 * found through `vevent.parent`, the VCALENDAR the VEVENT sits in.
 *
 * Throws {@link ToolRefusal} ending in `nothingDone` for a patch that cannot
 * be applied as asked — an end that is not after the start, an all-day switch
 * without both bounds, a date it cannot read, an offset for a floating event,
 * or a one-sided time change on an event whose TZID nothing can place.
 * Extracted from `applyEventPatch` (code-health review of PR 3) so that one
 * occurrence's override gets exactly the time logic the main event does.
 */
export function patchTimes(vevent: ICAL.Component, patch: EventPatch, nothingDone: string): void {
  const event = new ICAL.Event(vevent);
  const wasAllDay = Boolean(event.startDate.isDate);
  const allDay = patch.allDay ?? wasAllDay;
  if (allDay !== wasAllDay && (patch.start === undefined || patch.end === undefined)) {
    throw new ToolRefusal(
      `Switching an event between all-day and timed needs both start and end. ${nothingDone}`
    );
  }

  if (allDay) {
    const oldStart = event.startDate.toString().slice(0, 10);
    const oldEnd = event.endDate.toString().slice(0, 10);
    const start = patch.start !== undefined ? calendarDate("start", patch.start, nothingDone) : oldStart;
    const end =
      patch.end !== undefined
        ? calendarDate("end", patch.end, nothingDone)
        : patch.start !== undefined
          ? isoDate(dateMs(start) + (dateMs(oldEnd) - dateMs(oldStart)))
          : oldEnd;
    if (dateMs(end) <= dateMs(start)) {
      throw new ToolRefusal(
        `The event would end (${end}) on or before it starts (${start}). For an all-day event the end date is exclusive. ${nothingDone}`
      );
    }
    setTime(vevent, "dtstart", ICAL.Time.fromDateString(start), null);
    setTime(vevent, "dtend", ICAL.Time.fromDateString(end), null);
  } else {
    const startProp = vevent.getFirstProperty("dtstart");
    const endProp = vevent.getFirstProperty("dtend");
    // Each bound goes back in its own zone; a DTEND the event did not have
    // (it had a DURATION, or nothing) takes the start's. A switch from
    // all-day has no zone to keep and is written in UTC, as before v0.7.4.
    const storedStart = wasAllDay || startProp === null ? UTC_ZONE : writeZoneOf(startProp);
    const storedEnd = wasAllDay || endProp === null ? storedStart : writeZoneOf(endProp);

    // A result that keeps one of the old bounds needs that bound as an
    // instant, and a TZID nothing can place has none: ical.js reads it as
    // the process's local time, and writing that back would move the event
    // by hours while reporting success (final review of #152; #209 keeps
    // this refusal for exactly this case).
    const keepsOldBound = patch.start === undefined || patch.end === undefined;
    for (const stored of [storedStart, storedEnd]) {
      if (stored.kind !== "unresolved") continue;
      if (keepsOldBound) {
        throw new ToolRefusal(
          `This event's time is stored in the time zone "${stored.tzid}", which has no VTIMEZONE in the event and is not an IANA time zone, so this connector cannot tell what instant it is, and changing only one end of it could shift it by hours. ${nothingDone} Pass both start and end, with an offset, to set its time outright.`
        );
      }
      for (const [field, value] of [["start", patch.start], ["end", patch.end]] as const) {
        if (value !== undefined && !hasOffset(value)) {
          throw new ToolRefusal(
            `This event's time zone "${stored.tzid}" cannot be placed, so ${field} "${value}" needs an offset, like 2026-10-01T09:00:00+02:00, to say which instant it means. ${nothingDone}`
          );
        }
      }
    }
    // Both bounds given for a zone nothing can place: written in UTC, which
    // needs neither old time.
    const startZone: WriteZone = storedStart.kind === "unresolved" ? UTC_ZONE : storedStart;
    const endZone: WriteZone = storedEnd.kind === "unresolved" ? UTC_ZONE : storedEnd;

    // RFC 5545 §3.6.1: a timed event with neither DTEND nor DURATION has no
    // length. Moving it keeps it that way rather than inventing an end —
    // and rather than refusing because the "old length" is zero.
    const hadNoEnd = !wasAllDay && endProp === null && !vevent.hasProperty("duration");
    // The old bounds are read by the rule the new ones are (review of
    // #224): ical.js's own reading of a VTIMEZONE puts a wall time in the
    // overlap on its second pass, and a length measured from there moved
    // the end by an hour.
    const oldStart = storedInstant(event.startDate, startZone);
    const startMs = patch.start !== undefined ? timedBound("start", patch.start, startZone, nothingDone) : oldStart;
    let endMs: number | undefined;
    if (patch.end !== undefined) endMs = timedBound("end", patch.end, endZone, nothingDone);
    else if (hadNoEnd) endMs = undefined;
    else {
      const oldEnd = storedInstant(event.endDate, endZone);
      endMs = patch.start !== undefined ? startMs + (oldEnd - oldStart) : oldEnd;
    }
    if (endMs !== undefined && endMs <= startMs) {
      throw new ToolRefusal(
        `The event would end (${shown(endMs, endZone)}) at or before it starts (${shown(startMs, startZone)}). ${nothingDone}`
      );
    }
    // Each bound in its zone, or in UTC for an instant no wall time there
    // names: see `writtenTime`.
    const start = writtenTime(startMs, startZone);
    setTime(vevent, "dtstart", start.time, start.zone);
    if (endMs === undefined) vevent.removeAllProperties("dtend");
    else {
      const end = writtenTime(endMs, endZone);
      setTime(vevent, "dtend", end.time, end.zone);
    }
    coverGenerated(vevent.parent, [startZone, endZone]);
  }
  vevent.removeAllProperties("duration");
}
