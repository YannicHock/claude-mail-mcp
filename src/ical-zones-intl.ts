/**
 * The `Intl` half of the zone arithmetic (#234, out of src/ical-zones.ts):
 * wall-clock time in an IANA zone from nothing but the ICU data every Node
 * build carries. The UTC offset in effect at an instant, exactly `Intl`'s and
 * remembered per zone and year ({@link utcOffsetMs}); a wall time back to its
 * instant by RFC 5545 §3.3.5's rule for the gap and the overlap
 * ({@link wallToInstantBy}), for any zone that can answer "what offset at
 * this instant"; whether a name is an IANA zone, and how `Intl` spells it;
 * and {@link IntlTimezone}, the ical.js zone whose arithmetic this is.
 *
 * Why `Intl` rather than a package of published VTIMEZONE blocks, and where
 * each time's arithmetic comes from, is src/ical-zones.ts's header. Nothing
 * here imports another module of this connector.
 */

import ICAL from "ical.js";

/** A wall-clock reading in some zone. `month` is 1–12. */
export interface ZonedWall {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/**
 * The epoch ms of clock fields read as UTC — what `Date.UTC` answers, except
 * for the years 0–99, which `Date.UTC` reads as 1900–1999. iCalendar has
 * such years (a yearly series may start in the year 50), and a wall time
 * built with `Date.UTC` there landed 1900 years late: `instantAt` and
 * `wallToInstantIn` did (fix pass of PR #232). Every wall time in src/ is
 * turned into ms here, and nowhere by `Date.UTC`.
 *
 * `month` is 1–12. Fields past their range roll over, as with `Date.UTC`: day
 * 32 is the first of the next month, hour 24 the next day — the round trip
 * in `wallOfIso` relies on that to catch a clock time no calendar has.
 */
export function utcMs(year: number, month: number, day: number, hour = 0, minute = 0, second = 0): number {
  return new Date(0).setUTCFullYear(year, month - 1, day) + ((hour * 60 + minute) * 60 + second) * 1000;
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
  const wall = utcMs(w.year, w.month, w.day, w.hour, w.minute, w.second);
  return wall - whole;
}

/**
 * 24 hours in milliseconds: a span of instants, never "one calendar day",
 * which on the day of a DST change is 23 or 25 hours (step a day on the
 * wall clock with `addToWall` in src/ical-zones.ts for that). Exported so a margin or a cap
 * measured in days says so, instead of a bare 86_400_000.
 */
export const DAY_MS = 86_400_000;

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
export function offsetChanges(tz: string, fromMs: number, toMs: number): OffsetChanges {
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

/** 00:00Z on 1 January of `year`. */
function startOfYear(year: number): number {
  return utcMs(year, 1, 1);
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
  return wallToInstantBy(utcMs(year, month, day, hour, minute), (ms) => utcOffsetMs(ms, tz));
}

/**
 * A zone as one question: the UTC offset in effect at an instant, in ms. Both
 * kinds of zone the connector does arithmetic in answer it exactly — `Intl`
 * through {@link utcOffsetMs}, a VTIMEZONE through `vtimezoneOffsetMs` in src/ical-zones.ts
 * — and every conversion between wall time and instant is built on it, so the
 * two kinds cannot read one wall time two ways (review of #224).
 */
export type OffsetAt = (ms: number) => number;

/**
 * RFC 5545 §3.3.5's reading of a wall time, `wall` being its fields read as
 * if they were UTC: {@link zonedWallToInstant}'s rule for any zone. Takes the
 * offsets in effect a day and a half either side, keeps each one that maps
 * back to this wall time, and picks the earliest; in a gap, where none does,
 * the offset from before it.
 */
export function wallToInstantBy(wall: number, offsetAt: OffsetAt): number {
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
    const wall = utcMs(tt.year, tt.month, tt.day, tt.hour, tt.minute);
    return (wall - zonedWallToInstant(tt.year, tt.month, tt.day, tt.hour, tt.minute, this.iana)) / 1000;
  }
}

/** The UTC fields of `ms`, as a wall time: what a floating time's "instant" reads back as. */
export function utcWall(ms: number): ZonedWall {
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
 * An IANA name in `Intl`'s canonical spelling (`europe/berlin` is
 * `Europe/Berlin`), or null for anything that is not one. What
 * `create_event`'s `timezone` accepts.
 */
export function canonicalZone(name: string): string | null {
  if (!isIanaZone(name)) return null;
  return formatterFor(name).resolvedOptions().timeZone;
}
