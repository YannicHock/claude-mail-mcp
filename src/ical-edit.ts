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
 */

import ICAL from "ical.js";
import { parseCalendar, seriesFor } from "./ical-parse.js";
import {
  hasOffset,
  msOf,
  readDateTime,
  timeIn,
  UTC_ZONE,
  writeZoneOf,
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
 * What the stored object is, for the checks that come before any write.
 *
 * `found` compares the UID exactly. The server-side lookup is a CalDAV
 * `text-match`, which RFC 4791 defines as a substring match, so the object it
 * hands back for `ev1` may be `ev10`'s. This is the check that catches it.
 */
export function describeStoredEvent(ics: string, uid: string): StoredEventShape {
  const { master, overrides } = seriesFor(parseCalendar(ics).vcal, uid);
  if (master === undefined && overrides.length === 0) {
    return { found: false, recurring: false, overrideOnly: false };
  }
  const recurring =
    overrides.length > 0 || master?.hasProperty("rrule") === true || master?.hasProperty("rdate") === true;
  return { found: true, recurring, overrideOnly: master === undefined };
}

/**
 * A VEVENT's SEQUENCE: absent, or not a number, counts as 0. The one reading
 * both {@link mainSequence} and {@link applyEventPatch} use (#214), because
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
 * floating time and a date.
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

/**
 * Apply `patch` to the main VEVENT of `uid` and return the new object.
 *
 * A new time is written in the zone the event was stored in (spec
 * 2026-09-29 §2.5, #208, #209): TZID local time for a zoned event — the
 * object's VTIMEZONE left byte for byte, and none added where it had none —
 * UTC for a UTC one, a date for an all-day one, and clock time for a floating
 * one. A switch from all-day to timed is written in UTC, as before.
 *
 * Throws {@link ToolRefusal} for a patch that cannot be applied as asked —
 * an end that is not after the start, an all-day switch without both bounds,
 * a date it cannot read, an offset for a floating event, or a one-sided time
 * change on an event whose TZID nothing can place. The caller has already
 * established that the UID is present.
 */
export function applyEventPatch(
  ics: string,
  uid: string,
  patch: EventPatch,
  now: Date = new Date()
): string {
  const nothingDone = "Nothing was changed.";
  const { vcal } = parseCalendar(ics);
  const { master } = seriesFor(vcal, uid);
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
      setTime(master, "dtstart", ICAL.Time.fromDateString(start), null);
      setTime(master, "dtend", ICAL.Time.fromDateString(end), null);
    } else {
      const startProp = master.getFirstProperty("dtstart");
      const endProp = master.getFirstProperty("dtend");
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
      const hadNoEnd = !wasAllDay && endProp === null && !master.hasProperty("duration");
      const oldStart = msOf(event.startDate);
      const startMs = patch.start !== undefined ? timedBound("start", patch.start, startZone, nothingDone) : oldStart;
      let endMs: number | undefined;
      if (patch.end !== undefined) endMs = timedBound("end", patch.end, endZone, nothingDone);
      else if (hadNoEnd) endMs = undefined;
      else {
        const oldEnd = msOf(event.endDate);
        endMs = patch.start !== undefined ? startMs + (oldEnd - oldStart) : oldEnd;
      }
      if (endMs !== undefined && endMs <= startMs) {
        throw new ToolRefusal(
          `The event would end (${shown(endMs, endZone)}) at or before it starts (${shown(startMs, startZone)}). ${nothingDone}`
        );
      }
      setTime(master, "dtstart", timeIn(startMs, startZone), startZone);
      if (endMs === undefined) master.removeAllProperties("dtend");
      else setTime(master, "dtend", timeIn(endMs, endZone), endZone);
    }
    master.removeAllProperties("duration");
  }

  master.updatePropertyWithValue("sequence", sequenceOf(master) + 1);
  const stamp = ICAL.Time.fromJSDate(now, true);
  master.updatePropertyWithValue("dtstamp", stamp);
  master.updatePropertyWithValue("last-modified", stamp);

  return vcal.toString();
}
