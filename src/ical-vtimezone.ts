/**
 * The one VTIMEZONE this connector authors (spec 2026-09-29 §2.5 A), for
 * `create_event`'s `timezone`: generated from `Intl` transition by
 * transition, so it is exact where a published RRULE-based block was measured
 * wrong, and marked, so a later write knows the block is bounded and this
 * connector's to regenerate ({@link isGeneratedVtimezone}). Moved out of
 * src/ical-zones.ts (#234); the regeneration itself, which walks every time
 * an object holds, is `coverGeneratedVtimezone` there.
 */

import ICAL from "ical.js";
import { canonicalZone, DAY_MS, offsetChanges, utcWall, type ZonedWall } from "./ical-zones-intl.js";

/**
 * The property {@link vtimezoneFromIntl} marks its block with. The block is
 * this connector's to regenerate only while it carries the mark; one without
 * it — any other client's, bounded or not — is how that client reads the
 * event, and is never rewritten.
 */
const GENERATED_MARK = "x-claude-mail-mcp-generated";

/** True for a VTIMEZONE {@link vtimezoneFromIntl} wrote for an IANA zone, TZID as `Intl` spells it. */
export function isGeneratedVtimezone(component: ICAL.Component | null | undefined): boolean {
  if (!component?.hasProperty(GENERATED_MARK)) return false;
  const tzid = String(component.getFirstPropertyValue("tzid") ?? "");
  return canonicalZone(tzid) === tzid;
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
 * `coverGeneratedVtimezone` in src/ical-zones.ts.
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
const VTIMEZONE_MARGIN_MS = 366 * DAY_MS;

/**
 * {@link vtimezoneFromIntl} for the IANA zone `tz`, covering every instant in
 * `instants` and a year either side: what `create_event` writes, and what
 * `coverGeneratedVtimezone` in src/ical-zones.ts writes again when an event moves.
 */
export function generatedVtimezone(tz: string, instants: number[]): ICAL.Component {
  const from = Math.min(...instants) - VTIMEZONE_MARGIN_MS;
  const to = Math.max(...instants) + VTIMEZONE_MARGIN_MS;
  return new ICAL.Component(ICAL.parse(`BEGIN:VCALENDAR\r\n${vtimezoneFromIntl(tz, from, to)}END:VCALENDAR\r\n`))
    .getFirstSubcomponent("vtimezone") as ICAL.Component;
}
