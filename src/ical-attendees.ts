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

/**
 * Whether `remove_attendees` with `notify_attendees: false` is ever honoured
 * (spec 2026-09-29 §2.1): "honoured only if the Hetzner run (A2) shows that
 * Nextcloud sends no cancellation for an attendee who carried
 * SCHEDULE-AGENT=CLIENT. Otherwise refused". Until A2 has been run, every
 * such removal is refused ({@link checkRemoval}), whoever it names.
 *
 * Flip after acceptance A2 shows Nextcloud sends no cancellation for
 * SCHEDULE-AGENT=CLIENT. The rule it then switches on — removal with `false`
 * honoured for an attendee the server was never asked to schedule, and still
 * refused for one it was — is written and tested already
 * (test/unit/ical-attendees.test.ts runs it through the `honoured`
 * parameter), so flipping it is this one line. The `notify_attendees` text in
 * src/tools-calendar.ts and the CHANGELOG say removal with false is refused,
 * and change with it.
 */
export const REMOVE_WITHOUT_NOTIFY_HONOURED: boolean = false;

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
 * `mail.defaultFrom`: every `mailto:` the principal lists, in its order, each
 * once by {@link addressKey} and written by {@link mailtoOf} — or, when it
 * lists none, the mailbox's address alone.
 *
 * The first is the one an ORGANIZER is written with, and these are the
 * addresses an ORGANIZER is compared with to decide "the account's own
 * meeting". The principal's are the ones the server compares ORGANIZER with
 * (RFC 6638 §3.2), so where it lists any, they are the only ones (review of
 * PR #230): a Gmail mailbox with a Nextcloud calendar has two addresses, and
 * an invitation the user sent from Gmail to their Nextcloud address is, to
 * Nextcloud, someone else's meeting with the account as a guest — its guest
 * list is not the account's to change. ORGANIZER set to the mailbox's
 * address would likewise make Nextcloud read the account's own event as an
 * invitation *received*. Radicale lists only the principal's own href and no
 * `mailto:` (R13), so there the mailbox's address is the only one.
 */
export function calendarUserAddresses(principalHrefs: readonly string[], mailbox: string | undefined): string[] {
  const distinct = (candidates: readonly string[]): string[] => {
    const seen = new Set<string>();
    const addresses: string[] = [];
    for (const candidate of candidates) {
      const key = addressKey(candidate);
      if (key === "" || seen.has(key)) continue;
      seen.add(key);
      addresses.push(mailtoOf(candidate));
    }
    return addresses;
  };
  const principal = distinct(principalHrefs.filter((href) => MAILTO.test(href.trim())));
  return principal.length > 0 ? principal : distinct(mailbox ? [mailbox] : []);
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
 * What an attendee change did, for its caller: which VEVENTs it wrote, and
 * whom the calendar server may now email about the event.
 */
export interface AttendeeResult {
  /**
   * Every VEVENT of the UID this change wrote — the one or ones it was aimed
   * at, and any other it gave the ORGANIZER or marked `SCHEDULE-AGENT=CLIENT`
   * — whose revisions the caller stamps, each once.
   */
  changed: Set<ICAL.Component>;
  /**
   * Whom the calendar server may now email about this event (review of PR
   * #230), bare addresses, each once, in the order the object lists them:
   * every ATTENDEE of any VEVENT of the UID that the server is free to
   * schedule after this change — not `SCHEDULE-AGENT=CLIENT` or `NONE`, and
   * not the account itself — and anyone this call removed with `true` whom
   * it was free to schedule before, who may be sent a cancellation. It names
   * more than the attendees the call added: an ORGANIZER this call writes
   * turns every plain attendee already listed into one the server schedules.
   */
  mayNotify: string[];
}

/** Every VEVENT in `vevent`'s VCALENDAR with its UID, in document order: what one scheduling object is. `vevent` alone when it sits in none. */
function everyVeventOf(vevent: ICAL.Component): ICAL.Component[] {
  const uid = String(vevent.getFirstPropertyValue("uid"));
  const vcal = vevent.parent;
  if (vcal === null) return [vevent];
  return vcal.getAllSubcomponents("vevent").filter((ve) => String(ve.getFirstPropertyValue("uid")) === uid);
}

/**
 * True for an ATTENDEE the server is not to schedule: it carries
 * `SCHEDULE-AGENT=CLIENT` or `NONE` (RFC 6638 §7.1).
 */
function clientScheduled(prop: ICAL.Property): boolean {
  const agent = prop.getParameter("schedule-agent");
  return typeof agent === "string" && ["CLIENT", "NONE"].includes(agent.toUpperCase());
}

/**
 * Refuse, ending in `nothingDone`, a guest-list change on someone else's
 * meeting (spec §2.1): any VEVENT of the UID names an ORGANIZER that is none
 * of the account's `own` addresses. Every VEVENT, not only the one changed:
 * the server takes one scheduling object's organizer from whichever of its
 * VEVENTs names one. Only the organizer changes who is invited; the event's
 * text and time stay changeable, as the refusal says before it says that
 * nothing was changed.
 */
function checkOrganizer(vevents: readonly ICAL.Component[], own: readonly string[], nothingDone: string): void {
  const mine = new Set(own.map(addressKey));
  for (const vevent of vevents) {
    for (const organizer of vevent.getAllProperties("organizer")) {
      const address = addressKey(String(organizer.getFirstValue()));
      if (mine.has(address)) continue;
      throw new ToolRefusal(
        `This event is organized by ${address}, not by this account (${[...mine].join(", ")}), and only its organizer changes who is invited. Its title, description, location and time can still be changed here. ${nothingDone}`
      );
    }
  }
}

/**
 * Refuse, ending in `nothingDone`, removing attendees with `notify: false`
 * (spec §2.1: honoured only if acceptance A2 shows Nextcloud sends no
 * cancellation for an attendee who carried `SCHEDULE-AGENT=CLIENT`,
 * "otherwise refused").
 *
 * Until A2 is in, `honoured` is {@link REMOVE_WITHOUT_NOTIFY_HONOURED},
 * false, and every such removal is refused. Once it is flipped, a removal
 * with `false` is honoured for an attendee the server was never asked to
 * schedule — the object has no ORGANIZER yet, or every line of theirs on
 * `targets` carries `SCHEDULE-AGENT=CLIENT` or `NONE` — and still refused for
 * one it was free to schedule: taking them off may make it send a
 * cancellation whatever this call says, and nothing written here can stop
 * that. With `notify: true` the caller has accepted it.
 *
 * Either way, what to do instead comes before what was not done, and
 * leaving them listed first of all.
 */
function checkRemoval(
  targets: readonly ICAL.Component[],
  organized: boolean,
  call: AttendeeCall,
  honoured: boolean,
  nothingDone: string
): void {
  if (call.notify || call.remove.length === 0) return;
  const instead = "Leave them listed, or confirm with the user that they may be emailed and pass notify_attendees: true.";
  if (!honoured) {
    throw new ToolRefusal(
      `Removing attendees with notify_attendees: false is refused for now: whether the calendar server then stays silent or emails them a cancellation anyway, which cannot be recalled, has not been confirmed yet. ${instead} ${nothingDone}`
    );
  }
  if (!organized) return;
  for (const address of call.remove) {
    const key = addressKey(address);
    if (targets.some((ve) => (attendeesOf(ve).get(key) ?? []).some((prop) => !clientScheduled(prop)))) {
      throw new ToolRefusal(
        `${address} is on this event without SCHEDULE-AGENT=CLIENT, so the calendar server may already have told them about it, and removing them may make it email them a cancellation whatever notify_attendees says; this connector cannot prevent that. ${instead} ${nothingDone}`
      );
    }
  }
}

/**
 * Refuse, ending in `nothingDone`, adding someone `strict` already lists, or
 * removing someone no VEVENT in `strict` and `lenient` lists (spec §3.3). A
 * series' guest list is every occurrence's (review of PR #230): removing an
 * attendee only one changed occurrence lists takes them off that one, and
 * only an address none of them lists is refused, in words that say so.
 */
function checkGuestList(
  strict: ICAL.Component,
  lenient: readonly ICAL.Component[],
  call: AttendeeCall,
  nothingDone: string
): void {
  const listed = attendeesOf(strict);
  for (const address of call.add) {
    if (listed.has(addressKey(address))) {
      throw new ToolRefusal(`${address} is already an attendee of this event. ${nothingDone}`);
    }
  }
  const anywhere = new Set([strict, ...lenient].flatMap((ve) => [...attendeesOf(ve).keys()]));
  for (const address of call.remove) {
    if (anywhere.has(addressKey(address))) continue;
    const where = lenient.length > 0 ? "any occurrence of this series" : "this event";
    throw new ToolRefusal(`${address} is not an attendee of ${where}. ${nothingDone}`);
  }
}

/**
 * The bare addresses the server may schedule on `vevents`, as
 * {@link AttendeeResult.mayNotify} describes, starting from `removed` — the
 * ones this call took off with `true` — and never one of `own`. What
 * `create_event` answers as `may_notify`, over the event it built, with no
 * one removed.
 */
export function schedulable(vevents: readonly ICAL.Component[], removed: readonly string[], own: readonly string[]): string[] {
  const skip = new Set(own.map(addressKey));
  const named = new Map<string, string>();
  const note = (address: string): void => {
    const key = addressKey(address);
    if (!skip.has(key) && !named.has(key)) named.set(key, address.trim().replace(MAILTO, ""));
  };
  for (const address of removed) note(address);
  for (const vevent of vevents) {
    for (const prop of vevent.getAllProperties("attendee")) {
      if (!clientScheduled(prop)) note(String(prop.getFirstValue()));
    }
  }
  return [...named.values()];
}

/**
 * Write `call` in place, after every check has passed: the guest list of
 * `strict` (the event, the one occurrence, or a series' master), and of each
 * of `lenient` (a series' overrides) where it applies — adding only whom it
 * does not list and removing only whom it does. `vevents` is every VEVENT of
 * the UID.
 *
 *   - Every ATTENDEE this call does not name keeps its line exactly: its
 *     PARTSTAT, CN, ROLE, RSVP and every X- parameter.
 *   - An ATTENDEE added is written by {@link addAttendee}.
 *   - **The ORGANIZER goes on every VEVENT of the UID** (RFC 6638 §3.2.2,
 *     review of PR #230): the one some VEVENT already names, copied with its
 *     parameters, or — for an object with none, which `create_event` wrote
 *     before v0.7.4 (#204) — the account's `organizer`. Sabre takes the
 *     organizer from whichever VEVENT has one and schedules every attendee
 *     on every instance, so a VEVENT left without it would be scheduled all
 *     the same, unseen.
 *   - **An ORGANIZER this call supplies makes every plain attendee already
 *     listed, on every VEVENT of the UID, one the server would now
 *     schedule.** So with `notify: false` each of them that carries no
 *     SCHEDULE-AGENT of its own is marked `CLIENT`, on every VEVENT: they
 *     are affected by this call just as the ones it adds are. The review of
 *     PR #230 found them marked on the VEVENT being changed only, which left
 *     the rest of a series for Nextcloud to mail.
 */
function writeGuestList(
  vevents: readonly ICAL.Component[],
  strict: ICAL.Component,
  lenient: readonly ICAL.Component[],
  call: AttendeeCall,
  organizer: string
): Set<ICAL.Component> {
  const changed = new Set<ICAL.Component>();
  const existing = vevents.map((ve) => ve.getFirstProperty("organizer")).find((prop) => prop !== null) ?? null;
  for (const vevent of vevents) {
    if (vevent.hasProperty("organizer")) continue;
    if (existing === null) addOrganizer(vevent, organizer);
    else vevent.addProperty(new ICAL.Property(structuredClone(existing.toJSON())));
    changed.add(vevent);
  }
  if (existing === null && !call.notify) {
    for (const vevent of vevents) {
      for (const prop of vevent.getAllProperties("attendee")) {
        if (prop.getParameter("schedule-agent") !== undefined) continue;
        prop.setParameter("schedule-agent", "CLIENT");
        changed.add(vevent);
      }
    }
  }
  for (const vevent of [strict, ...lenient]) {
    const listed = attendeesOf(vevent);
    const adding = vevent === strict ? call.add : call.add.filter((address) => !listed.has(addressKey(address)));
    const removing = call.remove.filter((address) => listed.has(addressKey(address)));
    for (const address of removing) {
      for (const prop of listed.get(addressKey(address)) ?? []) vevent.removeProperty(prop);
    }
    for (const address of adding) addAttendee(vevent, address, call.notify);
    if (adding.length > 0 || removing.length > 0) changed.add(vevent);
  }
  return changed;
}

/**
 * The one guest-list change both entry points below make: every check, then
 * {@link writeGuestList}, then whom the server may now mail. `strict` is
 * held to "already an attendee" for an add; a removal needs someone on
 * `strict` or on one of `lenient` to remove. Every check comes before any
 * write, so a refusal — ending in `nothingDone` — leaves the object as it
 * was.
 */
function changeGuestList(
  strict: ICAL.Component,
  lenient: readonly ICAL.Component[],
  patch: AttendeePatch,
  own: readonly string[],
  nothingDone: string,
  honoured: boolean
): AttendeeResult | null {
  const call = attendeeCall(patch, nothingDone);
  if (call === null) return null;
  const organizer = organizerOf(own, nothingDone);
  const vevents = everyVeventOf(strict);
  checkOrganizer(vevents, own, nothingDone);
  const organized = vevents.some((ve) => ve.hasProperty("organizer"));
  const targets = [strict, ...lenient];
  checkRemoval(targets, organized, call, honoured, nothingDone);
  checkGuestList(strict, lenient, call, nothingDone);
  // Removed with true, from a line the server was free to schedule (once
  // there is an ORGANIZER): they may be sent a cancellation.
  const cancelled = call.notify
    ? call.remove.filter((address) =>
        targets.some((ve) => (attendeesOf(ve).get(addressKey(address)) ?? []).some((prop) => !clientScheduled(prop)))
      )
    : [];
  const changed = writeGuestList(vevents, strict, lenient, call, organizer);
  return { changed, mayNotify: schedulable(vevents, cancelled, own) };
}

/**
 * Add and remove the attendees `patch` names on one VEVENT — a main event,
 * or the override of the one occurrence a `recurrence_id` names, already in
 * its VCALENDAR — in place (#205, spec 2026-09-29 §2.1). Null when the patch
 * names no attendee. `own` is the account's calendar user addresses, the
 * first of them the one an ORGANIZER is written with.
 *
 * Refused, ending in `nothingDone`, with the object left as it was:
 * `notifyAttendees` missing, one address named twice, an account with no
 * address, someone else's meeting ({@link checkOrganizer}), a removal with
 * `false` ({@link checkRemoval}; `honoured` is
 * {@link REMOVE_WITHOUT_NOTIFY_HONOURED} except in the tests of the rule it
 * switches on), an attendee added who already is one or removed who is not.
 * What is written, on `vevent` and on any other VEVENT of its UID, is
 * {@link writeGuestList}'s. On one occurrence this changes that occurrence's
 * guest list alone, which RFC 5545 allows an override to have.
 */
export function applyAttendeePatch(
  vevent: ICAL.Component,
  patch: AttendeePatch,
  own: readonly string[],
  nothingDone: string,
  honoured: boolean = REMOVE_WITHOUT_NOTIFY_HONOURED
): AttendeeResult | null {
  return changeGuestList(vevent, [], patch, own, nothingDone, honoured);
}

/**
 * {@link applyAttendeePatch} for a whole series (`apply_to_series`): the
 * master is changed as a single event is, and every override the same way
 * where it applies — an attendee added to the series is added to each
 * occurrence changed on its own too, and one removed is taken off every
 * occurrence that lists them — so the guest list is the series' and not
 * only the unchanged occurrences'.
 */
export function patchSeriesAttendees(
  master: ICAL.Component,
  overrides: readonly ICAL.Component[],
  patch: AttendeePatch,
  own: readonly string[],
  nothingDone: string,
  honoured: boolean = REMOVE_WITHOUT_NOTIFY_HONOURED
): AttendeeResult | null {
  return changeGuestList(master, overrides, patch, own, nothingDone, honoured);
}
