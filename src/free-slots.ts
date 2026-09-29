/**
 * Free time from busy time: the arithmetic behind `find_free_slot` (#213,
 * R14, spec 2026-09-29 §2.7). Pure — no network, no ical.js parsing — so the
 * unit tests call it directly: which events count as busy is
 * src/ical-busy.ts's question, answered in the worker pool, and what arrives
 * here is plain epoch milliseconds.
 *
 * **Working hours apply to every local day in the range** (the R14 fix). Until
 * v0.7.4 a free gap was clipped to the working hours of the one UTC day it
 * *started* on, so an empty calendar from Monday to Wednesday, 9–17, had one
 * slot — Monday's — and Tuesday and Wednesday were lost. Now the range is cut
 * into one window per local day, each `startHour`–`endHour` on that day's own
 * clock, and busy time is taken out of each window. Two windows that touch —
 * 0–24, where one day's midnight is the next one's — are one: a free 23:00 to
 * 00:30 is ninety minutes, not an hour and half an hour (review of PR #232).
 *
 * **In a zone, DST-correct.** Working hours used to be UTC hours, so a Berlin
 * user asking for 9–17 got 11–19 in summer. Each day's bounds are now the
 * instants 09:00 and 17:00 name *on that day* in the zone, through
 * {@link instantAt} (src/ical-zones.ts, `Intl` underneath): Berlin 9–17 is
 * 07:00–15:00Z on Friday 2026-10-23 and 08:00–16:00Z on Monday 2026-10-26,
 * with the change to winter time between them. A bound that falls in a
 * spring-forward gap is read by RFC 5545's rule, as every other wall time the
 * connector reads.
 *
 * **Slots are reported in that zone,** as ISO date-times with its offset
 * (`2026-10-23T09:00:00+02:00`), or `Z` for UTC, so a model reading them sees
 * the local clock time the user asked about and the instant at once.
 *
 * **Bounded** (review of PR #232). The work here is per local day and runs on
 * the main thread, outside the worker pool, so an unbounded range was an
 * unbounded stall: the years 0001–9999 with working hours held the event loop
 * for 72 seconds and answered three million slots. `find_free_slot` refuses a
 * range longer than {@link MAX_FREE_SLOT_RANGE_DAYS} before any request, and
 * reports at most {@link MAX_FREE_SLOTS} slots; {@link freeSlots} itself
 * stops at its `limit` rather than walking the rest of the range.
 */

import { addToWall, calendarZone, DAY_MS, instantAt, wallAt, zonedWriteZone, type WriteZone, type ZonedWall } from "./ical-zones.js";

/**
 * The longest range `find_free_slot` searches, in days of 24 hours: a year,
 * leap day included. A longer one is refused before any request — the
 * question it answers is "when this week, this month", and every day costs
 * main-thread work (see the module comment).
 */
export const MAX_FREE_SLOT_RANGE_DAYS = 366;

/** {@link MAX_FREE_SLOT_RANGE_DAYS} as a span of epoch milliseconds. */
export const MAX_FREE_SLOT_RANGE_MS = MAX_FREE_SLOT_RANGE_DAYS * DAY_MS;

/**
 * The most slots `find_free_slot` reports: the earliest ones, with
 * `truncated` set when there were more. A year of working days is about 260
 * slots, more than a model reads usefully; the first 200 answer "when".
 */
export const MAX_FREE_SLOTS = 200;

/** A span of time in epoch milliseconds: start inclusive, end exclusive. */
export interface BusyInterval {
  start: number;
  end: number;
}

/** One free slot, as `find_free_slot` answers it: ISO date-times with the working zone's offset. */
export interface FreeSlot {
  start: string;
  end: string;
}

/** The daily window slots are looked for in: whole hours on the working zone's clock, `endHour` 24 meaning midnight. */
export interface WorkingHours {
  startHour: number;
  endHour: number;
}

export interface FreeSlotOptions {
  /** Absent: the whole range is searched, nights and all. */
  workingHours?: WorkingHours;
  /**
   * The IANA zone (as `canonicalZone` spells it) the working hours are
   * clock hours in and the slots are reported in; `"UTC"` for UTC.
   */
  timezone: string;
  /**
   * Stop after this many slots, the earliest; absent, every one. The search
   * ends there, so a long range costs only as many days as it takes to find
   * them. Ask for one more than you will report to know whether there were
   * more.
   */
  limit?: number;
}

/**
 * The zone `find_free_slot` works in when the caller names none (spec §2.7):
 * the calendars' own when every one of them reports the same, and UTC
 * otherwise — one calendar with no zone (Radicale sets none, R13), two that
 * disagree, or none asked about at all. `reported` is each calendar's
 * `calendar-timezone` as tsdav hands it over; {@link calendarZone} reads both
 * forms a server sends, a bare id or a VCALENDAR with one VTIMEZONE.
 *
 * Guessing one zone out of two that disagree would place a day's working
 * hours wrong for half the calendars without saying so; UTC is at least the
 * zone the answer then names, so the model can ask again with `timezone`.
 */
export function workingZone(reported: readonly unknown[]): string {
  if (reported.length === 0) return "UTC";
  const zones = reported.map(calendarZone);
  const first = zones[0];
  if (first === null) return "UTC";
  return zones.every((z) => z === first) ? first : "UTC";
}

/**
 * Every gap in `busy` within `range` that is at least `durationMinutes` long
 * and, with working hours, inside them on its local day — earliest first, at
 * most `limit` of them. A gap is reported whole, not cut into
 * `durationMinutes` pieces: "free from 09:00 to 17:00" says more than sixteen
 * half hours do.
 *
 * `busy` may be in any order, overlap, and reach outside `range`; what is
 * outside is ignored. An interval with no length blocks nothing
 * ({@link mergeBusy}, the one place that rule lives).
 *
 * Slots are whole seconds, as calendar times are: the range is narrowed to
 * the whole seconds inside it, so a `range_start` of `09:00:00.500` gives a
 * slot from `09:00:01`, never one that starts before the range (review of
 * PR #232).
 */
export function freeSlots(
  busy: readonly BusyInterval[],
  range: BusyInterval,
  durationMinutes: number,
  { workingHours, timezone, limit = Infinity }: FreeSlotOptions
): FreeSlot[] {
  const zone = zonedWriteZone(timezone);
  const durationMs = durationMinutes * 60_000;
  const merged = mergeBusy(busy);
  const whole = { start: Math.ceil(range.start / 1000) * 1000, end: Math.floor(range.end / 1000) * 1000 };
  const free: FreeSlot[] = [];
  const found = (start: number, end: number): boolean => {
    free.push({ start: isoInZone(start, zone), end: isoInZone(end, zone) });
    return free.length >= limit;
  };
  if (limit <= 0) return free;
  for (const window of searchWindows(whole, zone, workingHours)) {
    let cursor = window.start;
    for (const b of merged) {
      if (b.end <= cursor) continue;
      if (b.start >= window.end) break;
      if (b.start - cursor >= durationMs && found(cursor, b.start)) return free;
      cursor = Math.max(cursor, b.end);
      if (cursor >= window.end) break;
    }
    if (window.end - cursor >= durationMs && found(cursor, window.end)) return free;
  }
  return free;
}

/** `busy` sorted, with overlapping and touching intervals joined, and empty ones dropped. */
function mergeBusy(busy: readonly BusyInterval[]): BusyInterval[] {
  const sorted = busy.filter((b) => b.end > b.start).sort((a, b) => a.start - b.start);
  const merged: BusyInterval[] = [];
  for (const b of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && b.start <= last.end) last.end = Math.max(last.end, b.end);
    else merged.push({ start: b.start, end: b.end });
  }
  return merged;
}

/**
 * The windows slots are looked for in: `range` itself without working hours;
 * with them, one per local day the range touches — that day's `startHour` to
 * `endHour` in `zone`, cut to the range — in order, none empty, and two that
 * touch joined into one (0–24: each day's midnight is the next one's start).
 *
 * A generator, so {@link freeSlots} stopping at its `limit` stops the walk
 * too. Days are stepped on the wall clock ({@link addToWall}), never by
 * adding 24 hours to an instant, which on the day of a DST change lands an
 * hour off.
 */
function* searchWindows(range: BusyInterval, zone: WriteZone, hours: WorkingHours | undefined): Generator<BusyInterval> {
  if (range.end <= range.start) return;
  if (hours === undefined) {
    yield range;
    return;
  }
  const first = wallAt(range.start, zone);
  let day: ZonedWall = { year: first.year, month: first.month, day: first.day, hour: 0, minute: 0, second: 0 };
  let pending: BusyInterval | null = null;
  for (;;) {
    const opens = instantAt({ ...day, hour: hours.startHour }, zone);
    if (opens >= range.end) break;
    const nextDay = addToWall(day, DAY_MS / 1000);
    const closes = hours.endHour >= 24 ? instantAt(nextDay, zone) : instantAt({ ...day, hour: hours.endHour }, zone);
    const start = Math.max(opens, range.start);
    const end = Math.min(closes, range.end);
    if (end > start) {
      if (pending !== null && start <= pending.end) {
        pending.end = Math.max(pending.end, end);
      } else {
        if (pending !== null) yield pending;
        pending = { start, end };
      }
    }
    day = nextDay;
  }
  if (pending !== null) yield pending;
}

/**
 * `ms` as an ISO date-time on `zone`'s clock with its offset at that instant
 * (`2026-10-26T09:00:00+01:00`), `+00:00` for a zone at UTC's offset, or `Z`
 * in UTC itself. Whole seconds — calendar times have no finer ones — and the
 * caller hands whole seconds in ({@link freeSlots} narrows its range to
 * them). The offset is the difference between the wall time {@link wallAt}
 * reads and the instant, so on the second pass through an autumn overlap it
 * is the later offset, as the clocks then show.
 */
function isoInZone(ms: number, zone: WriteZone): string {
  const whole = Math.floor(ms / 1000) * 1000;
  const wall = wallAt(whole, zone);
  const pad = (n: number, width = 2): string => String(n).padStart(width, "0");
  const clock = `${pad(wall.year, 4)}-${pad(wall.month)}-${pad(wall.day)}T${pad(wall.hour)}:${pad(wall.minute)}:${pad(wall.second)}`;
  if (zone.kind !== "zoned") return `${clock}Z`;
  // Not `Date.UTC`, which reads a year 0–99 as 1900–1999.
  const wallMs = new Date(0).setUTCFullYear(wall.year, wall.month - 1, wall.day) + ((wall.hour * 60 + wall.minute) * 60 + wall.second) * 1000;
  const offsetMinutes = Math.round((wallMs - whole) / 60_000);
  const sign = offsetMinutes < 0 ? "-" : "+";
  const abs = Math.abs(offsetMinutes);
  return `${clock}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}
