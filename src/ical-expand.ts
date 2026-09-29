/**
 * A stored iCalendar object turned into the instances `list_events` reports:
 * recurrence expanded here, in the connector, instead of on the CalDAV server
 * (spec 2026-09-29 §2.2). No network access: `CalDavClient` fetches the
 * objects with a plain time-range query and hands each one to
 * {@link expandObject}.
 *
 * Why not the server, as before: writing the spec against Radicale 3.8.1
 * found three ordinary shapes its `<C:expand>` fails on, and a failed expand
 * takes down the whole REPORT — every event in the calendar, not just the
 * one it choked on (§0.1):
 *
 *   - **R1**, an all-day weekly series: Radicale writes `RECURRENCE-ID:20261001`
 *     without `VALUE=DATE`, and ical.js throws `invalid date-time value` on it;
 *   - **R2**, a floating weekly series: Radicale answers 500;
 *   - **R3**, an override with no master (an invitation to one instance of
 *     someone else's series): Radicale answers 400.
 *
 * A time-range query with no `expand` returns every object with an occurrence
 * in the window, all three included (R4). Expanding here also means one
 * object that cannot be read costs only itself: it is left out and named, with
 * the reason, in `skipped` (#211.2), and the rest of the calendar is listed.
 *
 * Expansion is ical.js's: RRULE, RDATE, EXDATE and the override VEVENTs, with
 * `RANGE=THISANDFUTURE` honoured. Zones come from src/ical-zones.ts, so a TZID
 * the object carries no VTIMEZONE for is placed through `Intl` (R6), and one
 * that cannot be placed skips the object rather than reading as floating.
 *
 * Two bounds keep a rule that never ends from pinning the CPU:
 * {@link MAX_OCCURRENCES_PER_OBJECT} instances inside the window, and
 * {@link MAX_STEPS_PER_OBJECT} steps of the rule in all, counting those
 * walked before the window starts — a `FREQ=MINUTELY` rule from years ago is
 * millions of steps short of today. Hitting either is said in `skipped`.
 *
 * What a later change builds on: {@link occurrencesIn} is the expansion with
 * the ical.js values still attached, and {@link reportedTime} is the one place
 * a time becomes the string `list_events` hands out. Addressing one
 * occurrence (#206, spec §2.3) matches a caller's `recurrence_id` against
 * `reportedTime(occurrence.recurrenceId)` from the same expansion — matched,
 * never constructed.
 */

import ICAL from "ical.js";
import { isFloating, withResolvedZones, zoneNameOf } from "./ical-zones.js";

/** Instances listed per object and window before the rest are cut off (spec §2.2). */
export const MAX_OCCURRENCES_PER_OBJECT = 1000;

/**
 * Steps of a recurrence rule walked per object, inside the window or before
 * it, before giving up. ical.js walks a rule from its DTSTART, at roughly
 * 10 µs a step: a daily series begun in 1990 is about 13,000 steps from today,
 * an hourly one begun in 2021 about 50,000. A minutely one begun then is
 * millions, and is given up on after about half a second.
 */
export const MAX_STEPS_PER_OBJECT = 50_000;

export interface CalendarEvent {
  uid: string;
  url: string;
  summary: string | null;
  description: string | null;
  location: string | null;
  /**
   * An ISO instant in UTC for a timed event in a zone; a clock time with no
   * offset (`2026-10-01T09:00:00`) for a floating one; `YYYY-MM-DD` for an
   * all-day one. See {@link reportedTime}.
   */
  start: string;
  /** As `start`. For an all-day event, the day after the last one (exclusive). */
  end: string;
  allDay: boolean;
  /** The IANA name, `"UTC"`, or `"floating"` (spec §2.5); `"floating"` for all-day. */
  timezone: string;
  /** `TRANSP:TRANSPARENT`: the event does not block time (spec §3.1). */
  transparent: boolean;
  organizer: string | null;
  attendees: string[];
  status: string | null;
  /**
   * The original start of this occurrence of a series, in the same form as
   * `start` — so `YYYY-MM-DD` for an all-day series, never a midnight in the
   * process's zone (spec §2.3). Null for an event that does not recur.
   */
  recurrenceId: string | null;
  /**
   * The stored object's ETag exactly as the server sent it, quotes included,
   * or null when it sent none. What `update_event` and `delete_event` take as
   * `etag` (#152, #153). Instances expanded from one series share it.
   */
  etag: string | null;
}

/** A window in epoch milliseconds: start inclusive, end exclusive. */
export interface ExpandWindow {
  start: number;
  end: number;
}

export interface ExpandOptions {
  /** The object's URL, copied onto every instance. */
  url: string;
  etag: string | null;
  /** Overrides {@link MAX_OCCURRENCES_PER_OBJECT}; for tests. */
  cap?: number;
}

export interface ExpandResult {
  instances: CalendarEvent[];
  /**
   * Why the object was left out, or cut short. `CalDavClient` reports it
   * as `{ url, reason }` beside the events.
   */
  skipped?: string;
}

/** One occurrence, with the ical.js values it came from. */
export interface Occurrence {
  uid: string;
  /** The original start, for an occurrence of a series; null otherwise. */
  recurrenceId: ICAL.Time | null;
  start: ICAL.Time;
  end: ICAL.Time;
  /** The VEVENT the occurrence's properties come from: an override, or the master. */
  vevent: ICAL.Component;
}

/**
 * The instant a time names, in epoch ms. A floating time or a date has none,
 * so it is read as if it were UTC — what RFC 4791 §9.9 does with one when the
 * calendar has no zone, and what the server's own time-range filter did.
 */
export function instantOf(time: ICAL.Time): number {
  return time.toUnixTime() * 1000;
}

/**
 * The string `list_events` hands out for a time: `YYYY-MM-DD` for a date, a
 * clock time with no offset for a floating time (spec §2.5 — adding one would
 * claim a zone the event does not have), and an ISO instant in UTC otherwise.
 */
export function reportedTime(time: ICAL.Time): string {
  if (time.isDate) return time.toString().slice(0, 10);
  if (isFloating(time)) return time.toString().slice(0, 19);
  return new Date(instantOf(time)).toISOString();
}

/**
 * {@link instantOf} for a string {@link reportedTime} produced, so events from
 * different objects sort, and count as busy, by the same rule. `Date.parse`
 * alone would read a floating clock time in the process's own zone.
 */
export function instantOfReported(reported: string): number {
  if (/^\d{4}-\d{2}-\d{2}$/.test(reported)) return Date.parse(`${reported}T00:00:00Z`);
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(reported)) return Date.parse(`${reported}Z`);
  return Date.parse(reported);
}

/** RFC 4791 §9.9: overlaps the window; a zero-length event must start inside it. */
function inWindow(start: ICAL.Time, end: ICAL.Time, window: ExpandWindow): boolean {
  const s = instantOf(start);
  const e = instantOf(end);
  if (e > s) return s < window.end && e > window.start;
  return s >= window.start && s < window.end;
}

/**
 * Every occurrence in `vcal` that overlaps `window`, earliest first, with at
 * most `cap` of them. `vcal` must have been through `withResolvedZones`.
 *
 * Per UID: a master that does not recur is one occurrence; a master that does
 * is walked with its own overrides; overrides with no master (R3) are each an
 * occurrence of a series that lives elsewhere.
 *
 * An override is found wherever it moved. One moved into the window from an
 * earlier occurrence is met on the walk; one moved in from an occurrence after
 * the window is picked up once the walk stops there; one moved out is left out.
 */
export function occurrencesIn(
  vcal: ICAL.Component,
  window: ExpandWindow,
  cap: number = MAX_OCCURRENCES_PER_OBJECT
): { occurrences: Occurrence[]; truncated: boolean; gaveUp: boolean } {
  const byUid = new Map<string, ICAL.Component[]>();
  for (const ve of vcal.getAllSubcomponents("vevent")) {
    const uid = String(ve.getFirstPropertyValue("uid") ?? "");
    byUid.set(uid, [...(byUid.get(uid) ?? []), ve]);
  }

  const found: Occurrence[] = [];
  let truncated = false;
  let gaveUp = false;
  const add = (o: Occurrence): boolean => {
    if (!inWindow(o.start, o.end, window)) return true;
    if (found.length >= cap) {
      truncated = true;
      return false;
    }
    found.push(o);
    return true;
  };

  for (const [uid, vevents] of byUid) {
    const master = vevents.find((ve) => !ve.hasProperty("recurrence-id"));
    const overrides = vevents.filter((ve) => ve.hasProperty("recurrence-id"));

    if (master === undefined) {
      for (const ve of overrides) {
        const event = new ICAL.Event(ve);
        if (!add({ uid, recurrenceId: event.recurrenceId, start: event.startDate, end: event.endDate, vevent: ve })) break;
      }
      continue;
    }

    // `exceptions` given explicitly: left to itself, ical.js relates every
    // override in the object to the master, whatever its UID.
    const event = new ICAL.Event(master, { exceptions: overrides });
    if (!event.isRecurring()) {
      add({ uid, recurrenceId: null, start: event.startDate, end: event.endDate, vevent: master });
      continue;
    }

    const iterator = event.iterator();
    const met = new Set<ICAL.Component>();
    // Walking up to the window is most of the work for an old series; an
    // occurrence that ends well before it, with no override to move it, is
    // passed over without asking ical.js for its details. A day of margin
    // covers a length that a DST change stretches.
    const lengthMs = event.duration.toSeconds() * 1000;
    const passOver = overrides.length === 0 ? window.start - lengthMs - 86_400_000 : -Infinity;
    let steps = 0;
    let reachedWindowEnd = false;
    for (let next = iterator.next(); next; next = iterator.next()) {
      if (++steps > MAX_STEPS_PER_OBJECT) {
        gaveUp = true;
        break;
      }
      const at = instantOf(next);
      if (at < passOver) continue;
      if (at >= window.end) {
        reachedWindowEnd = true;
        break;
      }
      const details = event.getOccurrenceDetails(next);
      const vevent = details.item.component;
      met.add(vevent);
      if (!add({ uid, recurrenceId: next.clone(), start: details.startDate, end: details.endDate, vevent })) break;
    }
    if (reachedWindowEnd && !truncated) {
      for (const ve of overrides) {
        if (met.has(ve)) continue;
        const moved = new ICAL.Event(ve);
        if (instantOf(moved.recurrenceId) < window.end) continue;
        if (!add({ uid, recurrenceId: moved.recurrenceId, start: moved.startDate, end: moved.endDate, vevent: ve })) break;
      }
    }
  }

  found.sort((a, b) => instantOf(a.start) - instantOf(b.start));
  return { occurrences: found, truncated, gaveUp };
}

/** An error's message, on one line and bounded, for `skipped`. */
function reasonFrom(err: unknown): string {
  const message = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ").trim();
  return message.length > 200 ? `${message.slice(0, 199)}…` : message;
}

function toInstance(o: Occurrence, opts: ExpandOptions): CalendarEvent {
  const ve = o.vevent;
  const text = (name: string): string | null => {
    const value = ve.getFirstPropertyValue(name);
    return value === null || value === undefined ? null : String(value);
  };
  return {
    uid: o.uid,
    url: opts.url,
    summary: text("summary"),
    description: text("description"),
    location: text("location"),
    start: reportedTime(o.start),
    end: reportedTime(o.end),
    allDay: o.start.isDate,
    timezone: zoneNameOf(o.start),
    transparent: text("transp")?.toUpperCase() === "TRANSPARENT",
    organizer: text("organizer"),
    attendees: ve.getAllProperties("attendee").map((p) => String(p.getFirstValue())),
    status: text("status"),
    recurrenceId: o.recurrenceId === null ? null : reportedTime(o.recurrenceId),
    etag: opts.etag,
  };
}

/**
 * The instances of one stored object that overlap `window`. Never throws for
 * anything in `ics`: an object it cannot read comes back with no instances
 * and the reason in `skipped`.
 */
export function expandObject(ics: string, window: ExpandWindow, opts: ExpandOptions): ExpandResult {
  let vcal: ICAL.Component;
  try {
    vcal = new ICAL.Component(ICAL.parse(ics));
  } catch (err) {
    return { instances: [], skipped: `The stored object could not be read as iCalendar: ${reasonFrom(err)}` };
  }
  try {
    const { unresolved } = withResolvedZones(vcal);
    if (unresolved.length > 0) {
      const names = unresolved.map((tzid) => `"${tzid}"`).join(", ");
      return {
        instances: [],
        skipped: `Its time zone ${names} has no VTIMEZONE in the object and is not an IANA time zone, so its times cannot be placed.`,
      };
    }
    const cap = opts.cap ?? MAX_OCCURRENCES_PER_OBJECT;
    const { occurrences, truncated, gaveUp } = occurrencesIn(vcal, window, cap);
    const instances = occurrences.map((o) => toInstance(o, opts));
    if (truncated) {
      return {
        instances,
        skipped: `It recurs more than ${cap} occurrences in this window; only the first ${cap} are listed. Ask for a shorter window to see the rest.`,
      };
    }
    if (gaveUp) {
      return {
        instances,
        skipped: `Its recurrence rule was walked ${MAX_STEPS_PER_OBJECT} steps from its start and still had not reached the end of this window, so the connector gave up on it. Occurrences after that point are not listed.`,
      };
    }
    return { instances };
  } catch (err) {
    return { instances: [], skipped: `The stored object could not be read as a calendar event: ${reasonFrom(err)}` };
  }
}
