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
 * The writing half — a VTIMEZONE generated from `Intl` for `create_event`'s
 * `timezone` (spec §2.5 A) — is added by the zones-on-write change (plan
 * Task 4a) beside this one.
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

/** The UTC offset in effect in `tz` at the instant `ms`, in milliseconds (east positive). */
export function utcOffsetMs(ms: number, tz: string): number {
  const w = instantToZonedWall(ms, tz);
  // Whole seconds: Intl formats no milliseconds, so compare like with like.
  const whole = Math.floor(ms / 1000) * 1000;
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - whole;
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
