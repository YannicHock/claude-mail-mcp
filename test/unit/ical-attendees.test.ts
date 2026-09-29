/**
 * ORGANIZER and attendees (#204, #205, spec 2026-09-29 §2.1): what
 * `create_event` writes for its attendees, and what `update_event`'s
 * `add_attendees` / `remove_attendees` do to a stored object. No network:
 * every case is a hand-written object and the text that comes back.
 *
 * These are the writes that decide whether a calendar server mails real
 * people, so each case pins exactly which ATTENDEE carries
 * `SCHEDULE-AGENT=CLIENT` (RFC 6638: "the client handles this attendee; the
 * server sends it nothing") and which does not. What a real server then does
 * with it is known only from the Hetzner acceptance run (A1, A2): these tests
 * prove what is written, never that anyone is or is not mailed.
 *
 * The fixtures carry every ATTENDEE parameter another client writes, because
 * a guest list that only ever holds bare addresses cannot tell an in-place
 * edit from a rebuilt one — and a rebuild would reset everyone's reply.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildIcs } from "../../src/ical-build.js";
import { addressKey, calendarUserAddresses, mailtoOf, touchesAttendees } from "../../src/ical-attendees.js";
import { applyEventPatch, changesSomething, type EventPatch } from "../../src/ical-edit.js";
import { applyOccurrencePatch } from "../../src/ical-occurrence-edit.js";
import { parseCalendar } from "../../src/ical-parse.js";
import { shiftSeries } from "../../src/ical-series-shift.js";
import { ToolRefusal } from "../../src/tool-refusal.js";
import { block, occurrence, SHAPES, unfold, UID, weekly } from "../helpers/ical-series-fixtures.js";

const NOW = new Date("2026-09-28T12:00:00Z");
const CHANGED = "Nothing was changed.";
const CREATED = "Nothing was created.";

/** The account's own addresses as `ownAddresses` hands them out: the principal's first, the mailbox's last. */
const OWN = ["mailto:me@cloud.example", "mailto:me@mail.example"] as const;

function ics(...lines: string[]): string {
  return `${lines.join("\r\n")}\r\n`;
}

/** One event the account organizes, with two attendees another client wrote and everything an edit must keep. */
function mine(organizer = "ORGANIZER;CN=Me:MAILTO:Me@Cloud.example"): string {
  return ics(
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Other Client//EN",
    "BEGIN:VEVENT",
    "UID:meeting@example.com",
    "DTSTAMP:20260901T080000Z",
    "DTSTART:20261001T090000Z",
    "DTEND:20261001T100000Z",
    "SUMMARY:Planning",
    "SEQUENCE:2",
    organizer,
    "ATTENDEE;CN=Ben;PARTSTAT=ACCEPTED;ROLE=REQ-PARTICIPANT;RSVP=TRUE;X-NUM-GUESTS=0:mailto:ben@example.com",
    "ATTENDEE;CN=Cara;PARTSTAT=TENTATIVE;SCHEDULE-AGENT=CLIENT:mailto:cara@example.com",
    "X-KEEP-ME:yes",
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    "TRIGGER:-PT15M",
    "DESCRIPTION:Reminder",
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR"
  );
}

const BEN = "ATTENDEE;CN=Ben;PARTSTAT=ACCEPTED;ROLE=REQ-PARTICIPANT;RSVP=TRUE;X-NUM-GUESTS=0:mailto:ben@example.com";
const CARA = "ATTENDEE;CN=Cara;PARTSTAT=TENTATIVE;SCHEDULE-AGENT=CLIENT:mailto:cara@example.com";

/** Someone else's meeting, as an invitation received is stored. */
const THEIRS = mine("ORGANIZER;CN=Anna:mailto:anna@example.com");

/** Attendees and no ORGANIZER: what `create_event` wrote before v0.7.4 (#204). */
const NO_ORGANIZER = ics(
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//claude-mail-mcp//EN",
  "BEGIN:VEVENT",
  "UID:meeting@example.com",
  "DTSTAMP:20260901T080000Z",
  "DTSTART:20261001T090000Z",
  "DTEND:20261001T100000Z",
  "SUMMARY:Planning",
  "ATTENDEE;CN=Ben;PARTSTAT=ACCEPTED:mailto:ben@example.com",
  "END:VEVENT",
  "END:VCALENDAR"
);

/** No one invited yet. */
const PLAIN = ics(
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//Other Client//EN",
  "BEGIN:VEVENT",
  "UID:meeting@example.com",
  "DTSTAMP:20260901T080000Z",
  "DTSTART:20261001T090000Z",
  "DTEND:20261001T100000Z",
  "SUMMARY:Planning",
  "END:VEVENT",
  "END:VCALENDAR"
);

const MEETING = "meeting@example.com";

/** {@link applyEventPatch} with the account's addresses, answering the new text, unfolded. */
function patched(text: string, patch: EventPatch, uid = MEETING): string {
  return unfold(applyEventPatch(parseCalendar(text), uid, patch, { nothingDone: CHANGED, now: NOW, own: OWN }).ics);
}

/** The refusal `run` throws, which must end in `nothingDone`. */
function refused(run: () => unknown, nothingDone = CHANGED): string {
  try {
    run();
  } catch (err) {
    assert.ok(err instanceof ToolRefusal, `expected a ToolRefusal, got ${String(err)}`);
    assert.match(err.message, new RegExp(nothingDone.replace(/\./g, "\\.")));
    return err.message;
  }
  assert.fail("the call was expected to be refused");
}

/** The ATTENDEE lines of `text` (unfolded), in order. */
function attendees(text: string): string[] {
  return unfold(text).split("\r\n").filter((line) => /^ATTENDEE[;:]/.test(line));
}

function organizerOf(text: string): string | undefined {
  return unfold(text).split("\r\n").find((line) => /^ORGANIZER[;:]/.test(line));
}

describe("calendar user addresses (src/ical-attendees.ts) — the one place an address is normalised", () => {
  it("compares addresses case-insensitively, with or without mailto:, in any case", () => {
    assert.equal(addressKey("MAILTO:Ben@Example.COM"), addressKey("ben@example.com"));
    assert.equal(addressKey("mailto:ben@example.com"), addressKey(" Ben@example.com "));
    assert.notEqual(addressKey("ben@example.com"), addressKey("ben@example.org"));
  });

  it("writes mailto: once, whatever case the caller's prefix was in", () => {
    assert.equal(mailtoOf("ben@example.com"), "mailto:ben@example.com");
    assert.equal(mailtoOf("mailto:ben@example.com"), "mailto:ben@example.com");
    assert.equal(mailtoOf("MAILTO:ben@example.com"), "mailto:ben@example.com");
  });

  it("R13: a principal with no mailto: (Radicale) leaves the mailbox's address alone", () => {
    assert.deepEqual(calendarUserAddresses(["/u1/"], "me@mail.example"), ["mailto:me@mail.example"]);
  });

  it("puts the principal's mailto: first — the address the server compares ORGANIZER with — and the mailbox's after it, once", () => {
    assert.deepEqual(
      calendarUserAddresses(
        ["/remote.php/dav/principals/users/me/", "mailto:Me@Cloud.example", "MAILTO:me@cloud.example", "mailto:me@mail.example"],
        "ME@mail.example"
      ),
      ["mailto:Me@Cloud.example", "mailto:me@mail.example"]
    );
  });
});

describe("create_event's attendees (#204, spec §2.1)", () => {
  const BASE = {
    summary: "Planning",
    start: "2026-10-01T09:00:00Z",
    end: "2026-10-01T10:00:00Z",
    uid: "new@claude-mail-mcp",
  };

  it("writes ORGANIZER as the account's own address, and each attendee plainly with notify_attendees: true", () => {
    const text = buildIcs(
      { ...BASE, attendees: ["ben@example.com", "cara@example.com"], notifyAttendees: true, own: OWN },
      "UTC",
      CREATED,
      NOW
    );
    assert.equal(organizerOf(text), "ORGANIZER:mailto:me@cloud.example");
    assert.deepEqual(attendees(text), ["ATTENDEE:mailto:ben@example.com", "ATTENDEE:mailto:cara@example.com"]);
  });

  it("marks every attendee SCHEDULE-AGENT=CLIENT with notify_attendees: false", () => {
    const text = buildIcs(
      { ...BASE, attendees: ["ben@example.com", "cara@example.com"], notifyAttendees: false, own: OWN },
      "UTC",
      CREATED,
      NOW
    );
    assert.equal(organizerOf(text), "ORGANIZER:mailto:me@cloud.example");
    assert.deepEqual(attendees(text), [
      "ATTENDEE;SCHEDULE-AGENT=CLIENT:mailto:ben@example.com",
      "ATTENDEE;SCHEDULE-AGENT=CLIENT:mailto:cara@example.com",
    ]);
  });

  it("writes no ORGANIZER for an event with no attendees, as before", () => {
    const text = buildIcs({ ...BASE, own: OWN }, "UTC", CREATED, NOW);
    assert.equal(organizerOf(text), undefined);
    assert.deepEqual(attendees(text), []);
  });

  it("refuses attendees without notify_attendees, and creates nothing", () => {
    const message = refused(
      () => buildIcs({ ...BASE, attendees: ["ben@example.com"], own: OWN }, "UTC", CREATED, NOW),
      CREATED
    );
    assert.match(message, /notify_attendees/);
  });

  it("refuses an address named twice, in any case, and creates nothing", () => {
    const message = refused(
      () =>
        buildIcs(
          { ...BASE, attendees: ["ben@example.com", "Ben@Example.com"], notifyAttendees: true, own: OWN },
          "UTC",
          CREATED,
          NOW
        ),
      CREATED
    );
    assert.match(message, /ben@example\.com/i);
  });
});

describe("update_event's add_attendees and remove_attendees (#205, spec §2.1)", () => {
  it("counts as a change on its own", () => {
    assert.equal(changesSomething({ addAttendees: ["dan@example.com"] }), true);
    assert.equal(changesSomething({ removeAttendees: ["ben@example.com"] }), true);
    assert.equal(changesSomething({ addAttendees: [], removeAttendees: [] }), false);
    assert.equal(touchesAttendees({ addAttendees: [], removeAttendees: [] }), false);
  });

  it("adds an attendee with notify_attendees: true plainly; everyone else, the ORGANIZER, VALARM and X- properties are kept as they were", () => {
    const text = patched(mine(), { addAttendees: ["dan@example.com"], notifyAttendees: true });
    assert.deepEqual(attendees(text), [BEN, CARA, "ATTENDEE:mailto:dan@example.com"]);
    assert.equal(organizerOf(text), "ORGANIZER;CN=Me:MAILTO:Me@Cloud.example");
    assert.match(text, /\r\nBEGIN:VALARM\r\nACTION:DISPLAY\r\nTRIGGER:-PT15M\r\n/);
    assert.match(text, /\r\nX-KEEP-ME:yes\r\n/);
    assert.match(text, /\r\nSEQUENCE:3\r\n/);
  });

  it("marks only the attendee it adds SCHEDULE-AGENT=CLIENT with notify_attendees: false", () => {
    const text = patched(mine(), { addAttendees: ["dan@example.com"], notifyAttendees: false });
    assert.deepEqual(attendees(text), [BEN, CARA, "ATTENDEE;SCHEDULE-AGENT=CLIENT:mailto:dan@example.com"]);
  });

  it("removes only the attendee named, compared case-insensitively on the address", () => {
    const text = patched(mine(), { removeAttendees: ["BEN@Example.com"], notifyAttendees: true });
    assert.deepEqual(attendees(text), [CARA]);
  });

  it("removes an attendee the server was told nothing about (SCHEDULE-AGENT=CLIENT) with notify_attendees: false", () => {
    const text = patched(mine(), { removeAttendees: ["cara@example.com"], notifyAttendees: false });
    assert.deepEqual(attendees(text), [BEN]);
  });

  it("refuses to remove, with notify_attendees: false, an attendee the server was free to notify: it may send a cancellation whatever this says", () => {
    const message = refused(() => patched(mine(), { removeAttendees: ["ben@example.com"], notifyAttendees: false }));
    assert.match(message, /ben@example\.com/);
    assert.match(message, /cancellation/);
    assert.match(message, /notify_attendees: true/);
  });

  // Plan Task 6 / spec §2.1: removal with `false` is honoured only if the
  // Hetzner run (A2) shows Nextcloud sends no cancellation for an attendee who
  // carried SCHEDULE-AGENT=CLIENT. The case above it assumes it does not. If
  // A2 shows Nextcloud cancels regardless, this one replaces it: un-skip it,
  // and delete "removes an attendee the server was told nothing about".
  it.skip("A2 fallback: remove_attendees with notify_attendees: false is refused, even for an attendee carrying SCHEDULE-AGENT=CLIENT (only if A2 shows Nextcloud cancels regardless)", () => {
    const message = refused(() => patched(mine(), { removeAttendees: ["cara@example.com"], notifyAttendees: false }));
    assert.match(message, /notify_attendees: true/);
  });

  it("refuses notify_attendees missing, and changes nothing", () => {
    const message = refused(() => patched(mine(), { addAttendees: ["dan@example.com"] }));
    assert.match(message, /notify_attendees/);
  });

  it("refuses adding an attendee who already is one, in any case, and changes nothing", () => {
    const parsed = parseCalendar(mine());
    const before = parsed.vcal.toString();
    const message = refused(() =>
      applyEventPatch(parsed, MEETING, { summary: "Renamed", addAttendees: ["Ben@Example.com", "dan@example.com"], notifyAttendees: true }, { nothingDone: CHANGED, now: NOW, own: OWN })
    );
    assert.match(message, /Ben@Example\.com is already an attendee/);
    assert.equal(parsed.vcal.toString(), before);
  });

  it("refuses removing an address that is no attendee, and changes nothing", () => {
    const parsed = parseCalendar(mine());
    const before = parsed.vcal.toString();
    const message = refused(() =>
      applyEventPatch(parsed, MEETING, { removeAttendees: ["ben@example.com", "zoe@example.com"], notifyAttendees: true }, { nothingDone: CHANGED, now: NOW, own: OWN })
    );
    assert.match(message, /zoe@example\.com is not an attendee/);
    assert.equal(parsed.vcal.toString(), before);
  });

  it("refuses one address named twice, or both added and removed", () => {
    assert.match(
      refused(() => patched(mine(), { addAttendees: ["dan@example.com", "DAN@example.com"], notifyAttendees: true })),
      /dan@example\.com/i
    );
    assert.match(
      refused(() => patched(mine(), { addAttendees: ["dan@example.com"], removeAttendees: ["dan@example.com"], notifyAttendees: true })),
      /dan@example\.com/
    );
  });

  it("refuses a change to the guest list of someone else's meeting, naming its organizer", () => {
    const parsed = parseCalendar(THEIRS);
    const before = parsed.vcal.toString();
    const message = refused(() =>
      applyEventPatch(parsed, MEETING, { addAttendees: ["dan@example.com"], notifyAttendees: false }, { nothingDone: CHANGED, now: NOW, own: OWN })
    );
    assert.match(message, /anna@example\.com/);
    assert.match(message, /only its organizer/);
    assert.equal(parsed.vcal.toString(), before);
    refused(() => patched(THEIRS, { removeAttendees: ["ben@example.com"], notifyAttendees: true }));
  });

  it("still changes the text of someone else's meeting, and leaves its guest list alone", () => {
    const text = patched(THEIRS, { summary: "Planning (my note)" });
    assert.match(text, /\r\nSUMMARY:Planning \(my note\)\r\n/);
    assert.deepEqual(attendees(text), [BEN, CARA]);
    assert.equal(organizerOf(text), "ORGANIZER;CN=Anna:mailto:anna@example.com");
  });

  it("takes the mailbox's address as the account's own too", () => {
    const text = patched(mine("ORGANIZER:mailto:ME@mail.example"), { addAttendees: ["dan@example.com"], notifyAttendees: true });
    assert.equal(attendees(text).length, 3);
  });

  it("gives an event with attendees and no ORGANIZER one on its first attendee change: the account's first address", () => {
    const text = patched(NO_ORGANIZER, { addAttendees: ["dan@example.com"], notifyAttendees: true });
    assert.equal(organizerOf(text), "ORGANIZER:mailto:me@cloud.example");
    assert.deepEqual(attendees(text), ["ATTENDEE;CN=Ben;PARTSTAT=ACCEPTED:mailto:ben@example.com", "ATTENDEE:mailto:dan@example.com"]);
  });

  it("with notify_attendees: false, the ORGANIZER it adds does not make the server notify the attendees already listed either", () => {
    // Before the ORGANIZER, the server treated none of them as invited; with
    // it, every plain ATTENDEE becomes one it would schedule. So `false`
    // reaches them too: they are affected by this call.
    const text = patched(NO_ORGANIZER, { removeAttendees: ["ben@example.com"], addAttendees: ["dan@example.com"], notifyAttendees: false });
    assert.deepEqual(attendees(text), ["ATTENDEE;SCHEDULE-AGENT=CLIENT:mailto:dan@example.com"]);
    const kept = patched(NO_ORGANIZER, { addAttendees: ["dan@example.com"], notifyAttendees: false });
    assert.deepEqual(attendees(kept), [
      "ATTENDEE;CN=Ben;PARTSTAT=ACCEPTED;SCHEDULE-AGENT=CLIENT:mailto:ben@example.com",
      "ATTENDEE;SCHEDULE-AGENT=CLIENT:mailto:dan@example.com",
    ]);
  });

  it("adds no ORGANIZER for a change that leaves the attendees alone", () => {
    assert.equal(organizerOf(patched(NO_ORGANIZER, { summary: "Renamed" })), undefined);
  });

  it("makes the account ORGANIZER of an event it invites the first person to", () => {
    const text = patched(PLAIN, { addAttendees: ["dan@example.com"], notifyAttendees: true });
    assert.equal(organizerOf(text), "ORGANIZER:mailto:me@cloud.example");
    assert.deepEqual(attendees(text), ["ATTENDEE:mailto:dan@example.com"]);
  });
});

describe("attendees of a series and of one occurrence (#205 with #206, #207)", () => {
  const shape = SHAPES.find((s) => s.name === "UTC");
  assert.ok(shape);
  /** The weekly fixture, organized by the account. */
  const series = weekly(shape, "FREQ=WEEKLY;COUNT=5", ["ORGANIZER:mailto:me@cloud.example"]);

  it("apply_to_series: every occurrence gets the new attendee, the ones changed on their own too, each with a new revision", () => {
    const text = patched(series, { addAttendees: ["dan@example.com"], notifyAttendees: false }, UID);
    const master = block(text, null);
    const moved = block(text, "RECURRENCE-ID:20261015T090000Z");
    for (const ve of [master, moved]) assert.match(ve, /\r\nATTENDEE;SCHEDULE-AGENT=CLIENT:mailto:dan@example\.com\r\n/);
    assert.match(master, /\r\nATTENDEE;CN=Ben;PARTSTAT=ACCEPTED;ROLE=REQ-PARTICIPANT:mailto:ben@example\.com\r\n/);
    assert.match(moved, /\r\nSEQUENCE:2\r\n/);
    // The moved occurrence had no ORGANIZER of its own; it has the series' now.
    assert.match(moved, /\r\nORGANIZER:mailto:me@cloud\.example\r\n/);
  });

  it("apply_to_series: removing an attendee takes them off every occurrence that lists them", () => {
    const text = patched(series, { removeAttendees: ["ben@example.com"], notifyAttendees: true }, UID);
    assert.doesNotMatch(text, /ben@example\.com/);
  });

  it("apply_to_series with a new time: the attendee and the time land in one revision per VEVENT", () => {
    const parsed = parseCalendar(series);
    const text = unfold(
      shiftSeries(parsed, UID, null, { start: "2026-10-01T15:00:00Z", addAttendees: ["dan@example.com"], notifyAttendees: true }, { nothingDone: CHANGED, now: NOW, own: OWN }).ics
    );
    const master = block(text, null);
    assert.match(master, /\r\nDTSTART:20261001T150000Z\r\n/);
    assert.match(master, /\r\nATTENDEE:mailto:dan@example\.com\r\n/);
    assert.match(master, /\r\nSEQUENCE:4\r\n/);
    const moved = block(text, "RECURRENCE-ID:20261015T150000Z");
    assert.match(moved, /\r\nATTENDEE:mailto:dan@example\.com\r\n/);
    assert.match(moved, /\r\nSEQUENCE:2\r\n/);
  });

  it("recurrence_id: the attendee is added to that one occurrence, and the series is left as it was", () => {
    const rid = "2026-10-08T09:00:00.000Z";
    const text = unfold(
      applyOccurrencePatch(parseCalendar(series), UID, occurrence(series, rid), { addAttendees: ["dan@example.com"], notifyAttendees: false }, { nothingDone: CHANGED, now: NOW, own: OWN }).ics
    );
    const one = block(text, "RECURRENCE-ID:20261008T090000Z");
    assert.match(one, /\r\nATTENDEE;CN=Ben;PARTSTAT=ACCEPTED;ROLE=REQ-PARTICIPANT:mailto:ben@example\.com\r\n/);
    assert.match(one, /\r\nATTENDEE;SCHEDULE-AGENT=CLIENT:mailto:dan@example\.com\r\n/);
    assert.doesNotMatch(block(text, null), /dan@example\.com/);
    assert.doesNotMatch(block(text, "RECURRENCE-ID:20261015T090000Z"), /dan@example\.com/);
  });

  it("recurrence_id: refused for one occurrence of someone else's series, and nothing is changed", () => {
    const theirs = weekly(shape, "FREQ=WEEKLY;COUNT=5", ["ORGANIZER:mailto:anna@example.com"]);
    const rid = "2026-10-08T09:00:00.000Z";
    refused(() =>
      applyOccurrencePatch(parseCalendar(theirs), UID, occurrence(theirs, rid), { removeAttendees: ["ben@example.com"], notifyAttendees: true }, { nothingDone: CHANGED, now: NOW, own: OWN })
    );
  });
});
