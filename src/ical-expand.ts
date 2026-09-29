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
 * own time (see {@link occurrencesIn}). The rules for that — the key an
 * occurrence is matched by, which of two overrides counts, which
 * `RANGE=THISANDFUTURE` override reaches an occurrence — live in
 * src/ical-series.ts, shared with the writers.
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
import { parseCalendar, seriesFor, seriesIn, type ParsedCalendar } from "./ical-parse.js";
import {
  allDaySeries,
  currentOverrides,
  governingRange,
  instantOf,
  keyOf,
  modifiesFuture,
  type Override,
} from "./ical-series.js";
import { hasOffset, isFloating, wallAt, wallOf, writeZoneOf, zoneNameOf, type ZonedWall } from "./ical-zones.js";

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
    const allDay = allDaySeries(master);
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

/**
 * One occurrence of a series, as {@link findOccurrence} found it: plain data
 * that crosses the worker boundary (src/ical-worker-ops.ts), which the write
 * on the main thread applies to its own parse of the same text.
 */
export interface FoundOccurrence {
  found: true;
  /** Its `recurrenceId` exactly as `list_events` reports it (see {@link reportedTime}). */
  recurrenceId: string;
  /**
   * Its original start's clock fields in the zone of the master's DTSTART —
   * the value a RECURRENCE-ID or EXDATE for it is written with, beside the
   * master's own TZID (spec §2.3). For an object with no master, those of
   * the override's own RECURRENCE-ID.
   */
  wall: ZonedWall;
  /** True for an occurrence of an all-day series: `wall` is a date. */
  isDate: boolean;
  /**
   * Every override VEVENT that replaces this occurrence, each revision of it
   * — indices into the object's VEVENTs in document order
   * (`vcal.getAllSubcomponents("vevent")`).
   */
  overrides: number[];
  /** The one of {@link overrides} that counts (highest SEQUENCE, then last), or null when it has none. */
  current: number | null;
  /** True when the series has an occurrence besides this one: false means deleting it leaves none. */
  others: boolean;
  /**
   * The `RANGE=THISANDFUTURE` override of an *earlier* occurrence whose
   * change reaches this one — its index, as for {@link overrides} — or null
   * when none does, or when this occurrence has an override of its own
   * (which then wins). `list_events` lists such an occurrence moved and
   * retitled by that override, so a new override for it is made from that
   * override, not the master (fix-pass review of PR #229).
   */
  range: number | null;
  /**
   * The series' next occurrence after this one, as the walk met it: null
   * when there is none, `"unknown"` when the walk stopped before finding out
   * or this occurrence is one the walk never met. What a write needs to
   * change the occurrence a `RANGE=THISANDFUTURE` override starts at alone:
   * that override moves on to the next one (src/ical-occurrence-edit.ts).
   */
  next: NextOccurrence | null | "unknown";
}

/** The occurrence after a {@link FoundOccurrence}: plain data, as that is. */
export interface NextOccurrence {
  /** Its original start's clock fields in the zone of the master's DTSTART, as {@link FoundOccurrence.wall}. */
  wall: ZonedWall;
  /** True when it has an override of its own. */
  overridden: boolean;
}

export type OccurrenceLookup = FoundOccurrence | { found: false; reason: string };

/** A time given as `list_events` gives it, reduced to what it names: a date, an instant, or a clock time. */
interface ReportedKey {
  kind: "date" | "instant" | "clock";
  /** Epoch ms; a date or a clock time read as if it were UTC. */
  ms: number;
}

/**
 * What a `recurrence_id` — or a {@link reportedTime} string — names, or null
 * for a string that is none of the three forms `list_events` hands out. Two
 * spellings of one instant (`…07:00:00Z`, `…09:00:00+02:00`) name the same
 * thing; a date and a midnight never do (spec §2.3, Review Focus 2).
 */
function reportedKey(value: string): ReportedKey | null {
  const text = value.trim();
  let key: ReportedKey | null = null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) key = { kind: "date", ms: Date.parse(`${text}T00:00:00Z`) };
  else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(text)) key = { kind: "clock", ms: Date.parse(`${text}Z`) };
  else if (/^\d{4}-\d{2}-\d{2}T/.test(text) && hasOffset(text)) key = { kind: "instant", ms: Date.parse(text) };
  return key === null || Number.isNaN(key.ms) ? null : key;
}

function sameKey(a: ReportedKey | null, b: ReportedKey): boolean {
  return a !== null && a.kind === b.kind && a.ms === b.ms;
}

/**
 * Find the occurrence of `uid`'s series that `recurrenceId` names — a worker
 * operation (src/ical-worker-ops.ts), since it walks the recurrence rule.
 *
 * **Matched, never constructed** (spec 2026-09-29 §2.3). The series is
 * expanded the way {@link occurrencesIn} expands it for `list_events`, and
 * the occurrence is the one whose `recurrenceId`, as {@link reportedTime}
 * reports it, names what the caller's does: the same instant however it is
 * written, the same date, or the same clock time for a floating series. A
 * date never matches a timed occurrence and an instant never an all-day one,
 * so an all-day series' `2026-10-08` round-trips as a date and is never read
 * as a midnight in some zone. What is handed back is the occurrence's own
 * start, as the rule produced it, in the master's zone — so a RECURRENCE-ID
 * or EXDATE written from it is in the master's value type and zone, and no
 * question of "which form does the stored DTSTART use" is ever answered by
 * converting strings.
 *
 * An override that replaces no occurrence the walk meets — one
 * `list_events` lists at its own time — is matched by its own RECURRENCE-ID.
 * An object with no master (an invitation to one instance, #211.3) is
 * matched against its overrides; there `recurrenceId` may be null, meaning
 * "its only occurrence", which is refused when it holds more than one.
 *
 * Beside the occurrence, it says what a write needs to keep a
 * `RANGE=THISANDFUTURE` override's change where `list_events` showed it:
 * which such override reaches this occurrence (`range`), and the series' next
 * occurrence (`next`), one step past the match.
 *
 * The walk is bounded like the expansion: {@link MAX_STEPS_PER_OBJECT} steps,
 * and never past a day or two beyond the instant asked for; a rule
 * {@link impossibleRule} refuses is not walked. Never throws for anything in
 * `ics`: every failure is `{ found: false, reason }`, a sentence the caller
 * ends with what was not done.
 */
export function findOccurrence(ics: string, uid: string, recurrenceId: string | null): OccurrenceLookup {
  try {
    return lookUpOccurrence(ics, uid, recurrenceId);
  } catch (err) {
    return { found: false, reason: `The stored event could not be read to find the occurrence: ${reasonFrom(err)}.` };
  }
}

/** The walk {@link findOccurrence} does, free to throw. */
function lookUpOccurrence(ics: string, uid: string, recurrenceId: string | null): OccurrenceLookup {
  const { vcal, unresolved } = parseCalendar(ics);
  if (unresolved.length > 0) {
    const names = unresolved.map((tzid) => `"${tzid}"`).join(", ");
    return { found: false, reason: `Its time zone ${names} has no VTIMEZONE in the event and is not an IANA time zone, so its occurrences cannot be placed.` };
  }
  const { master, overrides } = seriesFor(vcal, uid);
  const position = new Map(vcal.getAllSubcomponents("vevent").map((ve, i) => [ve, i] as const));
  const allDay = allDaySeries(master);
  const byKey = currentOverrides(overrides, allDay);
  /** Every revision of the override for `key`, by position. */
  const revisions = (key: string): number[] =>
    overrides.filter((ve) => keyOf(new ICAL.Event(ve).recurrenceId, allDay) === key).map((ve) => position.get(ve) as number);
  const want = recurrenceId === null ? null : reportedKey(recurrenceId);
  if (recurrenceId !== null && want === null) {
    return {
      found: false,
      reason: `"${recurrenceId}" is not a recurrence_id: list_events reports each occurrence's as an ISO instant (2026-10-08T07:00:00.000Z), as a clock time with no offset for a floating series, or as a date (YYYY-MM-DD) for an all-day one.`,
    };
  }
  const notAnOccurrence = (why: string): OccurrenceLookup => ({
    found: false,
    reason: `"${recurrenceId}" is not an occurrence of "${uid}": ${why} Pass a recurrenceId exactly as list_events reported it.`,
  });

  if (master === undefined) {
    const current = [...byKey.entries()];
    let hit: [string, Override] | undefined;
    if (want === null) {
      if (current.length !== 1) {
        return {
          found: false,
          reason: `"${uid}" holds ${current.length} occurrences of a series whose other occurrences are not in this calendar; pass the recurrence_id list_events reported for the one you mean.`,
        };
      }
      hit = current[0];
    } else {
      hit = current.find(([, o]) => sameKey(reportedKey(reportedTime(o.event.recurrenceId)), want));
      if (hit === undefined) return notAnOccurrence("the object holds no occurrence that starts then.");
    }
    const [key, { ve, event }] = hit;
    return {
      found: true,
      recurrenceId: reportedTime(event.recurrenceId),
      wall: wallOf(event.recurrenceId),
      isDate: event.recurrenceId.isDate,
      overrides: revisions(key),
      current: position.get(ve) as number,
      others: current.length > 1,
      range: null,
      next: "unknown",
    };
  }

  if (want === null) {
    return { found: false, reason: `"${uid}" is a recurring series: pass the recurrence_id list_events reported for the occurrence you mean.` };
  }
  if (!master.hasProperty("rrule") && !master.hasProperty("rdate") && overrides.length === 0) {
    return { found: false, reason: `"${uid}" does not recur, so it has no occurrence "${recurrenceId}". Omit recurrence_id to change the event itself.` };
  }

  // Walked as occurrencesIn walks it for list_events: an impossible rule
  // dropped, a PERIOD RDATE split, only RANGE=THISANDFUTURE given to ical.js.
  for (const prop of master.getAllProperties("rrule")) {
    if (impossibleRule(prop.getFirstValue() as ICAL.Recur) !== null) master.removeProperty(prop);
  }
  periodsOf(master, allDay);
  const startProp = master.getFirstProperty("dtstart") as ICAL.Property;
  const start = startProp.getFirstValue() as ICAL.Time;
  const startZone = writeZoneOf(startProp);
  const ranges = overrides.filter(modifiesFuture);
  const event = new ICAL.Event(master, { exceptions: ranges });
  const iterator = event.iterator();
  // Nothing more than a day or two past the instant asked for can be it; a
  // zone's offset is at most 14 hours.
  const limit = want.ms + 2 * 86_400_000;
  let match: ICAL.Time | null = null;
  // The occurrence right after the match: one step more, so that a write can
  // move a RANGE=THISANDFUTURE override on to it (`FoundOccurrence.next`).
  let following: ICAL.Time | null = null;
  let others = false;
  let steps = 0;
  let gaveUp = false;
  for (let next = iterator.next(); next; next = iterator.next()) {
    if (++steps > MAX_STEPS_PER_OBJECT) {
      gaveUp = true;
      break;
    }
    if (match === null && sameKey(reportedKey(reportedTime(next)), want)) {
      match = next.clone();
      continue;
    }
    others = true;
    if (match !== null) {
      following = next.clone();
      break;
    }
    if (instantOf(next) > limit) break;
  }
  /**
   * A time the rule produced, as clock fields in the master's zone. An RDATE
   * can be stored in another zone (UTC, typically); its clock time in the
   * master's zone is what a RECURRENCE-ID beside the master's TZID says.
   */
  const inSeriesZone = (time: ICAL.Time): ZonedWall =>
    time.isDate || time.zone === start.zone || startZone.kind === "unresolved" ? wallOf(time) : wallAt(instantOf(time), startZone);
  /** True when the occurrence at `time` has an override of its own, matched as {@link occurrencesIn} matches one. */
  const overridden = (time: ICAL.Time): boolean => byKey.has(keyOf(time, allDay)) || (!allDay && byKey.has(keyOf(time, true)));

  let wall: ZonedWall;
  let key: string;
  let reported: string;
  let isDate: boolean;
  let range: number | null = null;
  let next: NextOccurrence | null | "unknown" = "unknown";
  if (match !== null) {
    // The rule's own start, in the master's zone.
    wall = inSeriesZone(match);
    key = keyOf(match, allDay);
    if (!allDay && !byKey.has(key) && byKey.has(keyOf(match, true))) key = keyOf(match, true);
    reported = reportedTime(match);
    isDate = match.isDate;
    if (!byKey.has(key)) {
      const governing = governingRange(ranges, match);
      range = governing === undefined ? null : (position.get(governing) as number);
    }
    if (following !== null) next = { wall: inSeriesZone(following), overridden: overridden(following) };
    else if (!gaveUp) next = null;
  } else {
    // An override the walk never meets is listed at its own time, by its own
    // RECURRENCE-ID: that is what list_events reported for it.
    const orphan = [...byKey.entries()].find(([, o]) => sameKey(reportedKey(reportedTime(o.event.recurrenceId)), want));
    if (orphan === undefined) {
      if (gaveUp) {
        return {
          found: false,
          reason: `Its recurrence rule was walked ${MAX_STEPS_PER_OBJECT} steps from its start without reaching "${recurrenceId}", so the connector gave up looking for it.`,
        };
      }
      return notAnOccurrence(
        want.kind === "date" && !allDay
          ? "its occurrences have times, and a date names none of them."
          : want.kind !== "date" && allDay
            ? "it is an all-day series, whose occurrences are dates (YYYY-MM-DD)."
            : "no occurrence of the series starts then."
      );
    }
    const rid = orphan[1].event.recurrenceId;
    wall = inSeriesZone(rid);
    key = orphan[0];
    reported = reportedTime(rid);
    isDate = rid.isDate;
  }
  const current = byKey.get(key);
  // An override for another occurrence is an occurrence list_events lists too.
  if ([...byKey.keys()].some((k) => k !== key)) others = true;
  return {
    found: true,
    recurrenceId: reported,
    wall,
    isDate,
    overrides: revisions(key),
    current: current === undefined ? null : (position.get(current.ve) as number),
    others,
    range,
    next,
  };
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
