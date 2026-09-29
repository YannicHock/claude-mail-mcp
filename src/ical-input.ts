/**
 * What a caller hands `create_event` and `update_event`, read into what an
 * iCalendar object holds: a date, an instant, a calendar user address. Each
 * reader refuses what it cannot read with a {@link ToolRefusal} ending in the
 * caller's `nothingDone`, so a mistyped date is a sentence for the model and
 * never a server failure in the operator's log (spec 2026-09-28 §4.5).
 *
 * Shared by the builder (src/ical-build.ts) and the editors
 * (src/ical-edit.ts and the modules beside it). The builder imported them
 * from the editor until the code-health review of PR #229, which would have
 * tied `create_event` to every module the editor grew; they live here now,
 * with nothing to import but the zone arithmetic.
 */

import { hasOffset, readDateTime, type WriteZone } from "./ical-zones.js";
import { ToolRefusal } from "./tool-refusal.js";

/** Midnight UTC of the date part, so all-day arithmetic counts whole days. */
export function dateMs(iso: string): number {
  return Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);
}

/** `YYYY-MM-DD` of an epoch-ms midnight {@link dateMs} produced (or any instant, by its UTC date). */
export function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * A caller's all-day bound as `YYYY-MM-DD`, or a refusal ending in
 * `nothingDone`. The round trip catches a date that parses but does not
 * exist: `2026-13-45` would otherwise roll over and be written as a date in
 * 2027.
 */
export function calendarDate(field: "start" | "end", value: string, nothingDone: string): string {
  const day = value.slice(0, 10);
  const ms = /^\d{4}-\d{2}-\d{2}$/.test(day) ? dateMs(day) : NaN;
  if (Number.isNaN(ms) || isoDate(ms) !== day) {
    throw new ToolRefusal(
      `${field} "${value}" is not a calendar date (YYYY-MM-DD) for an all-day event. ${nothingDone}`
    );
  }
  return day;
}

/**
 * A caller's timed bound, read for `zone` by `readDateTime`
 * (src/ical-zones.ts), or a refusal ending in `nothingDone`. Unchecked, an
 * unreadable value is NaN, and the RangeError that follows reaches the
 * operator's log as a server failure — the noise spec §4.5 exists to keep
 * out of it.
 *
 * A floating zone refuses a value with an offset (#209, spec §2.5): the event
 * has no zone to convert it into, and silently dropping the offset would move
 * it by that much.
 */
export function timedBound(field: "start" | "end", value: string, zone: WriteZone, nothingDone: string): number {
  if (zone.kind === "floating" && hasOffset(value)) {
    throw new ToolRefusal(
      `This event is floating: it is stored as clock time with no time zone, and shows at that clock time wherever it is read. So its ${field} must be given without an offset, like 2026-10-01T09:00:00, and "${value}" has one. ${nothingDone}`
    );
  }
  const ms = readDateTime(value, zone);
  if (Number.isNaN(ms)) {
    throw new ToolRefusal(
      `${field} "${value}" is not an ISO 8601 date-time, like 2026-10-01T09:00:00+02:00. ${nothingDone}`
    );
  }
  return ms;
}

/**
 * An attendee as the caller gave it — `ben@example.com`, or already
 * `mailto:ben@example.com` — as the calendar user address an ATTENDEE (or
 * ORGANIZER) holds: a `mailto:` URI, never prefixed twice. The one
 * normalisation `create_event` applies, here so an attendee edit applies the
 * same one.
 */
export function mailtoOf(address: string): string {
  return address.startsWith("mailto:") ? address : `mailto:${address}`;
}
