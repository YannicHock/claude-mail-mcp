/**
 * Time zones for stored iCalendar objects: which zone a time is in, and the
 * wall-clock arithmetic for an IANA zone (spec 2026-09-29 §2.5, #208, #209).
 * No network access, and no dependency beyond ical.js and the ICU data every
 * Node build carries for `Intl`.
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
 * instant, at the two edges where that is ambiguous — {@link
 * zonedWallToInstant} applies RFC 5545 §3.3.5's rule there.
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
 * {@link vtimezoneFromIntl}'s, for `create_event`'s `timezone` (spec §2.5 A):
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

/** A wall-clock reading in some zone. `month` is 1–12. */
export interface ZonedWall {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** One formatter per zone: constructing them is what costs, not using them. */
function formatterFor(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (f === undefined) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      era: "short",
    });
    // Intl takes a name in any letter case, so the keys are not bounded by
    // the zone list; the cap keeps stored TZIDs from growing this forever.
    if (formatters.size >= 1000) formatters.clear();
    formatters.set(tz, f);
  }
  return f;
}

/** The wall-clock time `ms` shows in `tz`. */
export function instantToZonedWall(ms: number, tz: string): ZonedWall {
  const parts: Record<string, string> = {};
  for (const p of formatterFor(tz).formatToParts(new Date(ms))) parts[p.type] = p.value;
  const year = Number(parts.year);
  return {
    // `era` keeps a year before 1 CE from reading as a positive one.
    year: parts.era === "BC" ? 1 - year : year,
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

/** {@link utcOffsetMs} as `Intl` answers it, asked afresh every time. */
function askedOffsetMs(ms: number, tz: string): number {
  const w = instantToZonedWall(ms, tz);
  // Whole seconds: Intl formats no milliseconds, so compare like with like.
  const whole = Math.floor(ms / 1000) * 1000;
  // Not `Date.UTC`, which reads a year 0–99 as 1900–1999.
  const wall = new Date(0).setUTCFullYear(w.year, w.month - 1, w.day) + ((w.hour * 60 + w.minute) * 60 + w.second) * 1000;
  return wall - whole;
}

const DAY_MS = 86_400_000;

/** The offset in effect at a span's start, and every change in it: `at` is the first second of the new offset. */
interface OffsetChanges {
  first: number;
  changes: Array<{ at: number; from: number; to: number }>;
}

/**
 * Every change of `tz`'s UTC offset from `fromMs` to `toMs`, found by a daily
 * scan and a bisection to the second — about 370 `Intl` calls a year. Two
 * changes inside one day that cancel out would be missed; the zone database
 * has none since offsets were standardised.
 */
function offsetChanges(tz: string, fromMs: number, toMs: number): OffsetChanges {
  const start = Math.floor(fromMs / 1000) * 1000;
  const first = askedOffsetMs(start, tz);
  const changes: OffsetChanges["changes"] = [];
  let before = first;
  for (let lo = start; lo < toMs; lo += DAY_MS) {
    const hi = Math.min(lo + DAY_MS, toMs);
    const after = askedOffsetMs(hi, tz);
    if (after === before) continue;
    // The first second showing the new offset: lo still shows the old one.
    let a = lo;
    let b = hi;
    while (b - a > 1000) {
      const mid = a + Math.floor((b - a) / 2000) * 1000;
      if (askedOffsetMs(mid, tz) === before) a = mid;
      else b = mid;
    }
    const to = askedOffsetMs(b, tz);
    changes.push({ at: b, from: before, to });
    before = to;
    // Resume the scan from the transition, in case the day holds a second one.
    lo = b - DAY_MS;
  }
  return { first, changes };
}

/**
 * What is known of one zone's offsets in one calendar year (UTC): how often
 * it was asked for, and, once that passed {@link DIRECT_ASKS_PER_YEAR}, the
 * year's changes as {@link offsetChanges} found them.
 */
interface OffsetYear {
  asks: number;
  scanned: OffsetChanges | null;
}

/**
 * Each zone's years. Bounded like the formatters: TZIDs come from whatever
 * other clients stored.
 */
const offsetYears = new Map<string, Map<number, OffsetYear>>();

/**
 * Questions about one zone and year answered by asking `Intl` directly, one
 * `formatToParts` each, before the year is scanned instead — about 370 of
 * them — and every later question is a lookup. A daily series passes this in
 * its first weeks of each year; a yearly or monthly one, a dozen or so
 * questions per occurrence, never does, and never pays for the scan (review
 * of #225: scanning every year a yearly series since the year 100 touched
 * took 3.7 s, past the worker's deadline).
 */
const DIRECT_ASKS_PER_YEAR = 64;

/** 00:00Z on 1 January of `year`; `Date.UTC` would read 0–99 as 1900–1999. */
function startOfYear(year: number): number {
  return new Date(0).setUTCFullYear(year, 0, 1);
}

/**
 * The UTC offset in effect in `tz` at the instant `ms`, in milliseconds (east
 * positive). Exactly `Intl`'s answer, to the second.
 *
 * Remembered per zone and year (review of #223). Asked afresh, it cost two
 * `formatToParts` per call, and {@link IntlTimezone} asks eight or so per
 * occurrence expanded, so a daily series since 2016 in a zone with no
 * VTIMEZONE took 390 ms against 70 ms with one, and a daily series since 1990
 * over a second and a half. A year asked often is scanned once — a daily
 * scan, a few milliseconds — and every later call is a lookup; a year asked
 * only a few times is answered directly ({@link DIRECT_ASKS_PER_YEAR}), since
 * a scan would cost more than every question it saves. Both are `Intl`'s
 * own answer, so which one a call gets never changes the result.
 */
export function utcOffsetMs(ms: number, tz: string): number {
  if (!Number.isFinite(ms)) return askedOffsetMs(ms, tz);
  const year = new Date(ms).getUTCFullYear();
  let years = offsetYears.get(tz);
  if (years === undefined) {
    if (offsetYears.size >= 1000) offsetYears.clear();
    years = new Map();
    offsetYears.set(tz, years);
  }
  let entry = years.get(year);
  if (entry === undefined) {
    if (years.size >= 1000) years.clear();
    entry = { asks: 0, scanned: null };
    years.set(year, entry);
  }
  if (entry.scanned === null) {
    if (++entry.asks <= DIRECT_ASKS_PER_YEAR) return askedOffsetMs(ms, tz);
    entry.scanned = offsetChanges(tz, startOfYear(year), startOfYear(year + 1));
  }
  const known = entry.scanned;
  let offset = known.first;
  for (const change of known.changes) {
    if (change.at > ms) break;
    offset = change.to;
  }
  return offset;
}

/**
 * How far either side of a wall-clock time to look for the offsets that could
 * apply to it. An instant is the wall time minus an offset of at most ±14 h;
 * 36 h reaches past that with room, and no zone changes its offset twice
 * within a day and a half.
 */
const OFFSET_SEARCH_MS = 36 * 3600_000;

/**
 * The instant a wall-clock time in `tz` names. `month` is 1–12.
 *
 * Every instant has exactly one wall time, but a wall time can have none or
 * two instants, and RFC 5545 §3.3.5 says which one a DATE-TIME means:
 *
 *   - **In the gap** (spring forward; Berlin has no 02:30 on 2026-03-29) it is
 *     read with the offset from *before* the gap: 02:30 at +01:00, 01:30Z.
 *   - **In the overlap** (fall back; Berlin has 02:30 twice on 2026-10-25) it
 *     is the *first* occurrence: 02:30 at +02:00, 00:30Z.
 *
 * So this does not convert in two steps — offset at the wall time read as UTC,
 * then at the result — the way the spec's first draft did: that lands on
 * whichever side of the transition the guess fell, and in Berlin's overlap it
 * picked the second 02:30 (01:30Z). Instead it takes the offsets in effect a
 * day and a half either side, keeps each one that maps back to this wall time,
 * and picks by the rule.
 */
export function zonedWallToInstant(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  tz: string
): number {
  return wallToInstantBy(Date.UTC(year, month - 1, day, hour, minute), (ms) => utcOffsetMs(ms, tz));
}

/**
 * A zone as one question: the UTC offset in effect at an instant, in ms. Both
 * kinds of zone the connector does arithmetic in answer it exactly — `Intl`
 * through {@link utcOffsetMs}, a VTIMEZONE through {@link vtimezoneOffsetMs}
 * — and every conversion between wall time and instant is built on it, so the
 * two kinds cannot read one wall time two ways (review of #224).
 */
type OffsetAt = (ms: number) => number;

/**
 * RFC 5545 §3.3.5's reading of a wall time, `wall` being its fields read as
 * if they were UTC: {@link zonedWallToInstant}'s rule for any zone. Takes the
 * offsets in effect a day and a half either side, keeps each one that maps
 * back to this wall time, and picks the earliest; in a gap, where none does,
 * the offset from before it.
 */
function wallToInstantBy(wall: number, offsetAt: OffsetAt): number {
  const before = offsetAt(wall - OFFSET_SEARCH_MS);
  const after = offsetAt(wall + OFFSET_SEARCH_MS);
  const candidates = new Set([before, after, offsetAt(wall - before), offsetAt(wall - after)]);
  const valid = [...candidates]
    .map((offset) => wall - offset)
    .filter((instant) => offsetAt(instant) === wall - instant);
  // Overlap, or an ordinary time: the earliest instant showing this wall time.
  if (valid.length > 0) return Math.min(...valid);
  // Gap: no instant shows this wall time; read it with the offset before it.
  return wall - before;
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
 * Expanding a VTIMEZONE's observance rules is ical.js's own bounded walk to a
 * given year, the one every read of such a time already does; it is not an
 * event's recurrence rule.
 */
function vtimezoneOffsetMs(zone: ICAL.Timezone, ms: number): number {
  if (!zone.component) return 0;
  zone._ensureCoverage(new Date(ms).getUTCFullYear() + 1);
  let offset = 0;
  for (const change of zone.changes as Array<ZonedWall & { utcOffset: number }>) {
    const at = new Date(0).setUTCFullYear(change.year, change.month - 1, change.day) +
      ((change.hour * 60 + change.minute) * 60 + change.second) * 1000;
    if (at > ms) break;
    offset = change.utcOffset * 1000;
  }
  return offset;
}

/** The question {@link OffsetAt} for an ical.js zone, `Intl` or VTIMEZONE. */
function offsetsOf(zone: ICAL.Timezone): OffsetAt {
  if (zone instanceof IntlTimezone) {
    const iana = zone.iana;
    return (ms) => utcOffsetMs(ms, iana);
  }
  return (ms) => vtimezoneOffsetMs(zone, ms);
}

/** Names `Intl` refused, so a TZID repeated on every instance costs one RangeError, not one each. */
const notZones = new Set<string>();

/** True when `Intl` knows `name` as a zone. Offsets like `+01:00` are not zones here. */
function isIanaZone(name: string): boolean {
  if (!/^[A-Za-z]/.test(name) || notZones.has(name)) return false;
  try {
    formatterFor(name);
    return true;
  } catch {
    // Bounded: TZIDs come from whatever other clients stored.
    if (notZones.size >= 1000) notZones.clear();
    notZones.add(name);
    return false;
  }
}

/**
 * The IANA zone a TZID with no VTIMEZONE means, or null.
 *
 * An IANA name is taken as it is. A path-like TZID — Mozilla's
 * `/mozilla.org/20050126_1/Europe/Berlin`, Citadel's
 * `/citadel.org/20190914_1/America/Argentina/Buenos_Aires` — is read by its
 * tail, longest first, so a three-part name is not cut to a shorter one that
 * happens to exist. Anything else, a Windows name among them, is null: the
 * spec keeps refusing those (§1, "Out").
 */
export function resolveUnknownTzid(tzid: string): string | null {
  if (isIanaZone(tzid)) return tzid;
  const segments = tzid.split("/").filter(Boolean);
  for (let n = Math.min(3, segments.length - 1); n >= 1; n--) {
    const tail = segments.slice(-n).join("/");
    if (isIanaZone(tail)) return tail;
  }
  return null;
}

/**
 * An ical.js zone whose arithmetic is `Intl`'s. `tzid` stays the TZID as
 * stored, so a value ical.js writes back in this zone names it the way the
 * object did; `iana` is what `Intl` was asked.
 *
 * ical.js asks a zone one question — the UTC offset of a wall-clock time in
 * it — and this answers it with {@link zonedWallToInstant}, so the RFC 5545
 * rule for the gap and the overlap holds inside recurrence expansion too.
 */
export class IntlTimezone extends ICAL.Timezone {
  readonly iana: string;

  constructor(tzid: string, iana: string) {
    super({ tzid });
    this.iana = iana;
  }

  override utcOffset(tt: ICAL.Time): number {
    const wall = Date.UTC(tt.year, tt.month - 1, tt.day, tt.hour, tt.minute);
    return (wall - zonedWallToInstant(tt.year, tt.month, tt.day, tt.hour, tt.minute, this.iana)) / 1000;
  }
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
 */
export function withResolvedZones(vcal: ICAL.Component): { unresolved: string[] } {
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
 * {@link vtimezoneFromIntl} wrote. That block is exact only for the span it
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
 * The property {@link vtimezoneFromIntl} marks its block with. The block is
 * this connector's to regenerate only while it carries the mark; one without
 * it — any other client's, bounded or not — is how that client reads the
 * event, and is never rewritten.
 */
const GENERATED_MARK = "x-claude-mail-mcp-generated";

/** True for a VTIMEZONE {@link vtimezoneFromIntl} wrote for an IANA zone, TZID as `Intl` spells it. */
function isGeneratedVtimezone(component: ICAL.Component | null | undefined): boolean {
  if (!component?.hasProperty(GENERATED_MARK)) return false;
  const tzid = String(component.getFirstPropertyValue("tzid") ?? "");
  return canonicalZone(tzid) === tzid;
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
  const back = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
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

/** The UTC fields of `ms`, as a wall time: what a floating time's "instant" reads back as. */
function utcWall(ms: number): ZonedWall {
  const d = new Date(ms);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
  };
}

/**
 * The instant a wall time names in `zone`, by RFC 5545 §3.3.5's rule
 * ({@link wallToInstantBy}) whatever kind of zone it is: a VTIMEZONE and
 * `Intl` read the gap and the overlap the same way (review of #224). Whole
 * minutes, because that is what a transition is aligned to, and the seconds
 * added back, so a caller's `09:00:30` still comes back as `09:00:30`.
 */
function wallToInstantIn(w: ZonedWall, zone: ICAL.Timezone): number {
  const wall = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute);
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
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
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
  if (isFloating(time)) return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
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

/**
 * An IANA name in `Intl`'s canonical spelling (`europe/berlin` is
 * `Europe/Berlin`), or null for anything that is not one. What
 * `create_event`'s `timezone` accepts.
 */
export function canonicalZone(name: string): string | null {
  if (!isIanaZone(name)) return null;
  return formatterFor(name).resolvedOptions().timeZone;
}

/** True for the names that mean UTC itself, which is written as `…Z`, not as a TZID. */
export function isUtcName(zone: string): boolean {
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

/** `+0200`, `-0500`, `+0530`, with seconds only when a zone has them. */
function formatOffset(ms: number): string {
  const sign = ms < 0 ? "-" : "+";
  const total = Math.abs(Math.round(ms / 1000));
  const pad = (n: number): string => String(n).padStart(2, "0");
  const seconds = total % 60;
  return `${sign}${pad(Math.floor(total / 3600))}${pad(Math.floor(total / 60) % 60)}${seconds === 0 ? "" : pad(seconds)}`;
}

/** `20261025T030000`: a local DATE-TIME, for an observance's DTSTART. */
function formatLocal(w: ZonedWall): string {
  const pad = (n: number, width = 2): string => String(n).padStart(width, "0");
  return `${pad(w.year, 4)}${pad(w.month)}${pad(w.day)}T${pad(w.hour)}${pad(w.minute)}${pad(w.second)}`;
}

/**
 * A VTIMEZONE for the IANA zone `tz` that is exact from `fromMs` to `toMs`,
 * as iCalendar text (spec §2.5 A). `create_event` writes it for its `timezone`
 * with the event's span plus a year either side; it makes no recurring
 * events, so the span is short.
 *
 * One observance per transition, and none of them a rule: the offsets are
 * `Intl`'s, found by a daily scan and a bisection to the second, so the block
 * says exactly what the zone database says — Jerusalem's Friday before the
 * last Sunday of March, Casablanca's Ramadan — where a published RRULE-based
 * block was measured wrong (§0.1). The first observance is the offset in
 * effect at `fromMs`. An observance is DAYLIGHT when its offset is above the
 * lowest one in the span, STANDARD otherwise.
 *
 * The block carries `X-CLAUDE-MAIL-MCP-GENERATED` (RFC 5545 §3.6.5 allows an
 * x-prop in a VTIMEZONE; Radicale keeps it): the mark by which a later write
 * knows the block is bounded and this connector's to regenerate, see
 * {@link coverGeneratedVtimezone}.
 */
export function vtimezoneFromIntl(tz: string, fromMs: number, toMs: number): string {
  const start = Math.floor(fromMs / 1000) * 1000;
  const { first, changes } = offsetChanges(tz, start, toMs);
  const lowest = Math.min(first, ...changes.map((c) => c.to));
  const observance = (at: number, from: number, to: number): string[] => {
    const kind = to > lowest ? "DAYLIGHT" : "STANDARD";
    return [
      `BEGIN:${kind}`,
      // RFC 5545 §3.6.5: the onset as local time in the offset it replaces.
      `DTSTART:${formatLocal(utcWall(at + from))}`,
      `TZOFFSETFROM:${formatOffset(from)}`,
      `TZOFFSETTO:${formatOffset(to)}`,
      `END:${kind}`,
    ];
  };
  const lines = [
    "BEGIN:VTIMEZONE",
    `TZID:${tz}`,
    // RFC 5545 §3.6.5 allows x-props here; see GENERATED_MARK.
    `${GENERATED_MARK.toUpperCase()}:TRUE`,
    ...observance(start, first, first),
    ...changes.flatMap((c) => observance(c.at, c.from, c.to)),
    "END:VTIMEZONE",
  ];
  return `${lines.join("\r\n")}\r\n`;
}

/** How far either side of the times it serves a generated VTIMEZONE reaches (spec §2.5 A). */
const VTIMEZONE_MARGIN_MS = 366 * 86_400_000;

/**
 * {@link vtimezoneFromIntl} for the IANA zone `tz`, covering every instant in
 * `instants` and a year either side: what `create_event` writes, and what
 * {@link coverGeneratedVtimezone} writes again when an event moves.
 */
export function generatedVtimezone(tz: string, instants: number[]): ICAL.Component {
  const from = Math.min(...instants) - VTIMEZONE_MARGIN_MS;
  const to = Math.max(...instants) + VTIMEZONE_MARGIN_MS;
  return new ICAL.Component(ICAL.parse(`BEGIN:VCALENDAR\r\n${vtimezoneFromIntl(tz, from, to)}END:VCALENDAR\r\n`))
    .getFirstSubcomponent("vtimezone") as ICAL.Component;
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
 * so is an object whose times in the zone are all gone. An RRULE is not
 * followed: `create_event` writes no series, and `update_event` changes no
 * series' time, so no series holds a generated block today. The change that
 * lets one (v0.7.4 PR 4) has to decide how far such a block reaches.
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
  subcomponents[index] = generatedVtimezone(tzid, instants);
  vcal.removeAllSubcomponents();
  for (const c of subcomponents) vcal.addSubcomponent(c);
}
