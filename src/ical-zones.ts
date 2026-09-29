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
 * {@link timeIn} makes the value to write. A Berlin event moved stays
 * `TZID=Europe/Berlin` local time, a UTC one stays UTC, a floating one stays
 * floating. The one VTIMEZONE the connector ever authors is
 * {@link vtimezoneFromIntl}'s, for `create_event`'s `timezone` (spec §2.5 A):
 * generated from `Intl` transition by transition, so it is exact where the
 * rejected package was not.
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
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - whole;
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
 * Each zone's offsets, one calendar year (UTC) at a time, as
 * {@link offsetChanges} found them. Bounded like the formatters: TZIDs come
 * from whatever other clients stored.
 */
const offsetYears = new Map<string, Map<number, OffsetChanges>>();

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
 * over a second and a half. A year's offsets are found once — a daily scan,
 * a few milliseconds — and every later call is a lookup.
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
  let known = years.get(year);
  if (known === undefined) {
    if (years.size >= 1000) years.clear();
    known = offsetChanges(tz, startOfYear(year), startOfYear(year + 1));
    years.set(year, known);
  }
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
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const before = utcOffsetMs(wall - OFFSET_SEARCH_MS, tz);
  const after = utcOffsetMs(wall + OFFSET_SEARCH_MS, tz);
  const candidates = new Set([before, after, utcOffsetMs(wall - before, tz), utcOffsetMs(wall - after, tz)]);
  const valid = [...candidates]
    .map((offset) => wall - offset)
    .filter((instant) => utcOffsetMs(instant, tz) === wall - instant);
  // Overlap, or an ordinary time: the earliest instant showing this wall time.
  if (valid.length > 0) return Math.min(...valid);
  // Gap: no instant shows this wall time; read it with the offset before it.
  return wall - before;
}

/** Names `Intl` refused, so a TZID repeated on every instance costs one RangeError, not one each. */
const notZones = new Set<string>();

/**
 * {@link zonedWallToInstant} with seconds: it works in whole minutes, because
 * that is what a transition is aligned to, and a caller's `09:00:30` should
 * still come back as `09:00:30`.
 */
function zonedWallToInstantWithSeconds(w: ZonedWall, tz: string): number {
  return zonedWallToInstant(w.year, w.month, w.day, w.hour, w.minute, tz) + w.second * 1000;
}

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
 *     {@link IntlTimezone} when it had none.
 */
export type WriteZone =
  | { kind: "utc" }
  | { kind: "floating" }
  | { kind: "zoned"; tzid: string; zone: ICAL.Timezone };

export const UTC_ZONE: WriteZone = { kind: "utc" };

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
      return { kind: "zoned", tzid: String(prop.getParameter("tzid")), zone: time.zone as ICAL.Timezone };
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

/** The instant a wall time names in `zone`, by the zone's own arithmetic. */
function wallToInstantIn(w: ZonedWall, zone: ICAL.Timezone): number {
  if (zone instanceof IntlTimezone) return zonedWallToInstantWithSeconds(w, zone.iana);
  return ICAL.Time.fromData({ ...w, isDate: false }, zone).toUnixTime() * 1000;
}

/**
 * The wall time `ms` shows in `zone`.
 *
 * For an {@link IntlTimezone} that is `Intl`'s answer. A VTIMEZONE answers only
 * the other question — the offset of a wall time — so the wall time is found
 * the way {@link zonedWallToInstant} finds an instant: take the offsets in
 * effect a day and a half either side, and keep the wall time that maps back
 * to `ms`. ical.js's own conversion does it in two naive steps and lands on
 * the wrong side of a transition near one.
 */
function wallIn(ms: number, zone: ICAL.Timezone): ZonedWall {
  if (zone instanceof IntlTimezone) return instantToZonedWall(ms, zone.iana);
  const offsets = [ms, ms - OFFSET_SEARCH_MS, ms + OFFSET_SEARCH_MS].map(
    (probe) => zone.utcOffset(ICAL.Time.fromData({ ...utcWall(probe), isDate: false }, zone)) * 1000
  );
  for (const offset of offsets) {
    const wall = utcWall(ms + offset);
    if (wallToInstantIn(wall, zone) === ms) return wall;
  }
  // The second pass through an autumn overlap: no local time names it
  // (RFC 5545 §3.3.5 reads the wall time as the first pass), so the nearest
  // one does.
  return utcWall(ms + offsets[0]);
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
 * A stored time as {@link readDateTime} would have read it: the instant, or
 * for a floating time its clock time read as UTC. `toJSDate` would read a
 * floating time in the process's own zone.
 */
export function msOf(time: ICAL.Time): number {
  if (isFloating(time)) {
    return Date.UTC(time.year, time.month - 1, time.day, time.hour, time.minute, time.second);
  }
  return time.toUnixTime() * 1000;
}

/** The DATE-TIME to write for `ms` (as {@link readDateTime} returns it) in `zone`. */
export function timeIn(ms: number, zone: WriteZone): ICAL.Time {
  const whole = Math.floor(ms / 1000) * 1000;
  if (zone.kind === "utc") return ICAL.Time.fromJSDate(new Date(whole), true);
  if (zone.kind === "floating") return ICAL.Time.fromData({ ...utcWall(whole), isDate: false });
  return ICAL.Time.fromData({ ...wallIn(whole, zone.zone), isDate: false }, zone.zone);
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
    ...observance(start, first, first),
    ...changes.flatMap((c) => observance(c.at, c.from, c.to)),
    "END:VTIMEZONE",
  ];
  return `${lines.join("\r\n")}\r\n`;
}
