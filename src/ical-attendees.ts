/**
 * Who is invited to an event, and who organizes it (#204, #205, spec
 * 2026-09-29 §2.1): the one module that reads and writes ORGANIZER and
 * ATTENDEE. These are the lines that decide whether a calendar server
 * (Nextcloud, through Sabre's scheduling plugin, RFC 6638) mails real
 * people, so every such line this connector writes is written here — by
 * {@link addOrganizer} and {@link addAttendee}, for `create_event`'s builder
 * (src/ical-build.ts) and for every editor alike — and every comparison of
 * two calendar user addresses goes through {@link addressKey}.
 *
 * It depends on ical.js and `ToolRefusal` alone, and on no editor, so that
 * the worker (src/ical-worker.ts) can read an event's guest list with
 * {@link attendeesOf} and {@link addressKey} — `find_free_slot` needs the
 * account's own PARTSTAT (#213) — without importing everything the editors
 * import. Moved here out of src/ical-edit.ts and src/ical-input.ts in the
 * code-health review of PR #230.
 *
 * What the account's own addresses are is the caller's to say: `own` is
 * always `ownAddresses` in src/caldav-client.ts, passed in as data
 * ({@link calendarUserAddresses}), and the first of them is the one an
 * ORGANIZER is written with ({@link organizerOf}).
 */

import ICAL from "ical.js";
import { ToolRefusal } from "./tool-refusal.js";

/** A `mailto:` prefix in any case: RFC 3986 §3.1 makes the scheme case-insensitive, and servers write `MAILTO:`. */
const MAILTO = /^mailto:/i;

/**
 * An address as the caller gave it — `ben@example.com`, or already
 * `mailto:ben@example.com`, in any case — as the calendar user address an
 * ATTENDEE (or ORGANIZER) holds: a `mailto:` URI, never prefixed twice. The
 * one normalisation this connector applies to an address it writes; the
 * address itself is written as given.
 */
export function mailtoOf(address: string): string {
  const bare = address.trim().replace(MAILTO, "");
  return `mailto:${bare}`;
}

/**
 * What two calendar user addresses are compared by: the address without
 * `mailto:`, trimmed and lower-cased — so `MAILTO:Ben@Example.com` in a
 * stored ATTENDEE, `ben@example.com` from the caller and the principal's
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

/**
 * The address an ORGANIZER is written with: the first of the account's `own`
 * addresses, or a refusal ending in `nothingDone` when it has none — the one
 * sentence for it, whether `create_event` or an attendee edit asks.
 */
export function organizerOf(own: readonly string[], nothingDone: string): string {
  const [first] = own;
  if (first === undefined) {
    throw new ToolRefusal(
      `This account has no email address to organize the event with: its calendar lists none and its mailbox has no sender address. ${nothingDone}`
    );
  }
  return first;
}

/**
 * The caller's `notify_attendees` for a call that adds or removes attendees
 * (spec 2026-09-29 §2.1), or a refusal ending in `nothingDone` when it was
 * left out.
 *
 * Three places refuse a missing `notify_attendees`, and it is worth knowing
 * which is which. The guard a model meets is the tool schema's refinement
 * (src/tools-calendar.ts): the SDK refuses the call before any handler runs.
 * `CalDavClient` repeats the check before contacting the server, for any
 * caller that is not the MCP tool. This one is the last: every writer of an
 * attendee goes through it, so no code path can write one without someone
 * having said whether the server may mail them, and it turns the optional
 * field into the boolean the writers below take.
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

/** The attendee half of `update_event`'s patch (#205); `EventPatch` (src/ical-edit.ts) extends it. */
export interface AttendeePatch {
  /** Email addresses to invite. Non-empty needs {@link AttendeePatch.notifyAttendees}. */
  addAttendees?: string[];
  /** Email addresses to take off the guest list. Non-empty needs {@link AttendeePatch.notifyAttendees}. */
  removeAttendees?: string[];
  /**
   * The caller's answer to "may the calendar server mail them?" (spec
   * 2026-09-29 §2.1): `true` writes the attendees plainly, `false` marks the
   * ones this call affects `SCHEDULE-AGENT=CLIENT`. Required whenever either
   * list above is non-empty.
   */
  notifyAttendees?: boolean;
}

/** True when the patch adds or removes an attendee (#205): the change that may make a server mail people. */
export function touchesAttendees(patch: AttendeePatch): boolean {
  return (patch.addAttendees?.length ?? 0) > 0 || (patch.removeAttendees?.length ?? 0) > 0;
}

/**
 * Write `ORGANIZER:mailto:<address>` on `vevent`: the account as the
 * organizer, a bare `mailto:` as `create_event` has always written its
 * attendees. One of the two writers of the lines that decide mail.
 */
export function addOrganizer(vevent: ICAL.Component, address: string): void {
  const prop = new ICAL.Property("organizer");
  prop.setValue(mailtoOf(address));
  vevent.addProperty(prop);
}

/**
 * Add `ATTENDEE:mailto:<address>` to `vevent`, with `SCHEDULE-AGENT=CLIENT`
 * (RFC 6638 §7.1: the client handles this attendee, the server sends it
 * nothing) when `notify` is false. The other writer of the lines that decide
 * mail: `create_event`'s attendees and every one an edit adds.
 */
export function addAttendee(vevent: ICAL.Component, address: string, notify: boolean): void {
  const prop = new ICAL.Property("attendee");
  prop.setValue(mailtoOf(address));
  if (!notify) prop.setParameter("schedule-agent", "CLIENT");
  vevent.addProperty(prop);
}

/**
 * The VEVENT's ATTENDEE properties by {@link addressKey}: one person may be
 * listed more than once. Pure reading, for the editors here and for the
 * worker (the account's own PARTSTAT in `find_free_slot`, #213).
 */
export function attendeesOf(vevent: ICAL.Component): Map<string, ICAL.Property[]> {
  const byKey = new Map<string, ICAL.Property[]>();
  for (const prop of vevent.getAllProperties("attendee")) {
    const key = addressKey(String(prop.getFirstValue()));
    byKey.set(key, [...(byKey.get(key) ?? []), prop]);
  }
  return byKey;
}

/**
 * The attendee half of a patch, checked: who is added, who is removed, and
 * whether the server may mail them.
 */
interface AttendeeCall {
  add: readonly string[];
  remove: readonly string[];
  notify: boolean;
}

/** The attendee half of `patch`, or null when it has none; refused, ending in `nothingDone`, without `notifyAttendees` or with one address named twice. */
function attendeeCall(patch: AttendeePatch, nothingDone: string): AttendeeCall | null {
  if (!touchesAttendees(patch)) return null;
  const notify = notifyChoice(patch.notifyAttendees, nothingDone);
  const add = patch.addAttendees ?? [];
  const remove = patch.removeAttendees ?? [];
  distinctAddresses([...add, ...remove], nothingDone);
  return { add, remove, notify };
}

/**
 * True when the server was never asked to schedule this ATTENDEE of `vevent`,
 * so removing it gives the server no one to send a cancellation to: it
 * carries `SCHEDULE-AGENT=CLIENT` or `NONE` (RFC 6638 §7.1), or the VEVENT
 * has no ORGANIZER, without which RFC 6638 §3.1 makes it no scheduling object
 * at all.
 */
function unscheduled(vevent: ICAL.Component, prop: ICAL.Property): boolean {
  if (!vevent.hasProperty("organizer")) return true;
  const agent = prop.getParameter("schedule-agent");
  return typeof agent === "string" && ["CLIENT", "NONE"].includes(agent.toUpperCase());
}

/**
 * Refuse an attendee change on `vevent` that this connector cannot make as
 * asked, ending in `nothingDone`, before anything is written:
 *
 *   - **Someone else's meeting** (spec §2.1): its ORGANIZER is none of the
 *     account's `own` addresses. Only the organizer changes who is invited;
 *     the event's text and time stay changeable, as the refusal says.
 *   - **Removing, with `notify: false`, an attendee the server may already
 *     have told** — one it was free to schedule ({@link unscheduled} is
 *     false). Taking them off may make it send a cancellation whatever this
 *     call says, and nothing written here can stop that; with `true` the
 *     caller has accepted it.
 */
function checkAttendeeChange(vevent: ICAL.Component, call: AttendeeCall, own: readonly string[], nothingDone: string): void {
  const organizer = vevent.getFirstProperty("organizer");
  if (organizer !== null) {
    const address = addressKey(String(organizer.getFirstValue()));
    if (!own.some((mine) => addressKey(mine) === address)) {
      throw new ToolRefusal(
        `This event is organized by ${address}, not by this account (${own.map(addressKey).join(", ")}), and only its organizer changes who is invited. ${nothingDone} Its title, description, location and time can still be changed here.`
      );
    }
  }
  if (call.notify) return;
  const listed = attendeesOf(vevent);
  for (const address of call.remove) {
    if ((listed.get(addressKey(address)) ?? []).some((prop) => !unscheduled(vevent, prop))) {
      throw new ToolRefusal(
        `${address} is on this event without SCHEDULE-AGENT=CLIENT, so the calendar server may already have told them about it, and removing them may make it email them a cancellation whatever notify_attendees says; this connector cannot prevent that. ${nothingDone} To remove them anyway, confirm with the user and pass notify_attendees: true.`
      );
    }
  }
}

/** Refuse, ending in `nothingDone`, adding someone `vevent` already lists or removing someone it does not (spec §3.3). */
function checkGuestList(vevent: ICAL.Component, call: AttendeeCall, nothingDone: string): void {
  const listed = attendeesOf(vevent);
  for (const address of call.add) {
    if (listed.has(addressKey(address))) {
      throw new ToolRefusal(`${address} is already an attendee of this event. ${nothingDone}`);
    }
  }
  for (const address of call.remove) {
    if (!listed.has(addressKey(address))) {
      throw new ToolRefusal(`${address} is not an attendee of this event. ${nothingDone}`);
    }
  }
}

/**
 * Write `call` into `vevent`, in place, and say whether anything changed.
 * `lenient` (an override of a series whose master was checked) adds only
 * whom it does not list and removes only whom it does; otherwise the caller
 * has run {@link checkGuestList}.
 *
 *   - Every ATTENDEE this call does not name keeps its line exactly: its
 *     PARTSTAT, CN, ROLE, RSVP and every X- parameter.
 *   - An ATTENDEE added is written by {@link addAttendee}.
 *   - A VEVENT with no ORGANIZER (one `create_event` wrote before v0.7.4,
 *     #204) gets the account's first address as one. That makes the
 *     attendees it already lists ones the server would now schedule too, so
 *     with `notify: false` each of them that carries no SCHEDULE-AGENT of its
 *     own is marked `CLIENT` as well: they are affected by this call just as
 *     the ones it adds are.
 */
function writeAttendees(vevent: ICAL.Component, call: AttendeeCall, organizer: string, lenient: boolean): boolean {
  const listed = attendeesOf(vevent);
  const adding = call.add.filter((address) => !lenient || !listed.has(addressKey(address)));
  const removing = call.remove.filter((address) => listed.has(addressKey(address)));
  if (adding.length === 0 && removing.length === 0) return false;
  if (!vevent.hasProperty("organizer")) {
    addOrganizer(vevent, organizer);
    if (!call.notify) {
      for (const prop of vevent.getAllProperties("attendee")) {
        if (prop.getParameter("schedule-agent") === undefined) prop.setParameter("schedule-agent", "CLIENT");
      }
    }
  }
  for (const address of removing) {
    for (const prop of listed.get(addressKey(address)) ?? []) vevent.removeProperty(prop);
  }
  for (const address of adding) addAttendee(vevent, address, call.notify);
  return true;
}

/**
 * Add and remove the attendees `patch` names on one VEVENT — a main event,
 * or the override of the one occurrence a `recurrence_id` names — in place
 * (#205, spec 2026-09-29 §2.1), and say whether it changed. Nothing when the
 * patch names no attendee. `own` is the account's calendar user addresses,
 * the first of them the one an ORGANIZER is written with. The caller stamps
 * the VEVENT's revision.
 *
 * Every check comes before any write, so a refusal — ending in `nothingDone`
 * — leaves `vevent` as it was: `notifyAttendees` missing, one address named
 * twice, someone else's meeting, a quiet removal the server may not keep
 * quiet ({@link checkAttendeeChange}), an attendee added who already is one
 * or removed who is not. What is written is {@link writeAttendees}'s.
 */
export function applyAttendeePatch(
  vevent: ICAL.Component,
  patch: AttendeePatch,
  own: readonly string[],
  nothingDone: string
): boolean {
  const call = attendeeCall(patch, nothingDone);
  if (call === null) return false;
  const organizer = organizerOf(own, nothingDone);
  checkAttendeeChange(vevent, call, own, nothingDone);
  checkGuestList(vevent, call, nothingDone);
  return writeAttendees(vevent, call, organizer, false);
}

/**
 * {@link applyAttendeePatch} for a whole series (`apply_to_series`): the
 * master is changed as a single event is, and every override the same way
 * where it applies. Returns the overrides it changed, whose revisions the
 * caller stamps. Every VEVENT is checked before any is written.
 */
export function patchSeriesAttendees(
  master: ICAL.Component,
  overrides: readonly ICAL.Component[],
  patch: AttendeePatch,
  own: readonly string[],
  nothingDone: string
): ICAL.Component[] {
  const call = attendeeCall(patch, nothingDone);
  if (call === null) return [];
  const organizer = organizerOf(own, nothingDone);
  for (const vevent of [master, ...overrides]) checkAttendeeChange(vevent, call, own, nothingDone);
  checkGuestList(master, call, nothingDone);
  writeAttendees(master, call, organizer, false);
  return overrides.filter((vevent) => writeAttendees(vevent, call, organizer, true));
}
