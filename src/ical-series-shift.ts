/**
 * A series moved to a new clock time or length, every occurrence keeping its
 * date (#207, spec 2026-09-29 §2.4, option A), for `update_event` with
 * `apply_to_series` and a new `start` or `end`. No network access, and no
 * recurrence rule walked: what moves is every value keyed to the old start
 * times — DTSTART and DTEND, EXDATE, RDATE, the overrides' RECURRENCE-IDs
 * and a DATE-TIME UNTIL — each by the same difference on the series' clock,
 * so the rule, walked later by the reader, meets them where it used to.
 *
 * The rules of src/ical-edit.ts hold here too — the stored object is edited
 * in place, never rebuilt; every refusal ends in the caller's `nothingDone`;
 * a written VEVENT has its revision stamped. Split out of src/ical-edit.ts in
 * the code-health review of PR #229, with its wall-clock helpers, which now
 * live in src/ical-zones.ts beside the rest of the clock arithmetic.
 */

import ICAL from "ical.js";
import { patchSeriesAttendees } from "./ical-attendees.js";
import {
  coverGenerated,
  mayNotifyOf,
  patchText,
  setTime,
  shown,
  stampRevision,
  withReadableZones,
  type EditContext,
  type EditResult,
  type EventPatch,
} from "./ical-edit.js";
import type { FoundOccurrence } from "./ical-expand.js";
import { calendarDate, dateMs, isoDate, timedBound } from "./ical-input.js";
import { seriesFor, type ParsedCalendar } from "./ical-parse.js";
import { keyOf } from "./ical-series.js";
import {
  addToWall,
  DAY_MS,
  clockSeconds,
  dayOf,
  instantAt,
  storedInstant,
  wallAt,
  wallOf,
  writeZoneOf,
  writtenTime,
  type WriteZone,
  type ZonedWall,
} from "./ical-zones.js";
import { ToolRefusal } from "./tool-refusal.js";

/** True when two zones are the same clock: both UTC, both floating, or one TZID. */
function sameClock(a: WriteZone | { kind: "unresolved"; tzid: string }, b: WriteZone): boolean {
  if (a.kind === "zoned" && b.kind === "zoned") return a.tzid === b.tzid;
  return a.kind === b.kind;
}

/** The sub-daily frequencies whose occurrence times are the rule's, not DTSTART's (spec §2.4). */
const SUB_DAILY = new Set(["HOURLY", "MINUTELY", "SECONDLY"]);

/**
 * Move a series to a new clock time and/or length, every occurrence keeping
 * its date (#207, spec 2026-09-29 §2.4, option A).
 *
 * `patch.start` and `patch.end` describe the new time of one occurrence: the
 * one `anchor` names — found by `findOccurrence` from the caller's
 * `recurrence_id` — or, with none, the series' first, its DTSTART. What is
 * applied to the series is the **difference in wall-clock time** between that
 * occurrence's original start and its new one, read in the series' own zone:
 * so a Berlin series at 09:00 moved to 15:00 is at 15:00 on both sides of the
 * change to winter time, never at 14:00 or 16:00 (Review Focus 1). With
 * `patch.end`, every occurrence takes the new length (elapsed time); without
 * it, each keeps its own.
 *
 * Everything keyed to the old start times moves with them, or it would
 * orphan (§0.1):
 *
 *   - DTSTART and DTEND (or DURATION, kept as a DURATION);
 *   - every EXDATE and RDATE, so each keeps naming the same occurrence;
 *   - every override's RECURRENCE-ID, and the override's own DTSTART/DTEND
 *     when they still equal its original occurrence (it only changed its
 *     text); an override that was rescheduled keeps its explicit time;
 *   - a DATE-TIME `UNTIL`, so the last occurrence survives. A DATE `UNTIL`
 *     and `COUNT` are left exactly as they are.
 *
 * A value in the series' own zone is moved on its clock, field by field — the
 * value the rule produces for each occurrence moves the same way, so the two
 * keep matching whatever the offset. One stored in another zone (a UTC EXDATE
 * on a Berlin series, say) is read as an instant, moved on the series' clock,
 * and written back in its own zone.
 *
 * Text fields in `patch` go to the master, as `apply_to_series` says, and
 * its attendee changes (#205) to the whole series through
 * `patchSeriesAttendees` (src/ical-attendees.ts), checked before anything
 * moves; `ctx.own` is the account's calendar user addresses, which only an
 * attendee change needs. The master and every override that moved or whose guest list
 * changed get a new revision — one, however many of the two reached it. A VTIMEZONE this
 * connector generated is regenerated to cover the series, to its UNTIL or ten
 * years on (`coverGenerated` in src/ical-edit.ts).
 *
 * Refused, each ending in `nothingDone`: a start on another *date* than the
 * occurrence it describes (the day of a series is its rule's, not its time);
 * a rule whose times are its own — a sub-daily FREQ, or BYHOUR, BYMINUTE or
 * BYSECOND — when the start moves; a switch between all-day and timed; an
 * end at or before the start; an offset for a floating series; a zone
 * nothing can place; and a VTIMEZONE whose observance rules this connector
 * will not walk on its own thread (`withReadableZones` in src/ical-edit.ts,
 * milestone review of v0.7.4). The answer's `mayNotify` is `mayNotifyOf`'s
 * (src/ical-edit.ts): for a meeting, whom the server may email about the
 * new time. "This and all following occurrences" is not this
 * function's: it would be a new series (§2.4 C, out of v0.7.4).
 */
export function shiftSeries(
  parsed: ParsedCalendar,
  uid: string,
  anchor: FoundOccurrence | null,
  patch: EventPatch,
  ctx: EditContext
): EditResult {
  const { nothingDone } = ctx;
  const { vcal } = parsed;
  const { master, overrides } = seriesFor(vcal, uid);
  if (master === undefined) throw new Error(`shiftSeries: no main VEVENT for UID ${uid}`);
  return withReadableZones(nothingDone, () => shiftMaster(vcal, uid, master, overrides, anchor, patch, ctx));
}

/** {@link shiftSeries} once its master is found, run through `withReadableZones` (src/ical-edit.ts). */
function shiftMaster(
  vcal: ICAL.Component,
  uid: string,
  master: ICAL.Component,
  overrides: ICAL.Component[],
  anchor: FoundOccurrence | null,
  patch: EventPatch,
  ctx: EditContext
): EditResult {
  const { nothingDone, now, own } = ctx;
  const startProp = master.getFirstProperty("dtstart") as ICAL.Property;
  const start = startProp.getFirstValue() as ICAL.Time;
  const allDay = start.isDate;
  if (patch.allDay !== undefined && patch.allDay !== allDay) {
    throw new ToolRefusal(
      `A series cannot be switched between all-day and timed: every occurrence it has, and every RECURRENCE-ID and EXDATE naming one, would change its form. ${nothingDone}`
    );
  }
  // Every override this write changes, for any reason, collected here and
  // stamped once at the end: one moved and given a new guest list gets one
  // new revision, not two.
  const guests = patchSeriesAttendees(master, overrides, patch, own, nothingDone);
  const touched = new Set<ICAL.Component>(guests?.changed ?? []);
  const anchorWall = anchor === null ? wallOf(start) : anchor.wall;
  // The lengths an override is compared against, before anything moves.
  const oldLength = new ICAL.Event(master).duration.toSeconds();

  if (allDay) {
    shiftAllDaySeries(master, overrides, anchorWall, patch, oldLength, nothingDone, touched);
  } else {
    shiftTimedSeries(master, overrides, anchorWall, patch, oldLength, nothingDone, touched);
  }
  patchText(master, patch);
  const sequence = stampRevision(master, now);
  touched.delete(master);
  for (const ve of touched) stampRevision(ve, now);
  return { ics: vcal.toString(), mark: { uid, sequence }, ...mayNotifyOf(guests, [master, ...overrides], own) };
}

/**
 * The part of {@link shiftSeries} for an all-day series: no new day, and a
 * new length in whole days. Every override it changes is added to `touched`,
 * whose revisions the caller stamps.
 */
function shiftAllDaySeries(
  master: ICAL.Component,
  overrides: ICAL.Component[],
  anchorWall: ZonedWall,
  patch: EventPatch,
  oldLength: number,
  nothingDone: string,
  touched: Set<ICAL.Component>
): void {
  const anchorDay = dayOf(anchorWall);
  if (patch.start !== undefined) {
    const day = calendarDate("start", patch.start, nothingDone);
    if (day !== anchorDay) throw dayChanged(patch.start, day, anchorDay, nothingDone);
  }
  if (patch.end === undefined) return;
  const endDay = calendarDate("end", patch.end, nothingDone);
  const days = Math.round((dateMs(endDay) - dateMs(anchorDay)) / DAY_MS);
  if (days <= 0) {
    throw new ToolRefusal(
      `Every occurrence would end (${endDay}) on or before it starts (${anchorDay}). For an all-day event the end date is exclusive. ${nothingDone}`
    );
  }
  const lengthen = (ve: ICAL.Component): void => {
    if (ve.hasProperty("duration") && !ve.hasProperty("dtend")) {
      ve.updatePropertyWithValue("duration", ICAL.Duration.fromData({ days }));
      return;
    }
    const own = ve.getFirstPropertyValue("dtstart") as ICAL.Time;
    setTime(ve, "dtend", ICAL.Time.fromDateString(isoDate(dateMs(own.toString().slice(0, 10)) + days * DAY_MS)), null);
  };
  lengthen(master);
  for (const ve of overrides) {
    if (!unrescheduled(ve, oldLength, true)) continue;
    lengthen(ve);
    touched.add(ve);
  }
}

/**
 * True for an override that still sits at its original occurrence with the
 * series' old length: it changed only its text, so it moves with the series
 * (spec §2.4). One that was rescheduled keeps its own time.
 */
function unrescheduled(ve: ICAL.Component, oldLength: number, allDay: boolean): boolean {
  const event = new ICAL.Event(ve);
  return keyOf(event.startDate, allDay) === keyOf(event.recurrenceId, allDay) && event.duration.toSeconds() === oldLength;
}

function dayChanged(given: string, day: string, anchorDay: string, nothingDone: string): ToolRefusal {
  return new ToolRefusal(
    `The day of a series cannot be changed; only its time. start "${given}" falls on ${day} in the series' own time zone, and the occurrence it describes is on ${anchorDay}. To move one occurrence to another day, pass its recurrence_id without apply_to_series. ${nothingDone}`
  );
}

/** The part of {@link shiftSeries} for a timed series; every override it changes is added to `touched`. */
function shiftTimedSeries(
  master: ICAL.Component,
  overrides: ICAL.Component[],
  anchorWall: ZonedWall,
  patch: EventPatch,
  oldLength: number,
  nothingDone: string,
  touched: Set<ICAL.Component>
): void {
  const startProp = master.getFirstProperty("dtstart") as ICAL.Property;
  const endProp = master.getFirstProperty("dtend");
  const storedStart = writeZoneOf(startProp);
  const storedEnd = endProp === null ? storedStart : writeZoneOf(endProp);
  for (const stored of [storedStart, storedEnd]) {
    if (stored.kind === "unresolved") {
      throw new ToolRefusal(
        `This series' time is stored in the time zone "${stored.tzid}", which has no VTIMEZONE in the event and is not an IANA time zone, so this connector cannot tell what clock time its occurrences are at. ${nothingDone}`
      );
    }
  }
  const zone = storedStart as WriteZone;
  const endZone = storedEnd as WriteZone;

  let delta = 0;
  if (patch.start !== undefined) {
    const wall = wallAt(timedBound("start", patch.start, zone, nothingDone), zone);
    if (dayOf(wall) !== dayOf(anchorWall)) throw dayChanged(patch.start, dayOf(wall), dayOf(anchorWall), nothingDone);
    delta = clockSeconds(wall) - clockSeconds(anchorWall);
  }
  if (delta !== 0) {
    for (const prop of master.getAllProperties("rrule")) {
      const recur = prop.getFirstValue() as ICAL.Recur;
      if (SUB_DAILY.has(recur.freq)) {
        throw new ToolRefusal(
          `This series repeats FREQ=${recur.freq}: the times of its occurrences are its rule's, so moving its start would contradict the rule rather than move them. ${nothingDone}`
        );
      }
      for (const part of ["BYHOUR", "BYMINUTE", "BYSECOND"] as const) {
        const values = recur.parts[part];
        if (values !== undefined && values.length > 0) {
          throw new ToolRefusal(
            `This series' rule fixes the times of its occurrences with ${part}=${values.join(",")}, so moving its start would contradict the rule rather than move them. ${nothingDone}`
          );
        }
      }
    }
  }

  // The new length, measured on the occurrence the times describe.
  let length: number | undefined;
  if (patch.end !== undefined) {
    const startMs = instantAt(addToWall(anchorWall, delta), zone);
    const endMs = timedBound("end", patch.end, endZone, nothingDone);
    if (endMs <= startMs) {
      throw new ToolRefusal(
        `Every occurrence would end (${shown(endMs, endZone)}) at or before it starts (${shown(startMs, zone)}). ${nothingDone}`
      );
    }
    length = endMs - startMs;
  }

  const move = (prop: ICAL.Property | null): void => {
    if (prop !== null && delta !== 0) shiftProperty(prop, delta, zone);
  };
  /**
   * A new DTEND (or DURATION) `length` after `ve`'s own start. That start is
   * read in the zone its own DTSTART is stored in, as `patchTimes` (src/ical-edit.ts)
   * reads one — an override another client stored in UTC beside a Berlin
   * series had its `…Z` fields read as Berlin clock time, and came out 30
   * minutes long, or negative (fix-pass review of PR #229).
   */
  const lengthen = (ve: ICAL.Component, ownEndZone: WriteZone): void => {
    if (length === undefined) return;
    if (ve.hasProperty("duration") && !ve.hasProperty("dtend")) {
      ve.updatePropertyWithValue("duration", ICAL.Duration.fromSeconds(Math.round(length / 1000)));
      return;
    }
    const startProp = ve.getFirstProperty("dtstart") as ICAL.Property;
    const ownZone = writeZoneOf(startProp);
    const ownStart = storedInstant(startProp.getFirstValue() as ICAL.Time, ownZone.kind === "unresolved" ? zone : ownZone);
    const end = writtenTime(ownStart + length, ownEndZone);
    setTime(ve, "dtend", end.time, end.zone);
  };

  move(startProp);
  if (length !== undefined) lengthen(master, endZone);
  else move(endProp);
  for (const name of ["exdate", "rdate"]) {
    for (const prop of master.getAllProperties(name)) move(prop);
  }
  if (delta !== 0) shiftUntil(master, delta, zone);

  for (const ve of overrides) {
    const moves = unrescheduled(ve, oldLength, false);
    let changed = false;
    if (delta !== 0) {
      move(ve.getFirstProperty("recurrence-id"));
      changed = true;
    }
    if (moves) {
      move(ve.getFirstProperty("dtstart"));
      const ownEnd = ve.getFirstProperty("dtend");
      if (length !== undefined) {
        const ownEndZone = ownEnd === null ? zone : writeZoneOf(ownEnd);
        lengthen(ve, ownEndZone.kind === "unresolved" ? zone : ownEndZone);
        changed = true;
      } else {
        move(ownEnd);
      }
      changed ||= delta !== 0;
    }
    if (changed) touched.add(ve);
  }

  coverGenerated(master.parent, [zone, endZone]);
}

/**
 * Move every time in `prop` — a DTSTART, DTEND, RECURRENCE-ID, EXDATE or
 * RDATE, one value or several, a PERIOD's two ends — by `delta` seconds on
 * the clock of the series' zone `zone`, in place, its parameters kept. A
 * date is left alone. A value in the series' own zone moves field by field;
 * one in another zone (a UTC EXDATE on a Berlin series) is read as an
 * instant, moved on the series' clock, and written back in its own zone.
 */
function shiftProperty(prop: ICAL.Property, delta: number, zone: WriteZone): void {
  const own = writeZoneOf(prop);
  const shiftTime = (time: ICAL.Time): ICAL.Time => {
    if (time.isDate) return time;
    if (own.kind === "unresolved" || sameClock(own, zone)) {
      const moved = time.clone();
      moved.adjust(0, 0, 0, delta);
      return moved;
    }
    const at = instantAt(addToWall(wallAt(storedInstant(time, own), zone), delta), zone);
    return ICAL.Time.fromData({ ...wallAt(at, own), isDate: false }, time.zone ?? undefined);
  };
  const values = prop.getValues().map((value: unknown) => {
    if (value instanceof ICAL.Period) {
      return ICAL.Period.fromData({
        start: shiftTime(value.start),
        ...(value.end ? { end: shiftTime(value.end) } : { duration: value.duration }),
      });
    }
    return shiftTime(value as ICAL.Time);
  });
  if (values.length === 1) prop.setValue(values[0]);
  else prop.setValues(values);
}

/**
 * Move a DATE-TIME `UNTIL` by `delta` seconds on the series' clock, so the
 * occurrence it ended on is still the last one (the UNTIL case, §0.1). A UTC
 * UNTIL (the RFC 5545 form for a zoned or UTC series) is read as an instant,
 * moved on the clock of `zone`, and written back in UTC; a floating one moves
 * on its own clock. A DATE UNTIL, and a rule with COUNT or no end, are left
 * exactly as they are.
 */
function shiftUntil(master: ICAL.Component, delta: number, zone: WriteZone): void {
  for (const prop of master.getAllProperties("rrule")) {
    const recur = prop.getFirstValue() as ICAL.Recur;
    const until = recur.until;
    if (until === null || until === undefined || until.isDate) continue;
    let moved: ICAL.Time;
    if (until.zone === ICAL.Timezone.utcTimezone) {
      const at = instantAt(addToWall(wallAt(until.toUnixTime() * 1000, zone), delta), zone);
      moved = ICAL.Time.fromJSDate(new Date(at), true);
    } else {
      moved = until.clone();
      moved.adjust(0, 0, 0, delta);
    }
    const next = recur.clone();
    next.until = moved;
    prop.setValue(next);
  }
}
