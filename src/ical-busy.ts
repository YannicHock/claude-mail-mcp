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
 *   - The account's own ATTENDEE with `PARTSTAT=DECLINED`: free. "Own" is any
 *     of `CalDavClient.ownAddresses`, compared by `addressKey`
 *     (src/ical-attendees.ts) and nothing else. Listed under two of its
 *     addresses, it is free only when every one of them declined.
 *   - Everything else — `TENTATIVE`, `NEEDS-ACTION`, someone else's
 *     `DECLINED`, no attendees at all — is busy. RFC 5545's default `TRANSP`
 *     is `OPAQUE`, and an all-day event is no exception.
 *
 * **Times with no zone** — a floating event, an all-day one — name no instant
 * of their own; they are placed on the clock of the zone the working hours
 * are in, so a floating 09:00 is 09:00 where the user is looking, and an
 * all-day event is that local day, midnight to midnight.
 *
 * Plain data both ways (src/ical-worker-ops.ts): text, numbers and strings
 * in; numbers and a sentence out.
 */

import type ICAL from "ical.js";

import { attendeesOf, addressKey } from "./ical-attendees.js";
import { MAX_OCCURRENCES_PER_OBJECT, readObject, type ExpandWindow, type Occurrence } from "./ical-expand.js";
import { instantOf } from "./ical-series.js";
import { instantAt, isFloating, wallOf, zonedWriteZone, type WriteZone } from "./ical-zones.js";

/** One object's busy time, as the worker hands it back. */
export interface BusyResult {
  /** Epoch ms, start inclusive and end exclusive, in the order the occurrences start. */
  busy: Array<{ start: number; end: number }>;
  /**
   * Why the object, or part of it, could not be read — the same sentence
   * `list_events` gives in `skipped`. Its time is then unknown, not free.
   */
  skipped?: string;
}

/**
 * The busy time of the stored object `ics` in `window`. `own` is the account's
 * calendar user addresses (`mailto:` URIs, as `CalDavClient.ownAddresses`
 * gives them; empty when they could not be looked up, which makes every
 * DECLINED busy); `zone` is the IANA name, or `"UTC"`, that floating and
 * all-day times are placed in. Never throws for anything in `ics`.
 */
export function busyTimes(ics: string, window: ExpandWindow, own: readonly string[], zone: string): BusyResult {
  const ownKeys = new Set(own.map(addressKey));
  const place = zonedWriteZone(zone);
  const { items, skipped } = readObject(ics, window, MAX_OCCURRENCES_PER_OBJECT, (o: Occurrence) =>
    blocksTime(o.vevent, ownKeys) ? { start: placed(o.start, place), end: placed(o.end, place) } : null
  );
  const busy = items.filter((b): b is { start: number; end: number } => b !== null && b.end > b.start);
  return skipped === undefined ? { busy } : { busy, skipped };
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
