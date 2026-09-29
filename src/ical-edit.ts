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
 * Apply `patch` to the main VEVENT of `uid` and return the new object.
 *
 * Throws {@link ToolRefusal} for a patch that cannot be applied as asked —
 * an end that is not after the start, or an all-day switch without both
 * bounds. The caller has already established that the UID is present.
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
    let end: string;
    if (allDay) {
      const oldStart = event.startDate.toString().slice(0, 10);
      const oldEnd = event.endDate.toString().slice(0, 10);
      start = patch.start ?? oldStart;
      end =
        patch.end ??
        (patch.start !== undefined
          ? isoDate(dateMs(start) + (dateMs(oldEnd) - dateMs(oldStart)))
          : oldEnd);
      if (dateMs(end) <= dateMs(start)) {
        throw new ToolRefusal(
          `The event would end (${end}) on or before it starts (${start}). For an all-day event the end date is exclusive. Nothing was changed.`
        );
      }
    } else {
      const oldStart = event.startDate.toJSDate().getTime();
      const oldEnd = event.endDate.toJSDate().getTime();
      const startMs = patch.start !== undefined ? Date.parse(patch.start) : oldStart;
      const endMs =
        patch.end !== undefined
          ? Date.parse(patch.end)
          : patch.start !== undefined
            ? startMs + (oldEnd - oldStart)
            : oldEnd;
      start = new Date(startMs).toISOString();
      end = new Date(endMs).toISOString();
      if (endMs <= startMs) {
        throw new ToolRefusal(
          `The event would end (${end}) at or before it starts (${start}). Nothing was changed.`
        );
      }
    }

    master.removeAllProperties("dtstart");
    master.removeAllProperties("dtend");
    master.removeAllProperties("duration");
    master.updatePropertyWithValue("dtstart", icalTimeFor(start, allDay));
    master.updatePropertyWithValue("dtend", icalTimeFor(end, allDay));
  }

  const sequence = Number(master.getFirstPropertyValue("sequence") ?? 0);
  master.updatePropertyWithValue("sequence", (Number.isFinite(sequence) ? sequence : 0) + 1);
  const stamp = ICAL.Time.fromJSDate(now, true);
  master.updatePropertyWithValue("dtstamp", stamp);
  master.updatePropertyWithValue("last-modified", stamp);

  return vcal.toString();
}
