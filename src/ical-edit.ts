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
 */

import ICAL from "ical.js";
import { currentOverrides, keyOf, type FoundOccurrence } from "./ical-expand.js";
import { parseCalendar, seriesFor, type ParsedCalendar, type Series } from "./ical-parse.js";
import {
  coverGeneratedVtimezone,
  hasOffset,
  readDateTime,
  storedInstant,
  UTC_ZONE,
  writeZoneOf,
  writtenTime,
  type WriteZone,
} from "./ical-zones.js";
import { ToolRefusal } from "./tool-refusal.js";

/** The fields `update_event` can change. Everything else is left alone. */
export interface EventPatch {
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
    touchesTime(patch)
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

/** {@link describeSeries} for `uid` in the text `ics`, parsed here. */
export function describeStoredEvent(ics: string, uid: string): StoredEventShape {
  return describeSeries(seriesFor(parseCalendar(ics).vcal, uid));
}

/**
 * A VEVENT's SEQUENCE: absent, or not a number, counts as 0. The one reading
 * both {@link mainSequence} and every edit here use (#214), because
 * `CalDavClient`'s read-back after a write trusts the two to agree — if they
 * drifted, it would hand back no etag for its own write, or someone else's
 * for it.
 */
export function sequenceOf(vevent: ICAL.Component): number {
  const sequence = Number(vevent.getFirstPropertyValue("sequence") ?? 0);
  return Number.isFinite(sequence) ? sequence : 0;
}

/**
 * The SEQUENCE of the main VEVENT for `uid` (see {@link sequenceOf}), or null
 * when the object holds no main VEVENT for it. Lets a read-back after a write
 * tell its own version from one written since.
 */
export function mainSequence(ics: string, uid: string): number | null {
  const { master } = seriesFor(parseCalendar(ics).vcal, uid);
  return master === undefined ? null : sequenceOf(master);
}

/**
 * What a write made, for the read-back that follows it: the new object's
 * text, and the {@link WriteMark} by which that version is told from one
 * written since.
 */
export interface EditResult {
  ics: string;
  /** Null when the write left no VEVENT it changed to know it by (see {@link excludeOccurrence}). */
  mark: WriteMark | null;
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
   * (src/ical-expand.ts) of its RECURRENCE-ID; absent for the main VEVENT.
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

/** Midnight UTC of the date part, so all-day arithmetic counts whole days. */
function dateMs(iso: string): number {
  return Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * A caller's all-day bound as `YYYY-MM-DD`, or a refusal ending in
 * `nothingDone`. The round trip catches a date that parses but does not
 * exist: `2026-13-45` would otherwise roll over and be written as a date in
 * 2027.
 */
export function calendarDate(field: "start" | "end", value: string, nothingDone: string): string {
  const day = value.slice(0, 10);
  const ms = /^\d{4}-\d{2}-\d{2}$/.test(day) ? dateMs(day) : NaN;
  if (Number.isNaN(ms) || isoDate(ms) !== day) {
    throw new ToolRefusal(
      `${field} "${value}" is not a calendar date (YYYY-MM-DD) for an all-day event. ${nothingDone}`
    );
  }
  return day;
}

/**
 * A caller's timed bound, read for `zone` by {@link readDateTime}, or a
 * refusal ending in `nothingDone`. Unchecked, an unreadable value is NaN, and
 * the RangeError that follows reaches the operator's log as a server failure
 * — the noise spec §4.5 exists to keep out of it.
 *
 * A floating zone refuses a value with an offset (#209, spec §2.5): the event
 * has no zone to convert it into, and silently dropping the offset would move
 * it by that much.
 */
export function timedBound(field: "start" | "end", value: string, zone: WriteZone, nothingDone: string): number {
  if (zone.kind === "floating" && hasOffset(value)) {
    throw new ToolRefusal(
      `This event is floating: it is stored as clock time with no time zone, and shows at that clock time wherever it is read. So its ${field} must be given without an offset, like 2026-10-01T09:00:00, and "${value}" has one. ${nothingDone}`
    );
  }
  const ms = readDateTime(value, zone);
  if (Number.isNaN(ms)) {
    throw new ToolRefusal(
      `${field} "${value}" is not an ISO 8601 date-time, like 2026-10-01T09:00:00+02:00. ${nothingDone}`
    );
  }
  return ms;
}

/**
 * Write `time` into the VEVENT's `name` property, in place when it has one —
 * so the property keeps its position and every parameter but the two this
 * decides — with `TZID` as `zone` says: set for a zoned time, gone for UTC, a
 * floating time and a date. `zone` is the one the time is actually written
 * in (`WrittenTime` in src/ical-zones.ts), which for the second pass through
 * an autumn overlap is UTC whatever the event's zone.
 */
function setTime(vevent: ICAL.Component, name: "dtstart" | "dtend", time: ICAL.Time, zone: WriteZone | null): void {
  let prop = vevent.getFirstProperty(name);
  if (prop === null) {
    prop = new ICAL.Property(name);
    vevent.addProperty(prop);
  }
  prop.setValue(time);
  if (zone?.kind === "zoned") prop.setParameter("tzid", zone.tzid);
  else prop.removeParameter("tzid");
}

/** How a timed bound is shown in a refusal: clock time for a floating one, an instant otherwise. */
function shown(ms: number, zone: WriteZone): string {
  const iso = new Date(ms).toISOString();
  return zone.kind === "floating" ? iso.slice(0, 19) : iso;
}

/** Set, or with `""` remove, the text fields the patch names on `vevent`. */
function patchText(vevent: ICAL.Component, patch: EventPatch): void {
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
 * The text fields are set as given, the time by {@link patchTimes}, and the
 * VEVENT's revision is stamped. Throws {@link ToolRefusal} ending in
 * `nothingDone` for a patch that cannot be applied as asked.
 */
export function applyEventPatch(
  parsed: ParsedCalendar,
  uid: string,
  patch: EventPatch,
  nothingDone: string,
  now: Date = new Date()
): EditResult {
  const { vcal } = parsed;
  const { master } = seriesFor(vcal, uid);
  if (master === undefined) {
    throw new Error(`applyEventPatch: no main VEVENT for UID ${uid}`);
  }
  patchText(master, patch);
  if (touchesTime(patch)) patchTimes(master, patch, nothingDone);
  const sequence = stampRevision(master, now);
  return { ics: vcal.toString(), mark: { uid, sequence } };
}

/**
 * The time `occurrence` started at, as a value for a RECURRENCE-ID or an
 * EXDATE beside `master`: its clock fields (as `findOccurrence` handed them
 * back) in the zone object of the master's own DTSTART, so it is written in
 * the master's value type and zone (spec 2026-09-29 §2.3) — a date for an
 * all-day series, `TZID=…` local time for a zoned one, `…Z` for a UTC one,
 * and clock time for a floating one. Nothing is converted: the fields are
 * the ones the recurrence rule produced.
 */
function originalStart(master: ICAL.Component, occurrence: FoundOccurrence): { time: ICAL.Time; tzid: string | null } {
  const startProp = master.getFirstProperty("dtstart") as ICAL.Property;
  const start = startProp.getFirstValue() as ICAL.Time;
  const time = ICAL.Time.fromData({ ...occurrence.wall, isDate: occurrence.isDate }, start.zone);
  const tzid = startProp.getParameter("tzid");
  return { time, tzid: occurrence.isDate || tzid === undefined ? null : String(tzid) };
}

/** A property `name` holding `time`, with `tzid` when it has one. */
function timeProperty(name: string, time: ICAL.Time, tzid: string | null): ICAL.Property {
  const prop = new ICAL.Property(name);
  prop.setValue(time);
  if (tzid !== null) prop.setParameter("tzid", tzid);
  return prop;
}

/**
 * A new override VEVENT for `occurrence`, made from `master` (spec §2.3): a
 * copy of it — so VALARM, ATTENDEE with its parameters, ORGANIZER and every
 * X- property come along, as another client's override would carry them —
 * with RRULE, RDATE, EXDATE and EXRULE removed, `RECURRENCE-ID` set to the
 * occurrence's original start in the master's type and zone, and the
 * occurrence's own start and end: the start that RECURRENCE-ID names, and
 * the end `list_events` showed for it (the master's length added to the
 * start's clock, as ical.js expands it), in the start's zone. A DURATION
 * stays a DURATION. Its SEQUENCE starts at the master's; the edit then
 * raises it, so the override has a revision of its own.
 */
function overrideFrom(master: ICAL.Component, occurrence: FoundOccurrence): ICAL.Component {
  const copy = new ICAL.Component(structuredClone(master.toJSON()));
  for (const name of ["rrule", "rdate", "exdate", "exrule"]) copy.removeAllProperties(name);
  const { time, tzid } = originalStart(master, occurrence);
  const start = copy.getFirstProperty("dtstart") as ICAL.Property;
  start.setValue(time.clone());
  copy.addProperty(timeProperty("recurrence-id", time.clone(), tzid));
  const end = copy.getFirstProperty("dtend");
  if (end !== null) {
    const until = time.clone();
    until.addDuration(new ICAL.Event(master).duration);
    end.setValue(until);
    if (tzid === null) end.removeParameter("tzid");
    else end.setParameter("tzid", tzid);
  }
  copy.updatePropertyWithValue("sequence", sequenceOf(master));
  return copy;
}

/** True when `master` (absent for an object that holds only overrides) is an all-day series, as `list_events` keys it. */
function allDaySeries(master: ICAL.Component | undefined): boolean {
  return (master?.getFirstPropertyValue("dtstart") as ICAL.Time | null | undefined)?.isDate === true;
}

/**
 * Change one occurrence of `uid`'s series (#206, spec 2026-09-29 §2.3), the
 * one `findOccurrence` (src/ical-expand.ts) found in the same stored text
 * `parsed` was read from.
 *
 * The occurrence's override VEVENT is edited if it has one — the current
 * one, of several revisions — and otherwise one is made from the master
 * ({@link overrideFrom}) and added to the object. Either way the patch is
 * applied to the override alone, with the time logic the main event gets
 * ({@link patchTimes}), and its revision stamped; the master and every other
 * override are left exactly as they were. An object with no master (an
 * invitation to one instance, #211.3) is edited the same way.
 *
 * Refused, ending in `nothingDone`: switching one occurrence between all-day
 * and timed — it keeps the form of its series, whose RECURRENCE-ID must
 * match the master's — and whatever {@link patchTimes} refuses.
 */
export function applyOccurrencePatch(
  parsed: ParsedCalendar,
  uid: string,
  occurrence: FoundOccurrence,
  patch: EventPatch,
  nothingDone: string,
  now: Date = new Date()
): EditResult {
  const { vcal } = parsed;
  if (patch.allDay !== undefined && patch.allDay !== occurrence.isDate) {
    throw new ToolRefusal(
      `One occurrence of a series cannot be switched between all-day and timed: it keeps the form of its series. ${nothingDone}`
    );
  }
  const { master } = seriesFor(vcal, uid);
  let target: ICAL.Component;
  if (occurrence.current !== null) {
    target = vcal.getAllSubcomponents("vevent")[occurrence.current];
    if (target === undefined || String(target.getFirstPropertyValue("uid")) !== uid) {
      throw new Error(`applyOccurrencePatch: VEVENT ${occurrence.current} is not an override of ${uid}`);
    }
  } else {
    if (master === undefined) throw new Error(`applyOccurrencePatch: no main VEVENT for UID ${uid} to copy`);
    target = overrideFrom(master, occurrence);
    vcal.addSubcomponent(target);
  }
  patchText(target, patch);
  if (touchesTime(patch)) patchTimes(target, patch, nothingDone);
  const sequence = stampRevision(target, now);
  const override = keyOf(new ICAL.Event(target).recurrenceId, allDaySeries(master));
  return { ics: vcal.toString(), mark: { uid, sequence, override } };
}

/**
 * Delete one occurrence of `uid`'s series (#206, spec §2.3), the one
 * `findOccurrence` found: an `EXDATE` for it on the master, in the master's
 * value type and zone ({@link originalStart}), every override of it removed,
 * and the master's revision stamped. The object itself is kept even when this
 * was the series' last occurrence; `seriesEmpty` says so, for the answer.
 *
 * An object with no master has no series to exclude from: the occurrence's
 * overrides are removed and nothing else. It is the caller's to delete the
 * object outright when that leaves it empty, and the result then has no
 * mark to read back by (`mark: null`), since no VEVENT left was written.
 * `nothingDone` ends the refusals this may grow; there are none today.
 */
export function excludeOccurrence(
  parsed: ParsedCalendar,
  uid: string,
  occurrence: FoundOccurrence,
  nothingDone: string,
  now: Date = new Date()
): EditResult & { seriesEmpty: boolean } {
  void nothingDone;
  const { vcal } = parsed;
  const { master } = seriesFor(vcal, uid);
  const vevents = vcal.getAllSubcomponents("vevent");
  for (const index of occurrence.overrides) vcal.removeSubcomponent(vevents[index]);
  const seriesEmpty = !occurrence.others;
  if (master === undefined) return { ics: vcal.toString(), mark: null, seriesEmpty };
  const { time, tzid } = originalStart(master, occurrence);
  master.addProperty(timeProperty("exdate", time, tzid));
  const sequence = stampRevision(master, now);
  return { ics: vcal.toString(), mark: { uid, sequence }, seriesEmpty };
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
    // A VTIMEZONE this connector generated follows the new times; any
    // other is left byte for byte (review of #224).
    const vcal = vevent.parent;
    for (const zone of new Set([startZone, endZone])) {
      if (zone.kind === "zoned" && zone.generated === true && vcal) coverGeneratedVtimezone(vcal, zone.tzid);
    }
  }
  vevent.removeAllProperties("duration");
}
