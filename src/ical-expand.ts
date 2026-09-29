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
 * Neither bound can stop ical.js inside one step, and it can stay there for
 * ever: `RecurIterator.next` gives up on a rule that matches nothing only for
 * MONTHLY and YEARLY (review of #223). {@link impossibleRule} refuses the
 * common such rule before it is walked; the guarantee is that nothing here
 * runs on the connector's own thread in production — `CalDavClient` calls
 * {@link expandObject} through src/ical-worker-pool.ts, which stops a worker
 * at its deadline. This module stays synchronous and pure, so the unit tests
 * call it directly.
 *
 * Overrides are matched to occurrences here, by instant (by date for an
 * all-day series), not by ical.js, which compares the text of a
 * RECURRENCE-ID and so lost an override written in another zone or as a
 * midnight DATE-TIME; one that matches nothing the walk met is listed at its
 * own time (see {@link occurrencesIn}).
 *
 * What a later change builds on: {@link occurrencesIn} is the expansion with
 * the ical.js values still attached, and {@link reportedTime} is the one place
 * a time becomes the string `list_events` hands out. Addressing one
 * occurrence (#206, spec §2.3) matches a caller's `recurrence_id` against
 * `reportedTime(occurrence.recurrenceId)` from the same expansion — matched,
 * never constructed — and, since it walks the rule, runs as an operation of
 * src/ical-worker-ops.ts, never on the calling thread.
 */

import ICAL from "ical.js";
import { parseCalendar, seriesIn, type ParsedCalendar } from "./ical-parse.js";
import { isFloating, zoneNameOf } from "./ical-zones.js";

/** Instances listed per object and window before the rest are cut off (spec §2.2). */
export const MAX_OCCURRENCES_PER_OBJECT = 1000;

/**
 * Steps of a recurrence rule walked per object, inside the window or before
 * it, before giving up. ical.js walks a rule from its DTSTART, at roughly
 * 12 µs a step in UTC and 15–22 µs in a zone (a VTIMEZONE, or `Intl` since
 * its offsets are remembered): a daily series begun in 1990 is about 13,000
 * steps from today, an hourly one begun in 2021 about 50,000. A minutely one
 * begun then is millions, and is given up on after 0.6–1.1 s. Counted between
 * `next()` calls, so it cannot stop a rule stuck inside one; the worker's
 * deadline does (src/ical-worker-pool.ts).
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

/**
 * A stored object as `CalDavClient` fetched it: what src/ical-worker-pool.ts
 * expands, and knows an object that timed out by (its URL and ETag).
 */
export interface StoredObject {
  url: string;
  etag: string | null;
  data: string;
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

/** The most days each month can have, February's in a leap year. */
const LONGEST_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/**
 * Why `recur` can never match a date, or null when it can — checked before a
 * rule is walked, because ical.js cannot be trusted to find out by walking it.
 *
 * `RecurIterator.next` gives up on a rule that matches nothing only for
 * MONTHLY and YEARLY. For DAILY, HOURLY, MINUTELY and SECONDLY it keeps
 * stepping inside one `next()` call for ever, so {@link MAX_STEPS_PER_OBJECT},
 * which counts `next()` calls, never gets a say: `FREQ=DAILY;BYMONTH=2;
 * BYMONTHDAY=30` froze the whole connector (review of #223). An invitation
 * a server files on its own is enough to plant one.
 *
 * This is the cheap answer to the common shape — a day of the month that none
 * of the months given has — and nothing more. The guarantee is the deadline
 * src/ical-worker-pool.ts runs every expansion under, which also catches the
 * shapes this does not (`BYWEEKNO=1;BYMONTH=6`), and a rule that does match
 * but so rarely that one `next()` walks for minutes.
 *
 * @internal Exported for its unit tests; {@link occurrencesIn} is its one caller.
 */
export function impossibleRule(recur: ICAL.Recur): string | null {
  const months = recur.parts.BYMONTH;
  const days = recur.parts.BYMONTHDAY;
  if (months === undefined || months.length === 0 || days === undefined || days.length === 0) return null;
  const longest = Math.max(...months.map((m) => LONGEST_MONTH[m - 1] ?? 0));
  if (days.some((d) => d !== 0 && Math.abs(d) <= longest)) return null;
  return `BYMONTHDAY=${days.join(",")} is a day none of BYMONTH=${months.join(",")} has`;
}

/**
 * What an occurrence of a series is matched by: the date for an all-day
 * series (or a DATE value), and the instant otherwise. ical.js matches an
 * override to an occurrence by the text of its RECURRENCE-ID, wall clock or
 * UTC, so one written in another zone, or as a midnight DATE-TIME for an
 * all-day series, matched nothing — and the master's occurrence was listed at
 * the old time while the override vanished (review of #223).
 */
function keyOf(time: ICAL.Time, allDay: boolean): string {
  if (allDay || time.isDate) return `${time.year}-${time.month}-${time.day}`;
  return String(instantOf(time));
}

/** An override VEVENT with the one ICAL.Event read from it, built once and used for its key, times and all. */
interface Override {
  ve: ICAL.Component;
  event: ICAL.Event;
}

/** `SEQUENCE`, 0 when absent or unreadable (RFC 5545 §3.8.7.4). */
function sequenceOf(ve: ICAL.Component): number {
  const value = Number(ve.getFirstPropertyValue("sequence") ?? 0);
  return Number.isFinite(value) ? value : 0;
}

/**
 * The override that counts for each occurrence, by {@link keyOf} its
 * RECURRENCE-ID. Two overrides for one occurrence are two revisions of it,
 * and RFC 5545 §3.8.7.4 makes the one with the highest SEQUENCE current;
 * between equal ones the later in the object wins, as it did when ical.js
 * matched them. The others are dropped here, so none can come back as an
 * extra event the walk never met (review of #225: the first was kept, and the
 * newer one listed beside it as a phantom).
 */
function currentOverrides(overrides: ICAL.Component[], allDay: boolean): Map<string, Override> {
  const byKey = new Map<string, Override>();
  for (const ve of overrides) {
    const event = new ICAL.Event(ve);
    const key = keyOf(event.recurrenceId, allDay);
    const held = byKey.get(key);
    if (held === undefined || sequenceOf(ve) >= sequenceOf(held.ve)) byKey.set(key, { ve, event });
  }
  return byKey;
}

/** True for an override that also moves every later occurrence (`RANGE=THISANDFUTURE`). */
function modifiesFuture(ve: ICAL.Component): boolean {
  const range = ve.getFirstProperty("recurrence-id")?.getParameter("range");
  return typeof range === "string" && range.toUpperCase() === "THISANDFUTURE";
}

/**
 * Take `RDATE;VALUE=PERIOD` apart before ical.js sees it: its iterator expects
 * a time in every RDATE value and threw `time.toUnixTime is not a function` on
 * a period, which skipped the whole object. Each period's start becomes a
 * plain RDATE, in memory only, and the period is returned by the start's
 * {@link keyOf} so its occurrence can be given the period's own end.
 */
function periodsOf(master: ICAL.Component, allDay: boolean): Map<string, ICAL.Period> {
  const periods = new Map<string, ICAL.Period>();
  for (const prop of master.getAllProperties("rdate")) {
    const values = prop.getValues() as unknown[];
    if (!values.some((v) => v instanceof ICAL.Period)) continue;
    master.removeProperty(prop);
    for (const value of values) {
      const start = value instanceof ICAL.Period ? value.start : (value as ICAL.Time);
      if (value instanceof ICAL.Period) periods.set(keyOf(start, allDay), value);
      const plain = new ICAL.Property("rdate", master);
      plain.setValue(start);
      master.addProperty(plain);
    }
  }
  return periods;
}

/**
 * Every occurrence in `vcal` that overlaps `window`, earliest first, with at
 * most `cap` of them. `vcal` must have come from `parseCalendar`
 * (src/ical-parse.ts), which resolves its zones. The master VEVENTs in it are
 * changed in memory (an impossible RRULE dropped, a PERIOD RDATE split): it
 * is for reading, never for writing back.
 *
 * Per UID: a master is walked with its own overrides (one that does not recur
 * is one occurrence); overrides with no master (R3) are each an occurrence of
 * a series that lives elsewhere.
 *
 * An override replaces the occurrence whose start it names, matched by
 * {@link keyOf} here rather than by ical.js. One that replaces no occurrence
 * the walk met — moved in from after the window, its occurrence also in
 * EXDATE, or naming a start the series never had — is listed at its own
 * DTSTART when that is in the window: it is an event the organizer sent, and
 * dropping it was how overrides silently disappeared.
 *
 * Of two overrides for one occurrence only the current one counts — highest
 * SEQUENCE, then later in the object ({@link currentOverrides}) — and a
 * RECURRENCE-ID given as a DATE on a timed series matches by its day.
 *
 * `notes` says what was left out of the walk, for `skipped`: today, a rule
 * {@link impossibleRule} refused.
 */
export function occurrencesIn(
  vcal: ICAL.Component,
  window: ExpandWindow,
  cap: number = MAX_OCCURRENCES_PER_OBJECT
): { occurrences: Occurrence[]; truncated: boolean; gaveUp: boolean; notes: string[] } {
  const found: Occurrence[] = [];
  const notes: string[] = [];
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

  for (const [uid, { master, overrides }] of seriesIn(vcal)) {
    if (master === undefined) {
      for (const { ve, event } of currentOverrides(overrides, false).values()) {
        if (!add({ uid, recurrenceId: event.recurrenceId, start: event.startDate, end: event.endDate, vevent: ve })) break;
      }
      continue;
    }

    const recurs = master.hasProperty("rrule") || master.hasProperty("rdate");
    for (const prop of master.getAllProperties("rrule")) {
      const why = impossibleRule(prop.getFirstValue() as ICAL.Recur);
      if (why === null) continue;
      master.removeProperty(prop);
      notes.push(`Its recurrence rule can never match a date (${why}), so only its start and any RDATE are listed.`);
    }
    const allDay = (master.getFirstPropertyValue("dtstart") as ICAL.Time | null)?.isDate === true;
    const periods = periodsOf(master, allDay);

    // Only the RANGE=THISANDFUTURE overrides go to ical.js, for the shift they
    // make to every later occurrence; every exact match is made here, by
    // `keyOf`. Given none at all, ical.js relates every override in the
    // object to the master, whatever its UID.
    const event = new ICAL.Event(master, { exceptions: overrides.filter(modifiesFuture) });
    const byKey = currentOverrides(overrides, allDay);

    const iterator = event.iterator();
    const met = new Set<Override>();
    // Walking up to the window is most of the work for an old series; an
    // occurrence that ends well before it, with no override or period to
    // move or stretch it, is passed over without asking for its details. A
    // day of margin covers a length that a DST change stretches.
    const lengthMs = event.duration.toSeconds() * 1000;
    const passOver =
      overrides.length === 0 && periods.size === 0 ? window.start - lengthMs - 86_400_000 : -Infinity;
    let steps = 0;
    for (let next = iterator.next(); next; next = iterator.next()) {
      if (++steps > MAX_STEPS_PER_OBJECT) {
        gaveUp = true;
        break;
      }
      const at = instantOf(next);
      if (at < passOver) continue;
      if (at >= window.end) break;
      const recurrenceId = recurs ? next.clone() : null;
      const key = keyOf(next, allDay);
      let override = byKey.get(key);
      if (override === undefined && !allDay) {
        // A RECURRENCE-ID;VALUE=DATE on a timed series names a day, not an
        // instant: it replaces the first occurrence on that day the walk
        // meets, rather than matching nothing and doubling it.
        const onDate = byKey.get(keyOf(next, true));
        if (onDate !== undefined && !met.has(onDate)) override = onDate;
      }
      let occurrence: Occurrence;
      if (override !== undefined) {
        met.add(override);
        const moved = override.event;
        occurrence = { uid, recurrenceId, start: moved.startDate, end: moved.endDate, vevent: override.ve };
      } else {
        const details = event.getOccurrenceDetails(next);
        const period = periods.get(key);
        let end = details.endDate;
        if (period !== undefined && details.item.component === master) {
          if (period.end) {
            end = period.end;
          } else {
            end = next.clone();
            end.addDuration(period.duration);
          }
        }
        occurrence = { uid, recurrenceId, start: details.startDate, end, vevent: details.item.component };
      }
      if (!add(occurrence)) break;
    }
    if (truncated) continue;
    for (const override of byKey.values()) {
      if (met.has(override)) continue;
      const { ve, event: own } = override;
      if (!add({ uid, recurrenceId: own.recurrenceId, start: own.startDate, end: own.endDate, vevent: ve })) break;
    }
  }

  found.sort((a, b) => instantOf(a.start) - instantOf(b.start));
  return { occurrences: found, truncated, gaveUp, notes };
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
  let parsed: ParsedCalendar;
  try {
    parsed = parseCalendar(ics);
  } catch (err) {
    return { instances: [], skipped: `The stored object could not be read as iCalendar: ${reasonFrom(err)}` };
  }
  try {
    const { vcal, unresolved } = parsed;
    if (unresolved.length > 0) {
      const names = unresolved.map((tzid) => `"${tzid}"`).join(", ");
      return {
        instances: [],
        skipped: `Its time zone ${names} has no VTIMEZONE in the object and is not an IANA time zone, so its times cannot be placed.`,
      };
    }
    const cap = opts.cap ?? MAX_OCCURRENCES_PER_OBJECT;
    const { occurrences, truncated, gaveUp, notes } = occurrencesIn(vcal, window, cap);
    const instances = occurrences.map((o) => toInstance(o, opts));
    const reasons = [...notes];
    if (truncated) {
      reasons.push(
        `It recurs more than ${cap} occurrences in this window; only the first ${cap} are listed. Ask for a shorter window to see the rest.`
      );
    }
    if (gaveUp) {
      reasons.push(
        `Its recurrence rule was walked ${MAX_STEPS_PER_OBJECT} steps from its start and still had not reached the end of this window, so the connector gave up on it. Occurrences after that point are not listed.`
      );
    }
    return reasons.length === 0 ? { instances } : { instances, skipped: reasons.join(" ") };
  } catch (err) {
    return { instances: [], skipped: `The stored object could not be read as a calendar event: ${reasonFrom(err)}` };
  }
}
