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
 */

import ICAL from "ical.js";
import { ToolRefusal } from "./tool-errors.js";

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

function veventsFor(vcal: ICAL.Component, uid: string): ICAL.Component[] {
  return vcal
    .getAllSubcomponents("vevent")
    .filter((ve) => ve.getFirstPropertyValue("uid") === uid);
}

function parse(ics: string): ICAL.Component {
  return new ICAL.Component(ICAL.parse(ics));
}

/**
 * What the stored object is, for the checks that come before any write.
 *
 * `found` compares the UID exactly. The server-side lookup is a CalDAV
 * `text-match`, which RFC 4791 defines as a substring match, so the object it
 * hands back for `ev1` may be `ev10`'s. This is the check that catches it.
 */
export function describeStoredEvent(ics: string, uid: string): StoredEventShape {
  const vevents = veventsFor(parse(ics), uid);
  if (vevents.length === 0) return { found: false, recurring: false };
  const recurring = vevents.some(
    (ve) =>
      ve.hasProperty("recurrence-id") || ve.hasProperty("rrule") || ve.hasProperty("rdate")
  );
  return { found: true, recurring };
}

/**
 * The ICAL value for a start or end, the way `create_event` has always written
 * it: a DATE for an all-day event, otherwise a UTC DATE-TIME (spec §2.4).
 */
export function icalTimeFor(iso: string, allDay: boolean): ICAL.Time {
  return allDay
    ? ICAL.Time.fromDateString(iso.slice(0, 10))
    : ICAL.Time.fromJSDate(new Date(iso), true);
}

/** Midnight UTC of the date part, so all-day arithmetic counts whole days. */
function dateMs(iso: string): number {
  return Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * A caller's timed bound as epoch ms, or a refusal. Unchecked, `Date.parse`
 * returns NaN and the RangeError that follows reaches the operator's log as a
 * server failure — the noise spec §4.5 exists to keep out of it.
 */
function instant(field: "start" | "end", value: string): number {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new ToolRefusal(
      `${field} "${value}" is not an ISO 8601 date-time, like 2026-10-01T09:00:00+02:00. Nothing was changed.`
    );
  }
  return ms;
}

/**
 * A caller's all-day bound as `YYYY-MM-DD`, or a refusal. The round trip
 * catches a date that parses but does not exist: `2026-13-45` would otherwise
 * roll over and be written as a date in 2027.
 */
function calendarDate(field: "start" | "end", value: string): string {
  const day = value.slice(0, 10);
  const ms = /^\d{4}-\d{2}-\d{2}$/.test(day) ? dateMs(day) : NaN;
  if (Number.isNaN(ms) || isoDate(ms) !== day) {
    throw new ToolRefusal(
      `${field} "${value}" is not a calendar date (YYYY-MM-DD) for an all-day event. Nothing was changed.`
    );
  }
  return day;
}

/** True when ical.js could not place a time on the clock (floating, or an unknown TZID). */
function unplaced(time: ICAL.Time): boolean {
  return !time.isDate && time.zone?.tzid === "floating";
}

/**
 * Apply `patch` to the main VEVENT of `uid` and return the new object.
 *
 * Throws {@link ToolRefusal} for a patch that cannot be applied as asked —
 * an end that is not after the start, an all-day switch without both bounds,
 * a date it cannot read, or a one-sided time change on an event whose stored
 * time it cannot place. The caller has already established that the UID is
 * present.
 */
export function applyEventPatch(
  ics: string,
  uid: string,
  patch: EventPatch,
  now: Date = new Date()
): string {
  const vcal = parse(ics);
  const master = veventsFor(vcal, uid).find((ve) => !ve.hasProperty("recurrence-id"));
  if (master === undefined) {
    throw new Error(`applyEventPatch: no main VEVENT for UID ${uid}`);
  }

  if (patch.summary !== undefined) master.updatePropertyWithValue("summary", patch.summary);
  for (const name of ["description", "location"] as const) {
    const value = patch[name];
    if (value === undefined) continue;
    if (value === "") master.removeAllProperties(name);
    else master.updatePropertyWithValue(name, value);
  }

  if (touchesTime(patch)) {
    const event = new ICAL.Event(master);
    const wasAllDay = Boolean(event.startDate.isDate);
    const allDay = patch.allDay ?? wasAllDay;
    if (allDay !== wasAllDay && (patch.start === undefined || patch.end === undefined)) {
      throw new ToolRefusal(
        "Switching an event between all-day and timed needs both start and end. Nothing was changed."
      );
    }

    let start: string;
    let end: string | undefined;
    if (allDay) {
      const oldStart = event.startDate.toString().slice(0, 10);
      const oldEnd = event.endDate.toString().slice(0, 10);
      start = patch.start !== undefined ? calendarDate("start", patch.start) : oldStart;
      end =
        patch.end !== undefined
          ? calendarDate("end", patch.end)
          : patch.start !== undefined
            ? isoDate(dateMs(start) + (dateMs(oldEnd) - dateMs(oldStart)))
            : oldEnd;
      if (dateMs(end) <= dateMs(start)) {
        throw new ToolRefusal(
          `The event would end (${end}) on or before it starts (${start}). For an all-day event the end date is exclusive. Nothing was changed.`
        );
      }
    } else {
      // A timed result that keeps one of the old bounds needs the old time as
      // an instant. ical.js can give it only when the zone is known: a floating
      // time, or a TZID with no VTIMEZONE in the object, comes back read as the
      // process's local time, and writing that back as UTC would move the
      // event by hours while reporting success (final review of #152).
      const keepsOldBound = patch.start === undefined || patch.end === undefined;
      if (keepsOldBound && !wasAllDay && (unplaced(event.startDate) || unplaced(event.endDate))) {
        throw new ToolRefusal(
          "This event's time is stored without a time zone this connector can resolve (a floating time, or a TZID with no VTIMEZONE), so changing only one end of it could shift it by hours. Nothing was changed. Pass both start and end to set its time outright."
        );
      }
      // RFC 5545 §3.6.1: a timed event with neither DTEND nor DURATION has no
      // length. Moving it keeps it that way rather than inventing an end —
      // and rather than refusing because the "old length" is zero.
      const hadNoEnd = !wasAllDay && !master.hasProperty("dtend") && !master.hasProperty("duration");
      const startMs = patch.start !== undefined ? instant("start", patch.start) : event.startDate.toJSDate().getTime();
      let endMs: number | undefined;
      if (patch.end !== undefined) endMs = instant("end", patch.end);
      else if (hadNoEnd) endMs = undefined;
      else {
        const oldStart = event.startDate.toJSDate().getTime();
        const oldEnd = event.endDate.toJSDate().getTime();
        endMs = patch.start !== undefined ? startMs + (oldEnd - oldStart) : oldEnd;
      }
      start = new Date(startMs).toISOString();
      end = endMs === undefined ? undefined : new Date(endMs).toISOString();
      if (endMs !== undefined && endMs <= startMs) {
        throw new ToolRefusal(
          `The event would end (${end}) at or before it starts (${start}). Nothing was changed.`
        );
      }
    }

    master.removeAllProperties("dtstart");
    master.removeAllProperties("dtend");
    master.removeAllProperties("duration");
    master.updatePropertyWithValue("dtstart", icalTimeFor(start, allDay));
    if (end !== undefined) master.updatePropertyWithValue("dtend", icalTimeFor(end, allDay));
  }

  const sequence = Number(master.getFirstPropertyValue("sequence") ?? 0);
  master.updatePropertyWithValue("sequence", (Number.isFinite(sequence) ? sequence : 0) + 1);
  const stamp = ICAL.Time.fromJSDate(now, true);
  master.updatePropertyWithValue("dtstamp", stamp);
  master.updatePropertyWithValue("last-modified", stamp);

  return vcal.toString();
}
