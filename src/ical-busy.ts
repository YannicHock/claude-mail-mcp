/**
 * Which of a stored object's occurrences block time, in epoch milliseconds:
 * the worker operation `find_free_slot` reads every object through (#213,
 * spec 2026-09-29 §2.7). src/free-slots.ts turns what it answers into slots.
 *
 * **Why a worker operation of its own.** Before v0.7.4's fix, the free-slot
 * search listed events as `list_events` does and read their reported
 * *strings* back into instants — which lost what the strings do not say
 * (`TRANSP`, `STATUS`, who declined), and dropped `skipped`, so the time of an
 * object that could not be read, was cut short or timed out counted as free
 * without a word. Here the busy time comes straight from the expansion, as
 * numbers, and an object's `skipped` travels with it: the caller names it in
 * the answer, and never reports its time as free in silence. It walks a
 * recurrence rule, so it runs in src/ical-worker-pool.ts under the same
 * deadline as `list_events`' expansion (src/ical-worker-ops.ts).
 *
 * **The filter is the connector's, not the server's** (spec §2.7): Radicale's
 * `free-busy-query` answer is not RFC 4791's shape (R12), and no server knows
 * which attendee is "self". Each occurrence is judged by the VEVENT it comes
 * from — an override, or the master — so a change to one occurrence counts
 * for that occurrence alone:
 *
 *   - `TRANSP:TRANSPARENT` ("show as free"): free.
 *   - `STATUS:CANCELLED`: free.
 *   - The account's own ATTENDEE with `PARTSTAT=DECLINED`: free. "Own" is the
 *     addresses the caller hands in — for `find_free_slot`, every one
 *     `CalDavClient.ownAddresses` gives and the mailbox's own (spec §2.7) —
 *     compared by `addressKey` (src/ical-attendees.ts) and nothing else.
 *     Listed under two of its addresses, it is free only when every one of
 *     them declined.
 *   - Everything else — `TENTATIVE`, `NEEDS-ACTION`, someone else's
 *     `DECLINED`, no attendees at all — is busy. RFC 5545's default `TRANSP`
 *     is `OPAQUE`, and an all-day event is no exception.
 *
 * **Times with no zone** — a floating event, an all-day one — name no instant
 * of their own; they are placed on the clock of the zone the working hours
 * are in, so a floating 09:00 is 09:00 where the user is looking, and an
 * all-day event is that local day, midnight to midnight.
 *
 * **An end that is not after its start, once placed** (review of PR #232).
 * Each occurrence has a nominal length: its end minus its start as written,
 * a floating time read on the clock alone. Three cases:
 *
 *   - Zero — a DTSTART with no DTEND or DURATION, which RFC 5545 §3.6.1 makes
 *     an event of no length — is reported as it is, zero-length, and blocks
 *     nothing (src/free-slots.ts's `mergeBusy` is the one place that drops
 *     an empty interval).
 *   - Positive, but placing it collapsed it: a floating 02:30–03:30 on
 *     Berlin's spring-forward night, whose 02:30 does not exist and is read
 *     as 03:30, where its end already is. It is clamped to its own nominal
 *     length from where its start was placed — busy for the hour it says,
 *     rather than for no time at all.
 *   - Negative — a DTEND before the DTSTART, which no conforming client
 *     writes — has no length to clamp to. The occurrence is left out and the
 *     object named in `skipped`, so its time is unknown, never free in
 *     silence.
 *
 * Plain data both ways (src/ical-worker-ops.ts): text, numbers and strings
 * in; numbers and a sentence out.
 */

import type ICAL from "ical.js";

import type { BusyInterval } from "./free-slots.js";
import { attendeesOf, addressKey } from "./ical-attendees.js";
import { MAX_OCCURRENCES_PER_OBJECT, readObject, type ExpandWindow, type Occurrence } from "./ical-expand.js";
import { instantOf } from "./ical-series.js";
import { instantAt, isFloating, wallOf, zonedWriteZone, type WriteZone } from "./ical-zones.js";

/** One object's busy time, as the worker hands it back. */
export interface BusyResult {
  /** Start inclusive and end exclusive, in the order the occurrences start; a zero-length one blocks nothing. */
  busy: BusyInterval[];
  /**
   * Why the object, or part of it, could not be read — the same sentence
   * `list_events` gives in `skipped`, or that an occurrence ends before it
   * starts. Its time is then unknown, not free.
   */
  skipped?: string;
}

/** The `skipped` sentence for an occurrence whose end is before its start. */
const ENDS_BEFORE_START =
  "An occurrence of it ends before it starts (its DTEND is earlier than its DTSTART), so the time it blocks is unknown and it was left out.";

/**
 * The busy time of the stored object `ics` in `window`. `own` is the account's
 * calendar user addresses (`mailto:` URIs; empty when none are known, which
 * makes every DECLINED busy); `zone` is the IANA name, or `"UTC"`, that
 * floating and all-day times are placed in. Never throws for anything in
 * `ics`.
 */
export function busyTimes(ics: string, window: ExpandWindow, own: readonly string[], zone: string): BusyResult {
  const ownKeys = new Set(own.map(addressKey));
  const place = zonedWriteZone(zone);
  let endsBeforeStart = false;
  const { items, skipped } = readObject(ics, window, MAX_OCCURRENCES_PER_OBJECT, (o: Occurrence): BusyInterval | null => {
    if (!blocksTime(o.vevent, ownKeys)) return null;
    const nominal = instantOf(o.end) - instantOf(o.start);
    if (nominal < 0) {
      endsBeforeStart = true;
      return null;
    }
    const start = placed(o.start, place);
    const end = placed(o.end, place);
    return { start, end: end > start || nominal === 0 ? end : start + nominal };
  });
  const busy = items.filter((b): b is BusyInterval => b !== null);
  const reasons = [...(skipped === undefined ? [] : [skipped]), ...(endsBeforeStart ? [ENDS_BEFORE_START] : [])];
  return reasons.length === 0 ? { busy } : { busy, skipped: reasons.join(" ") };
}

/** False for a VEVENT that is transparent, cancelled, or declined by the account (see the module comment). */
function blocksTime(vevent: ICAL.Component, ownKeys: ReadonlySet<string>): boolean {
  const upper = (name: string): string => String(vevent.getFirstPropertyValue(name) ?? "").trim().toUpperCase();
  if (upper("transp") === "TRANSPARENT") return false;
  if (upper("status") === "CANCELLED") return false;
  const mine: ICAL.Property[] = [];
  for (const [key, props] of attendeesOf(vevent)) if (ownKeys.has(key)) mine.push(...props);
  const declined = mine.length > 0 && mine.every((p) => String(p.getParameter("partstat") ?? "").toUpperCase() === "DECLINED");
  return !declined;
}

/** The instant `time` names; for a floating time or a date, its clock reading in `zone`. */
function placed(time: ICAL.Time, zone: WriteZone): number {
  // isFloating is true for a DATE too.
  if (isFloating(time)) return instantAt(wallOf(time), zone);
  return instantOf(time);
}
