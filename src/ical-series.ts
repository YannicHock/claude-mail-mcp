/**
 * What tells one VEVENT of a series from another, and which of them counts:
 * the rules the reader (src/ical-expand.ts, for `list_events` and
 * `findOccurrence`) and the writers (src/ical-edit.ts and the modules beside
 * it) must apply the same way, or a write addresses an override `list_events`
 * never showed.
 *
 * They were written twice until the code-health review of PR #229: a private
 * `sequenceOf` in the reader and an exported one in the writer, and the
 * read-back after a write (`writtenBy`) compared SEQUENCEs across the two
 * copies. The writer also imported its series identity from the reader. Both
 * now import it from here; this module imports neither.
 *
 * Nothing here walks a recurrence rule: it is safe on the connector's own
 * thread (src/ical-worker-ops.ts).
 */

import ICAL from "ical.js";

/**
 * The instant a time names, in epoch ms. A floating time or a date has none,
 * so it is read as if it were UTC — what RFC 4791 §9.9 does with one when the
 * calendar has no zone, and what the server's own time-range filter did.
 */
export function instantOf(time: ICAL.Time): number {
  return time.toUnixTime() * 1000;
}

/**
 * What an occurrence of a series is matched by: the date for an all-day
 * series (or a DATE value), and the instant otherwise. ical.js matches an
 * override to an occurrence by the text of its RECURRENCE-ID, wall clock or
 * UTC, so one written in another zone, or as a midnight DATE-TIME for an
 * all-day series, matched nothing — and the master's occurrence was listed at
 * the old time while the override vanished (review of #223).
 *
 * The reader and the writers both key by it (#206), so the override a write
 * addresses is the one `list_events` matched to that occurrence.
 */
export function keyOf(time: ICAL.Time, allDay: boolean): string {
  if (allDay || time.isDate) return `${time.year}-${time.month}-${time.day}`;
  return String(instantOf(time));
}

/**
 * A VEVENT's SEQUENCE: absent, or not a number, counts as 0 (RFC 5545
 * §3.8.7.4). The one reading every edit raises (#214) and every comparison of
 * revisions uses, because `CalDavClient`'s read-back after a write trusts the
 * two to agree — if they drifted, it would hand back no etag for its own
 * write, or someone else's for it.
 */
export function sequenceOf(vevent: ICAL.Component): number {
  const sequence = Number(vevent.getFirstPropertyValue("sequence") ?? 0);
  return Number.isFinite(sequence) ? sequence : 0;
}

/** An override VEVENT with the one ICAL.Event read from it, built once and used for its key, times and all. */
export interface Override {
  ve: ICAL.Component;
  event: ICAL.Event;
}

/**
 * The override that counts for each occurrence, by {@link keyOf} its
 * RECURRENCE-ID. Two overrides for one occurrence are two revisions of it,
 * and RFC 5545 §3.8.7.4 makes the one with the highest SEQUENCE current;
 * between equal ones the later in the object wins, as it did when ical.js
 * matched them. The others are dropped here, so none can come back as an
 * extra event the walk never met (review of #225: the first was kept, and the
 * newer one listed beside it as a phantom).
 */
export function currentOverrides(overrides: ICAL.Component[], allDay: boolean): Map<string, Override> {
  const byKey = new Map<string, Override>();
  for (const ve of overrides) {
    const event = new ICAL.Event(ve);
    const key = keyOf(event.recurrenceId, allDay);
    const held = byKey.get(key);
    if (held === undefined || sequenceOf(ve) >= sequenceOf(held.ve)) byKey.set(key, { ve, event });
  }
  return byKey;
}

/**
 * True when `master` (absent for an object that holds only overrides) is an
 * all-day series: its occurrences, and every RECURRENCE-ID naming one, are
 * keyed by date.
 */
export function allDaySeries(master: ICAL.Component | undefined): boolean {
  return (master?.getFirstPropertyValue("dtstart") as ICAL.Time | null | undefined)?.isDate === true;
}

/** True for an override that also moves every later occurrence (`RANGE=THISANDFUTURE`). */
export function modifiesFuture(ve: ICAL.Component): boolean {
  const range = ve.getFirstProperty("recurrence-id")?.getParameter("range");
  return typeof range === "string" && range.toUpperCase() === "THISANDFUTURE";
}

/**
 * The `RANGE=THISANDFUTURE` override whose change reaches the occurrence
 * starting at `at` (a rule's time, in the master's zone): of those in
 * `ranges`, the one with the latest RECURRENCE-ID not after `at`, the later
 * in the object on a tie — the one ical.js's `getOccurrenceDetails` applies
 * when `list_events` lists that occurrence. Its own `findRangeException` is
 * not used: its declared type (an Event) is not what it returns (a key).
 */
export function governingRange(ranges: ICAL.Component[], at: ICAL.Time): ICAL.Component | undefined {
  const atMs = instantOf(at);
  let best: ICAL.Component | undefined;
  let bestMs = -Infinity;
  for (const ve of ranges) {
    const ms = instantOf(new ICAL.Event(ve).recurrenceId);
    if (ms <= atMs && ms >= bestMs) {
      best = ve;
      bestMs = ms;
    }
  }
  return best;
}
