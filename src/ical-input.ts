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
 *
 * v0.7.4 (#204, #205): also the one place a calendar user address is
 * normalised and compared — {@link mailtoOf}, {@link addressKey} and
 * {@link calendarUserAddresses}.
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

/** A `mailto:` prefix in any case: RFC 3986 §3.1 makes the scheme case-insensitive, and servers write `MAILTO:`. */
const MAILTO = /^mailto:/i;

/**
 * An attendee as the caller gave it — `ben@example.com`, or already
 * `mailto:ben@example.com`, in any case — as the calendar user address an
 * ATTENDEE (or ORGANIZER) holds: a `mailto:` URI, never prefixed twice. The
 * one normalisation `create_event` applies, here so an attendee edit applies
 * the same one. The address itself is written as given.
 */
export function mailtoOf(address: string): string {
  const bare = address.trim().replace(MAILTO, "");
  return `mailto:${bare}`;
}

/**
 * What two calendar user addresses are compared by (#204, #205): the address
 * without `mailto:`, trimmed and lower-cased — so `MAILTO:Ben@Example.com` in
 * a stored ATTENDEE, `ben@example.com` from the caller and the principal's
 * `mailto:ben@example.com` are one person. Every comparison of an ATTENDEE,
 * an ORGANIZER or the account's own addresses goes through here, and through
 * nothing else, so no two of them can disagree about who someone is.
 *
 * Lower-casing the local part is a simplification RFC 5321 does not make, but
 * every calendar server this connector meets compares addresses this way, and
 * two attendees who differ only in the case of their local part are the same
 * mailbox everywhere in practice.
 */
export function addressKey(address: string): string {
  return address.trim().replace(MAILTO, "").toLowerCase();
}

/**
 * The caller's `notify_attendees` for a call that adds or removes attendees
 * (spec 2026-09-29 §2.1), or a refusal ending in `nothingDone` when it was
 * left out. The tool schemas refuse that already (src/tools-calendar.ts);
 * this is the same rule for any other caller of `CalDavClient`, so no path
 * writes an attendee without someone having said whether the server may mail
 * them.
 */
export function notifyChoice(notify: boolean | undefined, nothingDone: string): boolean {
  if (notify === undefined) {
    throw new ToolRefusal(
      `Adding or removing attendees needs notify_attendees: true to let the calendar server email them (an invitation, update or cancellation, which cannot be recalled), or false to ask it not to. Confirm with the user which they want. ${nothingDone}`
    );
  }
  return notify;
}

/**
 * Refuse, ending in `nothingDone`, a list of addresses that names one person
 * twice, by {@link addressKey}: in `create_event`'s attendees, or across
 * `update_event`'s add and remove lists, where "add and remove Ben" has no
 * one meaning.
 */
export function distinctAddresses(addresses: readonly string[], nothingDone: string): void {
  const seen = new Set<string>();
  for (const address of addresses) {
    const key = addressKey(address);
    if (seen.has(key)) {
      throw new ToolRefusal(`${address} is named more than once among the attendees given. ${nothingDone}`);
    }
    seen.add(key);
  }
}

/**
 * The account's own calendar user addresses (spec 2026-09-29 §2.1), from the
 * `calendar-user-address-set` its CalDAV principal lists and the mailbox's
 * `mail.defaultFrom`: every `mailto:` the principal lists, in its order, and
 * the mailbox's address after them — each once, compared by
 * {@link addressKey}, and written by {@link mailtoOf}.
 *
 * The first is the one an ORGANIZER is written with. The principal's comes
 * first because it is the address the server compares ORGANIZER with to
 * decide "this account organizes it" (RFC 6638 §3.2): a Gmail mailbox with a
 * Nextcloud calendar has two addresses, and ORGANIZER set to the mailbox's
 * would make Nextcloud read the event as an invitation *received*. Radicale
 * lists only the principal's own href and no `mailto:` (R13), so there the
 * mailbox's address is the only one.
 */
export function calendarUserAddresses(principalHrefs: readonly string[], mailbox: string | undefined): string[] {
  const addresses: string[] = [];
  const seen = new Set<string>();
  const candidates = [...principalHrefs.filter((href) => MAILTO.test(href.trim())), ...(mailbox ? [mailbox] : [])];
  for (const candidate of candidates) {
    const key = addressKey(candidate);
    if (key === "" || seen.has(key)) continue;
    seen.add(key);
    addresses.push(mailtoOf(candidate));
  }
  return addresses;
}
