/**
 * Time zones for stored iCalendar objects: which zone a time is in, and the
 * wall-clock arithmetic for an IANA zone (spec 2026-09-29 §2.5, #208, #209).
 * No network access, and no dependency beyond ical.js and the ICU data every
 * Node build carries for `Intl`.
 *
 * Two parts live beside it since #234: the `Intl` offset arithmetic, which
 * knows nothing of iCalendar objects, in src/ical-zones-intl.ts, and the
 * VTIMEZONE this connector generates in src/ical-vtimezone.ts. What reads a
 * stored object's times, and writes them back, is here.
 *
 * Where a time's arithmetic comes from, in order:
 *
 *   1. **The object's own VTIMEZONE** for its TZID. It is how every other
 *      client reads the event, so the connector reads it the same way, and
 *      ical.js does that without help.
 *   2. **`Intl`**, for a TZID the object carries no VTIMEZONE for that is an
 *      IANA name, or a path-like TZID ending in one
 *      (`/mozilla.org/20050126_1/Europe/Berlin`). Nextcloud and iCloud objects
 *      often omit the VTIMEZONE for those, and ical.js on its own then reads
 *      the time as floating — the process's local time — which is how an
 *      event came to be refused, or moved by hours (#209, R6).
 *   3. Anything else — a Windows name like `W. Europe Standard Time` with no
 *      VTIMEZONE — is **unresolved**: the reader skips the object and says
 *      why, and a writer refuses (#209 keeps that refusal).
 *
 * `Intl` was chosen over a package of published VTIMEZONE blocks on measured
 * errors (§0.1): checked against `Intl` for every day of 2026–2030, the
 * candidate package was wrong for Jerusalem on 14 days and for Casablanca on
 * 1,627 of 1,826. `Intl` gives the exact offset at every instant in every IANA
 * zone. What it does not give is the other direction, wall-clock time to an
 * instant, at the two edges where that is ambiguous — `zonedWallToInstant`
 * (src/ical-zones-intl.ts) applies RFC 5545 §3.3.5's rule there.
 *
 * **Nothing here changes what an object says when written back.** The IANA
 * case is resolved by giving the parsed times an `Intl`-backed zone, in
 * memory, local to that one parse. It is not `TimezoneService.register`,
 * whose registry is process-wide (R6), and no VTIMEZONE is added: an object
 * that had none goes back the way the other client wrote it.
 *
 * **The writing half** (plan Task 4a, #208, #209) keeps a time in the zone it
 * was stored in: {@link writeZoneOf} says which zone a stored time is written
 * back in, {@link readDateTime} reads a caller's time for it, and
 * {@link writtenTime} makes the value to write. A Berlin event moved stays
 * `TZID=Europe/Berlin` local time, a UTC one stays UTC, a floating one stays
 * floating. The one VTIMEZONE the connector ever authors is
 * src/ical-vtimezone.ts's, for `create_event`'s `timezone` (spec §2.5 A):
 * generated from `Intl` transition by transition, so it is exact where the
 * rejected package was not.
 *
 * The review of #224 found three ways the writing half disagreed with itself,
 * and each has one answer here now:
 *
 *   - **One rule for every zone.** A VTIMEZONE and `Intl` both answer "what
 *     offset at this instant" exactly, and every conversion is built on that
 *     question ({@link wallToInstantBy}), so the gap and the overlap are read
 *     by RFC 5545 §3.3.5 whichever kind of zone the object has.
 *   - **An instant no wall time names** — the second pass through an autumn
 *     overlap — is written in UTC ({@link writtenTime}), not as the wall time
 *     that means the first pass.
 *   - **The block this connector generated** covers only the span it was
 *     made for, so it is marked, a time in its zone is computed through
 *     `Intl`, and it is regenerated to cover every time the object holds
 *     ({@link coverGeneratedVtimezone}). Any other VTIMEZONE is never
 *     rewritten.
 */

import ICAL from "ical.js";
import { impossibleRule } from "./ical-series.js";
import { generatedVtimezone, isGeneratedVtimezone } from "./ical-vtimezone.js";
import {
  canonicalZone,
  DAY_MS,
  IntlTimezone,
  resolveUnknownTzid,
  utcMs,
  utcOffsetMs,
  utcWall,
  wallToInstantBy,
  type OffsetAt,
  type ZonedWall,
} from "./ical-zones-intl.js";

/** What zone a stored time is in, as {@link zoneOf} reads it. */
export type ZoneKind =
  /** `…Z`, or `TZID=UTC`. */
  | { kind: "utc" }
  /** No zone at all: a clock time, or a DATE. */
  | { kind: "floating" }
  /** A TZID with no VTIMEZONE, placed through `Intl`; `tzid` is the IANA name. */
  | { kind: "iana"; tzid: string }
  /** A TZID with a VTIMEZONE in the object; `tzid` exactly as stored. */
  | { kind: "vtimezone"; tzid: string }
  /** A TZID with no VTIMEZONE that is no IANA name either; `tzid` as stored. */
  | { kind: "unresolved"; tzid: string };

/**
 * The clock fields of a stored time, exactly as stored: no zone is applied.
 * One reading for the reader (src/ical-expand.ts) and the writer that moves
 * a series, which each had their own copy until the code-health review of
 * PR #229.
 */
export function wallOf(time: ICAL.Time): ZonedWall {
  return { year: time.year, month: time.month, day: time.day, hour: time.hour, minute: time.minute, second: time.second };
}

/** `wall` moved by `seconds` on the clock: plain field arithmetic, no zone involved. */
export function addToWall(wall: ZonedWall, seconds: number): ZonedWall {
  const d = new Date(utcMs(wall.year, wall.month, wall.day, wall.hour, wall.minute, wall.second) + seconds * 1000);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
  };
}

/** Seconds since midnight of a wall time. */
export function clockSeconds(wall: ZonedWall): number {
  return (wall.hour * 60 + wall.minute) * 60 + wall.second;
}

/** `YYYY-MM-DD` of a wall time. */
export function dayOf(wall: ZonedWall): string {
  return `${String(wall.year).padStart(4, "0")}-${String(wall.month).padStart(2, "0")}-${String(wall.day).padStart(2, "0")}`;
}

/**
 * The UTC offset a VTIMEZONE puts in effect at the instant `ms`, in ms.
 *
 * ical.js answers only the other question — the offset of a *wall* time,
 * `Timezone.utcOffset` — and answers it naively at the two edges: a wall time
 * in the autumn overlap gets the second pass, one in the spring gap the offset
 * from after it. The write path used that, and so wrote an event with a
 * VTIMEZONE an hour away from the same event without one (review of #224).
 * But the transitions ical.js expands a VTIMEZONE into, `changes`, are
 * instants, and the offset at an instant has exactly one answer: the one the
 * last transition at or before it set.
 *
 * Before the block's first transition ical.js reads every wall time at
 * offset 0, and so does this: it is how `list_events` reads such a time, and
 * a write that disagreed with the reader would not come back as what was
 * asked. The one VTIMEZONE this connector writes never leaves a time it
 * holds outside its span (see {@link coverGeneratedVtimezone}).
 *
 * Expanding a VTIMEZONE's observance rules is ical.js's own walk to a given
 * year, the one every read of such a time already does; it is not an event's
 * recurrence rule. It runs on whichever thread asks — for a writer, the
 * connector's own — so it is bounded here, not by ical.js: every VTIMEZONE a
 * parse meets goes through {@link boundObservanceWalks}, and one whose rules
 * it will not walk throws {@link UnreadableTimezone} from here instead of
 * walking for ever (milestone review of v0.7.4).
 */
function vtimezoneOffsetMs(zone: ICAL.Timezone, ms: number): number {
  if (!zone.component) return 0;
  zone._ensureCoverage(new Date(ms).getUTCFullYear() + 1);
  let offset = 0;
  for (const change of zone.changes as Array<ZonedWall & { utcOffset: number }>) {
    const at = utcMs(change.year, change.month, change.day, change.hour, change.minute, change.second);
    if (at > ms) break;
    offset = change.utcOffset * 1000;
  }
  return offset;
}

/**
 * A VTIMEZONE whose observance rules this connector will not walk (milestone
 * review of v0.7.4): its message says which rule, and why. Thrown from
 * wherever a time in the zone is first placed — ical.js's own arithmetic
 * included — so a writer turns it into a refusal that says nothing was
 * written (`withReadableZones` in src/ical-edit.ts), and the reader skips the
 * object with the message as its reason.
 */
export class UnreadableTimezone extends Error {
  constructor(tzid: string, why: string) {
    super(`the VTIMEZONE "${tzid}" ${why}`);
    this.name = "UnreadableTimezone";
  }
}

/**
 * Observance steps walked for one coverage of one VTIMEZONE — all its
 * observances together — before it is refused. A real VTIMEZONE changes its
 * offset once or twice a year: Outlook's start in 1601, which is about 430
 * steps each to today, and a time in the year 9999 is about 17,000 for two
 * observances. A yearly rule that lists every hour of every day passes that
 * within its first year.
 */
export const MAX_OBSERVANCE_STEPS = 20_000;

/**
 * Why the observance rules of `vtimezone` cannot be walked to the end of
 * `untilYear` on this thread, or null when they can — the walk
 * ical.js's `_expandComponent` would make, bounded:
 *
 *   - **Yearly only.** `RecurIterator.next` gives up on a rule that never
 *     matches only for MONTHLY and YEARLY, and a MONTHLY one whose BYMONTH
 *     contracts can still loop inside one call; for YEARLY every BY part
 *     expands, so each call ends. Every VTIMEZONE any client writes uses
 *     `FREQ=YEARLY` — the offset changes on a day of a month — so anything
 *     else is refused rather than walked.
 *   - **Not impossible**, by `impossibleRule` (src/ical-series.ts): a yearly
 *     rule that can never match would end, but only after ical.js's 28 tries
 *     per step, and it has no offset change to give.
 *   - **At most {@link MAX_OBSERVANCE_STEPS} steps**, counted across every
 *     observance, between `next()` calls — which, for a yearly rule, each
 *     return.
 *
 * Only the first RRULE of an observance is read, as ical.js reads only that
 * one; an observance without a DTSTART is passed over, as ical.js passes it
 * over. The rule is walked on a copy: ical.js's own walk rewrites a UTC
 * UNTIL in place.
 */
function observanceProblem(vtimezone: ICAL.Component, untilYear: number): string | null {
  let steps = 0;
  for (const observance of vtimezone.getAllSubcomponents()) {
    const prop = observance.getFirstProperty("rrule");
    const start = observance.getFirstPropertyValue("dtstart");
    if (prop === null || !(start instanceof ICAL.Time)) continue;
    const rule = prop.getFirstValue() as ICAL.Recur;
    const kind = observance.name.toUpperCase();
    if (rule.freq !== "YEARLY") {
      return `has a ${kind} rule that repeats FREQ=${rule.freq}, where a time zone changes its offset yearly, so this connector does not walk it`;
    }
    const impossible = impossibleRule(rule);
    if (impossible !== null) return `has a ${kind} rule that can never match a date (${impossible})`;
    const iterator = rule.clone().iterator(start);
    for (let next = iterator.next(); next && next.year <= untilYear; next = iterator.next()) {
      if (++steps > MAX_OBSERVANCE_STEPS) {
        return `has observance rules that change its offset more than ${MAX_OBSERVANCE_STEPS} times before ${untilYear + 1}, which no time zone does`;
      }
    }
  }
  return null;
}

/**
 * The last year ical.js expands a VTIMEZONE to when asked for `year`: its
 * `_ensureCoverage` rule — the year asked for, or this year if that is
 * earlier, plus its `EXTRA_COVERAGE` — so that {@link observanceProblem}
 * checks exactly the walk ical.js then makes.
 */
function coverageYear(year: number): number {
  const minimum = ICAL.Timezone._minimumExpansionYear === -1 ? ICAL.Time.now().year : ICAL.Timezone._minimumExpansionYear;
  return Math.max(year, minimum) + ICAL.Timezone.EXTRA_COVERAGE;
}

/**
 * Bound every walk of the observance rules of `vcal`'s VTIMEZONEs (milestone
 * review of v0.7.4, finding 1), in place, for this one parse.
 *
 * ical.js expands a VTIMEZONE's STANDARD and DAYLIGHT rules, in
 * `Timezone._ensureCoverage`, the first time a time in the zone is placed in
 * a given year — from {@link vtimezoneOffsetMs} and from its own
 * `utcOffset`, which `toUnixTime`, `compare` and an event's `duration` all
 * reach. It walks each rule with nothing to stop it, and a rule like
 * `FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30` never ends: `list_events` survives it
 * in a worker, under a deadline, but `update_event` places times on the
 * connector's own thread, and a new `start` for such an event froze the
 * process.
 *
 * So each VTIMEZONE's zone — the one ical.js caches on the VCALENDAR and
 * hands every time in it — has its `_ensureCoverage` replaced, on that one
 * object, by one that asks {@link observanceProblem} first whenever ical.js
 * would walk, and throws {@link UnreadableTimezone} rather than walk what it
 * refuses; a zone refused once is refused at once after that. What ical.js
 * then walks, it walks exactly as before, so a VTIMEZONE that passes reads
 * as it always did. Nothing is written back, and the process-wide
 * `TimezoneService` is not touched.
 */
function boundObservanceWalks(vcal: ICAL.Component): void {
  for (const vtimezone of vcal.getAllSubcomponents("vtimezone")) {
    const tzid = String(vtimezone.getFirstPropertyValue("tzid") ?? "");
    if (tzid === "") continue;
    const zone = vcal.getTimeZoneByID(tzid) as ICAL.Timezone | null;
    // A second VTIMEZONE with the same TZID is never the one a time gets.
    if (zone === null || zone.component !== vtimezone) continue;
    const expand = zone._ensureCoverage.bind(zone);
    const state = zone as unknown as { expandedUntilYear: number };
    let refused: UnreadableTimezone | null = null;
    zone._ensureCoverage = (year: number): void => {
      if (refused !== null) throw refused;
      // ical.js's own test for whether it walks at all.
      if (zone.changes.length > 0 && state.expandedUntilYear >= year) return;
      const why = observanceProblem(vtimezone, coverageYear(year));
      if (why !== null) {
        refused = new UnreadableTimezone(tzid, why);
        throw refused;
      }
      expand(year);
    };
  }
}

/** The question {@link OffsetAt} for an ical.js zone, `Intl` or VTIMEZONE. */
function offsetsOf(zone: ICAL.Timezone): OffsetAt {
  if (zone instanceof IntlTimezone) {
    const iana = zone.iana;
    return (ms) => utcOffsetMs(ms, iana);
  }
  return (ms) => vtimezoneOffsetMs(zone, ms);
}

/** Components whose times are never an event's: a VTIMEZONE's are local by definition. */
function* timedProperties(component: ICAL.Component): Generator<ICAL.Property> {
  if (component.name === "vtimezone") return;
  for (const prop of component.getAllProperties()) {
    if (prop.getParameter("tzid") !== undefined) yield prop;
  }
  for (const sub of component.getAllSubcomponents()) yield* timedProperties(sub);
}

function vtimezoneIds(vcal: ICAL.Component): Set<string> {
  return new Set(
    vcal.getAllSubcomponents("vtimezone").map((tz) => String(tz.getFirstPropertyValue("tzid") ?? ""))
  );
}

/** Apply `fn` to every ICAL.Time in a property: plain values, and a PERIOD's two ends. */
function forEachTime(prop: ICAL.Property, fn: (t: ICAL.Time) => void): void {
  for (const value of prop.getValues()) {
    if (value instanceof ICAL.Time) fn(value);
    else if (value instanceof ICAL.Period) {
      fn(value.start);
      if (value.end) fn(value.end);
    }
  }
}

/**
 * Give every time in `vcal` whose TZID has no VTIMEZONE the `Intl` zone it
 * names, in place and in memory only (spec §2.5). Returns the TZIDs it could
 * not place, so a reader can skip the object and say why.
 *
 * Call it straight after parsing, before anything has read a time: ical.js
 * caches an instant once computed.
 *
 * It bounds, too, every walk of the object's own VTIMEZONEs' observance
 * rules ({@link boundObservanceWalks}): the same moment, for the same reason
 * — before any time in them has been placed.
 */
export function withResolvedZones(vcal: ICAL.Component): { unresolved: string[] } {
  boundObservanceWalks(vcal);
  const own = vtimezoneIds(vcal);
  const zones = new Map<string, IntlTimezone | null>();
  const unresolved: string[] = [];
  for (const prop of timedProperties(vcal)) {
    const tzid = String(prop.getParameter("tzid"));
    if (own.has(tzid) || ICAL.TimezoneService.get(tzid) === ICAL.Timezone.utcTimezone) continue;
    let zone = zones.get(tzid);
    if (zone === undefined) {
      const iana = resolveUnknownTzid(tzid);
      zone = iana === null ? null : new IntlTimezone(tzid, iana);
      zones.set(tzid, zone);
      if (zone === null) unresolved.push(tzid);
    }
    if (zone !== null) {
      const z = zone;
      forEachTime(prop, (t) => {
        if (!t.isDate) t.zone = z;
      });
    }
  }
  return { unresolved };
}

/** True for a time with no zone: a floating clock time, or a DATE. */
export function isFloating(time: ICAL.Time): boolean {
  return time.isDate || time.zone === ICAL.Timezone.localTimezone || time.zone?.tzid === "floating";
}

/**
 * The name `list_events` reports as an event's `timezone` (spec §2.5): the
 * IANA name, `"UTC"`, or `"floating"`. A VTIMEZONE's TZID is reported by its
 * IANA tail when it has one, so a Mozilla-style path reads as `Europe/Berlin`,
 * and as stored otherwise (`W. Europe Standard Time`, with its VTIMEZONE).
 */
export function zoneNameOf(time: ICAL.Time): string {
  if (isFloating(time)) return "floating";
  const zone = time.zone;
  if (zone === ICAL.Timezone.utcTimezone || zone === null) return "UTC";
  if (zone instanceof IntlTimezone) return zone.iana;
  return resolveUnknownTzid(zone.tzid) ?? zone.tzid;
}

/**
 * Which zone a DTSTART, DTEND, RECURRENCE-ID, EXDATE or RDATE is in. It takes
 * the property rather than the time because the TZID lives there: an
 * unresolved TZID and a floating time look the same to ical.js.
 *
 * Meant for an object that has been through {@link withResolvedZones};
 * without that, every IANA TZID with no VTIMEZONE reads as `unresolved`.
 */
export function zoneOf(prop: ICAL.Property): ZoneKind {
  let value = prop.getFirstValue() as unknown;
  if (value instanceof ICAL.Period) value = value.start;
  if (!(value instanceof ICAL.Time)) return { kind: "floating" };
  if (value.isDate) return { kind: "floating" };
  const zone = value.zone;
  if (zone === ICAL.Timezone.utcTimezone) return { kind: "utc" };
  if (zone instanceof IntlTimezone) return { kind: "iana", tzid: zone.iana };
  const tzid = prop.getParameter("tzid");
  if (tzid === undefined) return { kind: "floating" };
  if (zone?.component) return { kind: "vtimezone", tzid: String(tzid) };
  return { kind: "unresolved", tzid: String(tzid) };
}

// ---------------------------------------------------------------------------
// The writing half (plan Task 4a): a time goes back in the zone it came from.
// ---------------------------------------------------------------------------

/**
 * The zone a new DTSTART or DTEND is written in.
 *
 *   - `utc`: `…Z`, as every time this connector wrote before v0.7.4.
 *   - `floating`: clock time with no zone (#209). Arithmetic on it is on the
 *     clock: its "instant" is the clock time read as if it were UTC, the same
 *     rule `list_events` sorts it by.
 *   - `zoned`: local time with `TZID=tzid`, where `tzid` is written exactly as
 *     the object stored it (`/mozilla.org/…/Europe/Berlin` stays that) and
 *     `zone` is what does the arithmetic — the object's own VTIMEZONE, or an
 *     {@link IntlTimezone} when it had none or when the one it has is the
 *     block this connector generated (`generated`, below).
 *
 * `generated` is set when the object's VTIMEZONE for `tzid` is the one
 * src/ical-vtimezone.ts generated. That block is exact only for the span it
 * was generated for, and its last observance would otherwise stand for every
 * year after it — so a time in such a zone is computed through `Intl`, and
 * the writer regenerates the block with {@link coverGeneratedVtimezone} to
 * cover every time the object then holds (review of #224).
 */
export type WriteZone =
  | { kind: "utc" }
  | { kind: "floating" }
  | { kind: "zoned"; tzid: string; zone: ICAL.Timezone; generated?: true };

export const UTC_ZONE: WriteZone = { kind: "utc" };

/**
 * The zone a new event is written in for the IANA name `iana` (as
 * {@link canonicalZone} spells it): UTC for a name that means UTC, written as
 * `…Z`, and otherwise `TZID=iana` local time whose arithmetic is `Intl`'s.
 * The one place a {@link WriteZone} is made from a name rather than read off
 * a stored property, so no caller assembles an {@link IntlTimezone} by hand
 * (code-health review of PR 3).
 */
export function zonedWriteZone(iana: string): WriteZone {
  return isUtcName(iana) ? UTC_ZONE : { kind: "zoned", tzid: iana, zone: new IntlTimezone(iana, iana) };
}

/**
 * The zone a stored DTSTART or DTEND is written back in (spec §2.5, #208):
 * its own. An `unresolved` TZID has no zone this connector can do arithmetic
 * in; the caller decides whether it needs one. Meant for an object that has
 * been through `parseCalendar` (src/ical-parse.ts).
 */
export function writeZoneOf(prop: ICAL.Property): WriteZone | { kind: "unresolved"; tzid: string } {
  const kind = zoneOf(prop);
  switch (kind.kind) {
    case "utc":
      return UTC_ZONE;
    case "floating":
      return { kind: "floating" };
    case "unresolved":
      return kind;
    default: {
      const time = prop.getFirstValue() as ICAL.Time;
      const zone = time.zone as ICAL.Timezone;
      const tzid = String(prop.getParameter("tzid"));
      if (kind.kind === "vtimezone" && isGeneratedVtimezone(zone.component)) {
        return { kind: "zoned", tzid, zone: new IntlTimezone(tzid, tzid), generated: true };
      }
      return { kind: "zoned", tzid, zone };
    }
  }
}

/** True for an ISO date-time that says its offset: `Z`, `+02:00`, `-0500`. A date alone has none. */
export function hasOffset(value: string): boolean {
  return /T.*(?:Z|[+-]\d{2}(?::?\d{2})?)$/i.test(value.trim());
}

/** The clock time of an ISO date-time with no offset, or null for anything else. */
function wallOfIso(value: string): ZonedWall | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/.exec(value.trim());
  if (m === null) return null;
  const [year, month, day, hour, minute, second] = m.slice(1).map((part) => Number(part ?? 0));
  // The round trip catches a clock time that does not exist on any calendar:
  // `2026-13-45T25:00` would otherwise roll over into a later one.
  const back = new Date(utcMs(year, month, day, hour, minute, second));
  if (
    back.getUTCFullYear() !== year ||
    back.getUTCMonth() !== month - 1 ||
    back.getUTCDate() !== day ||
    back.getUTCHours() !== hour ||
    back.getUTCMinutes() !== minute
  ) {
    return null;
  }
  return { year, month, day, hour, minute, second };
}

/**
 * The instant a wall time names in `zone`, by RFC 5545 §3.3.5's rule
 * ({@link wallToInstantBy}) whatever kind of zone it is: a VTIMEZONE and
 * `Intl` read the gap and the overlap the same way (review of #224). Whole
 * minutes, because that is what a transition is aligned to, and the seconds
 * added back, so a caller's `09:00:30` still comes back as `09:00:30`.
 */
function wallToInstantIn(w: ZonedWall, zone: ICAL.Timezone): number {
  const wall = utcMs(w.year, w.month, w.day, w.hour, w.minute);
  return wallToInstantBy(wall, offsetsOf(zone)) + w.second * 1000;
}

/**
 * The wall time `ms` shows in `zone`, or null when that wall time names
 * another instant.
 *
 * Null is the second pass through an autumn overlap: Berlin shows 02:30 at
 * 00:30Z and again at 01:30Z, and RFC 5545 §3.3.5 reads a TZID 02:30 as the
 * first. Written as that wall time, 01:30Z would move an hour earlier — a
 * one-hour event from 00:30Z would end where it starts, and one ending at
 * 02:15 CET would end before a 02:45 CEST start (review of #224). The caller
 * writes such an instant in UTC instead ({@link writtenTime}).
 */
function wallIn(ms: number, zone: ICAL.Timezone): ZonedWall | null {
  const wall = utcWall(ms + offsetsOf(zone)(ms));
  return wallToInstantIn(wall, zone) === ms ? wall : null;
}

/**
 * The instant a caller's start or end names when it is written in `zone`, in
 * epoch ms — for a floating zone, the clock time read as UTC. NaN when it is
 * no ISO 8601 date-time.
 *
 * A time with an offset names its instant whatever the zone. One without is
 * clock time in `zone` — so `2026-10-29T15:00:00` for a Berlin event is 15:00
 * in Berlin, not in whatever zone this process runs in, which is how
 * `Date.parse` would read it. The caller refuses an offset for a floating
 * zone before it gets here: dropping it would move the event by it.
 */
export function readDateTime(value: string, zone: WriteZone): number {
  if (hasOffset(value)) return Date.parse(value);
  const wall = wallOfIso(value);
  if (wall === null) return NaN;
  if (zone.kind === "zoned") return wallToInstantIn(wall, zone.zone);
  return utcMs(wall.year, wall.month, wall.day, wall.hour, wall.minute, wall.second);
}

/**
 * The wall-clock fields the instant `ms` shows in `zone` — for a floating
 * zone, the clock time `ms` stands for (it is read as UTC, see
 * {@link readDateTime}). Unlike {@link writtenTime} it never falls back to
 * UTC: on the second pass through an autumn overlap it is the wall time the
 * zone's clocks show, which is what a series' "same clock time" (#207) is
 * measured in.
 */
export function wallAt(ms: number, zone: WriteZone): ZonedWall {
  return zone.kind === "zoned" ? utcWall(ms + offsetsOf(zone.zone)(ms)) : utcWall(ms);
}

/**
 * The instant a wall time names in `zone`, by RFC 5545 §3.3.5's rule for a
 * zoned one ({@link wallToInstantBy}); a UTC or floating wall time read as
 * UTC. The inverse of {@link wallAt} everywhere but in a gap.
 */
export function instantAt(wall: ZonedWall, zone: WriteZone): number {
  if (zone.kind === "zoned") return wallToInstantIn(wall, zone.zone);
  return utcMs(wall.year, wall.month, wall.day, wall.hour, wall.minute, wall.second);
}

/**
 * A stored time as {@link readDateTime} would have read it, for a time stored
 * in `zone` (as {@link writeZoneOf} said): the instant, or for a floating time
 * its clock time read as UTC. `toJSDate` would read a floating time in the
 * process's own zone, and a zoned one by ical.js's naive reading of the gap
 * and the overlap; this reads it by the same rule a new time is read by, so
 * an event's length is measured the way its new end will be placed.
 */
export function storedInstant(time: ICAL.Time, zone: WriteZone): number {
  const wall = { year: time.year, month: time.month, day: time.day, hour: time.hour, minute: time.minute, second: time.second };
  if (isFloating(time)) return utcMs(wall.year, wall.month, wall.day, wall.hour, wall.minute, wall.second);
  if (zone.kind === "zoned") return wallToInstantIn(wall, zone.zone);
  return time.toUnixTime() * 1000;
}

/**
 * A DATE-TIME ready to write, and the zone it is actually written in: `zone`,
 * except for an instant no wall time in `zone` names (the second pass through
 * an autumn overlap, see {@link wallIn}), which is written in UTC. RFC 5545
 * lets DTSTART and DTEND — and RECURRENCE-ID, EXDATE, RDATE — each carry its
 * own zone, and UTC is the one form every reader places at exactly that
 * instant.
 */
export interface WrittenTime {
  time: ICAL.Time;
  zone: WriteZone;
}

/** The DATE-TIME to write for `ms` (as {@link readDateTime} returns it) in `zone`; see {@link WrittenTime}. */
export function writtenTime(ms: number, zone: WriteZone): WrittenTime {
  const whole = Math.floor(ms / 1000) * 1000;
  if (zone.kind === "floating") return { time: ICAL.Time.fromData({ ...utcWall(whole), isDate: false }), zone };
  if (zone.kind === "zoned") {
    const wall = wallIn(whole, zone.zone);
    if (wall !== null) return { time: ICAL.Time.fromData({ ...wall, isDate: false }, zone.zone), zone };
  }
  return { time: ICAL.Time.fromJSDate(new Date(whole), true), zone: UTC_ZONE };
}

/** True for the names that mean UTC itself, which is written as `…Z`, not as a TZID. */
function isUtcName(zone: string): boolean {
  return /^(?:Etc\/)?(?:UTC|UCT|GMT|Universal|Zulu)$/i.test(zone);
}

/**
 * The IANA zone a calendar's `calendar-timezone` names, or null, for
 * `create_event`'s default (spec §2.5). RFC 4791 §5.2.2 makes the property a
 * VCALENDAR holding one VTIMEZONE; tsdav hands it over as whatever text the
 * server sent, and a server may send a bare id instead. Which one Nextcloud
 * sends is acceptance point A7, so both are read here. Radicale sets none
 * (R13), and tsdav then reports `""`.
 *
 * A zone that is no IANA name — a Windows name, with its VTIMEZONE — is null:
 * the event is written in UTC, as every event was before v0.7.4.
 */
export function calendarZone(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text === "") return null;
  if (!/^BEGIN:/i.test(text)) {
    const iana = resolveUnknownTzid(text);
    return iana === null ? null : canonicalZone(iana);
  }
  try {
    const vcal = new ICAL.Component(ICAL.parse(text));
    const tzid = vcal.getFirstSubcomponent("vtimezone")?.getFirstPropertyValue("tzid");
    if (typeof tzid !== "string") return null;
    const iana = resolveUnknownTzid(tzid);
    return iana === null ? null : canonicalZone(iana);
  } catch {
    return null;
  }
}

/**
 * How far past the latest time an object holds a generated VTIMEZONE reaches
 * for a series in its zone whose rule has no UNTIL (see
 * {@link coverGeneratedVtimezone}): ten years, about 20 observances for a
 * zone with DST.
 */
const SERIES_REACH_MS = 10 * 366 * DAY_MS;

/**
 * The instants a series in `tzid` runs to beyond the times `vcal` holds, the
 * latest of which is `latest`: each such VEVENT's UNTIL, or `latest` plus
 * {@link SERIES_REACH_MS} for a rule with COUNT or no end.
 */
function seriesReach(vcal: ICAL.Component, tzid: string, latest: number): number[] {
  const reach: number[] = [];
  for (const vevent of vcal.getAllSubcomponents("vevent")) {
    if (String(vevent.getFirstProperty("dtstart")?.getParameter("tzid")) !== tzid) continue;
    for (const prop of vevent.getAllProperties("rrule")) {
      const until = (prop.getFirstValue() as ICAL.Recur).until;
      reach.push(until ? until.toUnixTime() * 1000 : latest + SERIES_REACH_MS);
    }
  }
  return reach;
}

/**
 * Regenerate the VTIMEZONE this connector generated for `tzid`, if the
 * object holds one, so that it covers every time in the object written in
 * that zone (review of #224). In place, and in the block's own position.
 *
 * A generated block is exact only across the span it was made for: before
 * it ical.js reads the zone at offset 0, and after it the last observance
 * stands for ever — Berlin at +0100 through every summer. Any client that
 * reads the event by the block would place a time outside that span hours
 * away from where it is. So whenever a writer puts a time in such a zone, it
 * calls this, and the block is made again from `Intl` across every
 * DTSTART, DTEND, RECURRENCE-ID, EXDATE and RDATE the object now holds with
 * that TZID, a year either side.
 *
 * A block without the mark is someone else's and is left exactly as it is;
 * so is an object whose times in the zone are all gone.
 *
 * **A series' reach** (v0.7.4 PR 4, #207). The times an object holds are
 * only where a series starts: its occurrences run on by its rule. So for a
 * VEVENT in that zone with an RRULE, the block also covers the rule's end —
 * its UNTIL — and, for a rule with COUNT or no end at all, the ten years
 * after the latest time the object holds ({@link SERIES_REACH_MS}). The
 * rule is not walked for it (that is a worker's job, src/ical-worker-ops.ts,
 * and a COUNT's last occurrence would need one): ten years is a bound, not
 * the series' end, and past it the block reads the zone as its last
 * observance says, as any other client's bounded block would. `create_event`
 * writes no series, so this is a series another client made of an event
 * this connector created, whose time `update_event` then moved.
 */
export function coverGeneratedVtimezone(vcal: ICAL.Component, tzid: string): void {
  // A copy: ical.js hands out its own array, which the removal below empties.
  const subcomponents = [...vcal.getAllSubcomponents()];
  const index = subcomponents.findIndex(
    (c) => c.name === "vtimezone" && c.getFirstPropertyValue("tzid") === tzid && isGeneratedVtimezone(c)
  );
  if (index === -1) return;
  const zone = new IntlTimezone(tzid, tzid);
  const instants: number[] = [];
  for (const prop of timedProperties(vcal)) {
    if (String(prop.getParameter("tzid")) !== tzid) continue;
    forEachTime(prop, (t) => {
      if (!t.isDate) {
        instants.push(wallToInstantIn({ year: t.year, month: t.month, day: t.day, hour: t.hour, minute: t.minute, second: t.second }, zone));
      }
    });
  }
  if (instants.length === 0) return;
  instants.push(...seriesReach(vcal, tzid, Math.max(...instants)));
  subcomponents[index] = generatedVtimezone(tzid, instants);
  vcal.removeAllSubcomponents();
  for (const c of subcomponents) vcal.addSubcomponent(c);
}
