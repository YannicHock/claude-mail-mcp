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
import type ICAL from "ical.js";

import { buildIcs } from "../../src/ical-build.js";
import {
  addressKey,
  applyAttendeePatch,
  calendarUserAddresses,
  mailtoOf,
  mayNotifyAbout,
  patchSeriesAttendees,
  schedulingObject,
  touchesAttendees,
  type AttendeePatch,
} from "../../src/ical-attendees.js";
import { applyEventPatch, changesSomething, type EventPatch } from "../../src/ical-edit.js";
import { applyOccurrencePatch, excludeOccurrence } from "../../src/ical-occurrence-edit.js";
import { parseCalendar, seriesFor } from "../../src/ical-parse.js";
import { shiftSeries } from "../../src/ical-series-shift.js";
import { ToolRefusal } from "../../src/tool-refusal.js";
import { block, occurrence, series as seriesOf, SHAPES, unfold, UID, vevents, weekly } from "../helpers/ical-series-fixtures.js";

const NOW = new Date("2026-09-28T12:00:00Z");
const CHANGED = "Nothing was changed.";
const CREATED = "Nothing was created.";

/**
 * The account's own addresses as `ownAddresses` hands them out for a
 * principal that lists one `mailto:` (Nextcloud): that one alone, the
 * mailbox's `me@mail.example` not among them (review of PR #230).
 */
const OWN = calendarUserAddresses(["/remote.php/dav/principals/users/me/", "mailto:me@cloud.example"], "me@mail.example");

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

/**
 * `applyAttendeePatch` on the main VEVENT of `text` as it will be once
 * acceptance A2 has shown that Nextcloud sends no cancellation for
 * SCHEDULE-AGENT=CLIENT (`REMOVE_WITHOUT_NOTIFY_HONOURED` flipped to true),
 * answering the new text, unfolded. Keeps the rule the flag switches on
 * tested, so flipping it is a one-line change.
 */
function honouredPatched(text: string, patch: AttendeePatch, uid = MEETING): string {
  const { vcal } = parseCalendar(text);
  const { master } = seriesFor(vcal, uid);
  assert.ok(master);
  applyAttendeePatch(master, patch, OWN, CHANGED, true);
  return unfold(vcal.toString());
}

/** The refusal `run` throws, which must end in `nothingDone`: what was not done is the last thing said. */
function refused(run: () => unknown, nothingDone = CHANGED): string {
  try {
    run();
  } catch (err) {
    assert.ok(err instanceof ToolRefusal, `expected a ToolRefusal, got ${String(err)}`);
    assert.ok(err.message.endsWith(nothingDone), `does not end in "${nothingDone}": ${err.message}`);
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

  it("where the principal lists a mailto:, the principal's are the account's addresses, each once, and the mailbox's is not one of them (review of PR #230)", () => {
    assert.deepEqual(
      calendarUserAddresses(
        ["/remote.php/dav/principals/users/me/", "mailto:Me@Cloud.example", "MAILTO:me@cloud.example", "mailto:me2@cloud.example"],
        "ME@mail.example"
      ),
      ["mailto:Me@Cloud.example", "mailto:me2@cloud.example"]
    );
  });

  it("a principal that lists the mailbox's address itself keeps it, in the principal's order", () => {
    assert.deepEqual(
      calendarUserAddresses(["mailto:me@cloud.example", "mailto:me@mail.example"], "me@mail.example"),
      ["mailto:me@cloud.example", "mailto:me@mail.example"]
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

  // Spec §2.1: removal with `false` is honoured only if the Hetzner run (A2)
  // shows Nextcloud sends no cancellation for an attendee who carried
  // SCHEDULE-AGENT=CLIENT, "otherwise refused". Until A2 has been run it is
  // refused for every attendee (`REMOVE_WITHOUT_NOTIFY_HONOURED` is false).
  it("refuses remove_attendees with notify_attendees: false for every attendee until acceptance A2 is in, even one carrying SCHEDULE-AGENT=CLIENT, and changes nothing", () => {
    for (const address of ["cara@example.com", "ben@example.com"]) {
      const parsed = parseCalendar(mine());
      const before = parsed.vcal.toString();
      const message = refused(() =>
        applyEventPatch(parsed, MEETING, { removeAttendees: [address], notifyAttendees: false }, { nothingDone: CHANGED, now: NOW, own: OWN })
      );
      assert.equal(parsed.vcal.toString(), before);
      // What to do instead comes first, and leaving them listed first of all.
      assert.match(message, /[Ll]eave them listed.*notify_attendees: true/);
    }
  });

  it("refuses remove_attendees with notify_attendees: false on an event with no organizer too, where nothing was ever scheduled", () => {
    refused(() => patched(NO_ORGANIZER, { removeAttendees: ["ben@example.com"], notifyAttendees: false }));
  });

  describe("once acceptance A2 has shown Nextcloud sends no cancellation for SCHEDULE-AGENT=CLIENT (REMOVE_WITHOUT_NOTIFY_HONOURED: true)", () => {
    it("removes an attendee the server was told nothing about (SCHEDULE-AGENT=CLIENT) with notify_attendees: false", () => {
      const text = honouredPatched(mine(), { removeAttendees: ["cara@example.com"], notifyAttendees: false });
      assert.deepEqual(attendees(text), [BEN]);
    });

    it("still refuses to remove, with notify_attendees: false, an attendee the server was free to notify: it may send a cancellation whatever this says", () => {
      const message = refused(() => honouredPatched(mine(), { removeAttendees: ["ben@example.com"], notifyAttendees: false }));
      assert.match(message, /ben@example\.com/);
      assert.match(message, /cancellation/);
      assert.match(message, /[Ll]eave them listed.*notify_attendees: true/);
    });

    it("with notify_attendees: false, the ORGANIZER a removal adds does not make the server notify the attendees left either", () => {
      const text = honouredPatched(NO_ORGANIZER, { removeAttendees: ["ben@example.com"], addAttendees: ["dan@example.com"], notifyAttendees: false });
      assert.deepEqual(attendees(text), ["ATTENDEE;SCHEDULE-AGENT=CLIENT:mailto:dan@example.com"]);
    });
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
    assert.match(message, /can still be changed here/);
    assert.equal(parsed.vcal.toString(), before);
    refused(() => patched(THEIRS, { removeAttendees: ["ben@example.com"], notifyAttendees: true }));
  });

  it("still changes the text of someone else's meeting, and leaves its guest list alone", () => {
    const text = patched(THEIRS, { summary: "Planning (my note)" });
    assert.match(text, /\r\nSUMMARY:Planning \(my note\)\r\n/);
    assert.deepEqual(attendees(text), [BEN, CARA]);
    assert.equal(organizerOf(text), "ORGANIZER;CN=Anna:mailto:anna@example.com");
  });

  it("takes the mailbox's address as the account's own where the principal lists none (Radicale, R13)", () => {
    const own = calendarUserAddresses(["/u1/"], "me@mail.example");
    const edit = applyEventPatch(
      parseCalendar(mine("ORGANIZER:mailto:ME@mail.example")),
      MEETING,
      { addAttendees: ["dan@example.com"], notifyAttendees: true },
      { nothingDone: CHANGED, now: NOW, own }
    );
    assert.equal(attendees(edit.ics).length, 3);
  });

  it("where the principal lists an address, an event organized by the mailbox's address is someone else's meeting: an invitation from the user's Gmail to their Nextcloud address is a copy they were sent", () => {
    const message = refused(() => patched(mine("ORGANIZER:mailto:me@mail.example"), { addAttendees: ["dan@example.com"], notifyAttendees: true }));
    assert.match(message, /organized by me@mail\.example/);
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

describe("a series with no ORGANIZER yet: the organizer and notify_attendees: false reach every VEVENT of the UID (review of PR #230)", () => {
  // Sabre (Nextcloud) takes a scheduling object's organizer from any of its
  // VEVENTs and schedules every attendee on every instance that carries no
  // SCHEDULE-AGENT (RFC 6638 §3.2.2). So once one VEVENT of the UID gets the
  // account as ORGANIZER, a plain ATTENDEE on any other one is someone the
  // server may mail — and `false` has to reach them all.
  const shape = SHAPES.find((s) => s.name === "UTC");
  assert.ok(shape);
  const ANN = "ATTENDEE;CN=Ann;PARTSTAT=ACCEPTED:mailto:ann@example.com";
  const BEN_S = "ATTENDEE;CN=Ben;PARTSTAT=ACCEPTED;ROLE=REQ-PARTICIPANT:mailto:ben@example.com";
  const CY = "ATTENDEE;CN=Cy;PARTSTAT=NEEDS-ACTION:mailto:cy@example.com";
  const MOVED = ["RECURRENCE-ID:20261015T090000Z", "DTSTART:20261015T110000Z", "DTEND:20261015T120000Z", "SUMMARY:Weekly (moved)", "SEQUENCE:1"];
  /** Weekly, no ORGANIZER anywhere: Ann and Ben (and `extra`) on the master, `onMoved` on the 10-15 override. */
  const unorganized = (extra: string[] = [], onMoved: string[] = [ANN, BEN_S]): string =>
    seriesOf(shape, "20261001", "FREQ=WEEKLY;COUNT=5", [ANN, ...extra], [[...MOVED, ...onMoved]]);

  /** Every VEVENT of `text` has the account as ORGANIZER, and every ATTENDEE on it carries SCHEDULE-AGENT=CLIENT. */
  function quietEverywhere(text: string): void {
    const blocks = vevents(text);
    assert.ok(blocks.length >= 2);
    for (const ve of blocks) {
      assert.match(ve, /\r\nORGANIZER:mailto:me@cloud\.example\r\n/, ve);
      for (const line of ve.split("\r\n").filter((l) => /^ATTENDEE[;:]/.test(l))) {
        assert.match(line, /;SCHEDULE-AGENT=CLIENT[;:]/, `${line} is left for the server to schedule`);
      }
    }
  }

  it("(a) one occurrence given an attendee with false: the master and every other override get the ORGANIZER, and their plain attendees CLIENT, replies kept", () => {
    const text = unorganized();
    const rid = "2026-10-08T09:00:00.000Z";
    const written = unfold(
      applyOccurrencePatch(parseCalendar(text), UID, occurrence(text, rid), { addAttendees: ["dan@example.com"], notifyAttendees: false }, { nothingDone: CHANGED, now: NOW, own: OWN }).ics
    );
    quietEverywhere(written);
    assert.match(block(written, null), /\r\nATTENDEE;CN=Ann;PARTSTAT=ACCEPTED;SCHEDULE-AGENT=CLIENT:mailto:ann@example\.com\r\n/);
    assert.match(block(written, "RECURRENCE-ID:20261015T090000Z"), /\r\nSEQUENCE:2\r\n/, "a VEVENT the write changed is stamped");
    assert.doesNotMatch(block(written, null), /dan@example\.com/);
  });

  it("(b) apply_to_series removing someone the master lists, with false, once removal with false is honoured: the untouched override's attendees are marked too", () => {
    const { vcal } = parseCalendar(unorganized([CY]));
    const { master, overrides } = seriesFor(vcal, UID);
    assert.ok(master);
    patchSeriesAttendees(master, overrides, { removeAttendees: ["cy@example.com"], notifyAttendees: false }, OWN, CHANGED, true);
    const written = unfold(vcal.toString());
    quietEverywhere(written);
    assert.doesNotMatch(written, /cy@example\.com/);
  });

  it("with true, every VEVENT gets the same ORGANIZER and every attendee is left plain", () => {
    const written = patched(unorganized(), { addAttendees: ["dan@example.com"], notifyAttendees: true }, UID);
    for (const ve of vevents(written)) {
      assert.match(ve, /\r\nORGANIZER:mailto:me@cloud\.example\r\n/);
      assert.doesNotMatch(ve, /SCHEDULE-AGENT/);
    }
  });

  it("an override with no ORGANIZER of a series that has one gets the series' own ORGANIZER line, and its attendees are left as they were", () => {
    const text = seriesOf(shape, "20261001", "FREQ=WEEKLY;COUNT=5", ["ORGANIZER;CN=Me:mailto:me@cloud.example", ANN], [[...MOVED, ANN, BEN_S]]);
    const rid = "2026-10-08T09:00:00.000Z";
    const written = unfold(
      applyOccurrencePatch(parseCalendar(text), UID, occurrence(text, rid), { addAttendees: ["dan@example.com"], notifyAttendees: false }, { nothingDone: CHANGED, now: NOW, own: OWN }).ics
    );
    const moved = block(written, "RECURRENCE-ID:20261015T090000Z");
    assert.match(moved, /\r\nORGANIZER;CN=Me:mailto:me@cloud\.example\r\n/);
    assert.match(moved, /\r\nATTENDEE;CN=Ann;PARTSTAT=ACCEPTED:mailto:ann@example\.com\r\n/);
  });

  it("a single event's guest list is written as before: nothing else in the object is touched", () => {
    assert.deepEqual(attendees(patched(mine(), { addAttendees: ["dan@example.com"], notifyAttendees: false })), [
      BEN,
      CARA,
      "ATTENDEE;SCHEDULE-AGENT=CLIENT:mailto:dan@example.com",
    ]);
  });

  it("refuses a guest-list change on one occurrence when another VEVENT of the UID names someone else as ORGANIZER", () => {
    const text = seriesOf(shape, "20261001", "FREQ=WEEKLY;COUNT=5", [ANN], [[...MOVED, "ORGANIZER:mailto:anna@example.com", ANN]]);
    const rid = "2026-10-08T09:00:00.000Z";
    const message = refused(() =>
      applyOccurrencePatch(parseCalendar(text), UID, occurrence(text, rid), { addAttendees: ["dan@example.com"], notifyAttendees: true }, { nothingDone: CHANGED, now: NOW, own: OWN })
    );
    assert.match(message, /anna@example\.com/);
  });
});

describe("apply_to_series removing someone only an override lists (review of PR #230)", () => {
  const shape = SHAPES.find((s) => s.name === "UTC");
  assert.ok(shape);
  const CY = "ATTENDEE;CN=Cy;PARTSTAT=ACCEPTED:mailto:cy@example.com";
  const text = seriesOf(shape, "20261001", "FREQ=WEEKLY;COUNT=5", ["ORGANIZER:mailto:me@cloud.example"], [
    ["RECURRENCE-ID:20261015T090000Z", "DTSTART:20261015T110000Z", "DTEND:20261015T120000Z", "SEQUENCE:1", CY],
  ]);

  it("takes them off the occurrence that lists them: the series' guest list is every occurrence's", () => {
    const written = patched(text, { removeAttendees: ["cy@example.com"], notifyAttendees: true }, UID);
    assert.doesNotMatch(written, /cy@example\.com/);
    assert.match(block(written, "RECURRENCE-ID:20261015T090000Z"), /\r\nSEQUENCE:2\r\n/);
  });

  it("refuses an address no occurrence lists, saying so, and changes nothing", () => {
    const message = refused(() => patched(text, { removeAttendees: ["zoe@example.com"], notifyAttendees: true }, UID));
    assert.match(message, /zoe@example\.com is not an attendee of any occurrence of this series/);
  });
});

describe("mayNotify: whom the calendar server may now email about the event (review of PR #230)", () => {
  /** The `mayNotify` an attendee change on `text` answers with. */
  function mayNotify(text: string, patch: EventPatch, uid = MEETING): readonly string[] | undefined {
    return applyEventPatch(parseCalendar(text), uid, patch, { nothingDone: CHANGED, now: NOW, own: OWN }).mayNotify;
  }

  it("names the attendees an ORGANIZER added with true makes schedulable, not only the one added", () => {
    assert.deepEqual(mayNotify(NO_ORGANIZER, { addAttendees: ["dan@example.com"], notifyAttendees: true }), ["ben@example.com", "dan@example.com"]);
  });

  it("is empty when false reaches everyone", () => {
    assert.deepEqual(mayNotify(NO_ORGANIZER, { addAttendees: ["dan@example.com"], notifyAttendees: false }), []);
  });

  it("names the attendees already scheduled, who may be told of the change, and never one marked CLIENT", () => {
    assert.deepEqual(mayNotify(mine(), { addAttendees: ["dan@example.com"], notifyAttendees: false }), ["ben@example.com"]);
  });

  it("names an attendee removed with true, who may be sent a cancellation", () => {
    assert.deepEqual(mayNotify(mine(), { removeAttendees: ["ben@example.com"], notifyAttendees: true }), ["ben@example.com"]);
  });

  it("covers every VEVENT of a series, once per person", () => {
    const shape = SHAPES.find((s) => s.name === "UTC");
    assert.ok(shape);
    const text = weekly(shape, "FREQ=WEEKLY;COUNT=5", ["ORGANIZER:mailto:me@cloud.example"]);
    const rid = "2026-10-08T09:00:00.000Z";
    const edit = applyOccurrencePatch(parseCalendar(text), UID, occurrence(text, rid), { addAttendees: ["dan@example.com"], notifyAttendees: true }, { nothingDone: CHANGED, now: NOW, own: OWN });
    assert.deepEqual(edit.mayNotify, ["ben@example.com", "dan@example.com"]);
  });

  it("is absent for a change to an event no server schedules: no attendees, or attendees with no organizer", () => {
    assert.equal(mayNotify(PLAIN, { summary: "Renamed" }), undefined);
    assert.equal(mayNotify(NO_ORGANIZER, { summary: "Renamed", start: "2026-10-01T11:00:00Z" }), undefined);
  });
});

/**
 * The milestone review of v0.7.4 found `may_notify` only on a write that
 * changed the guest list, while every write to a scheduling object may make
 * the server mail someone: a new title or time is an update to the
 * attendees, a cancelled occurrence a cancellation, and on someone else's
 * meeting any of them may send its organizer a reply. So every write to one
 * answers whom (spec 2026-09-29 §2.1): on the account's own meeting, its
 * attendees the server is free to schedule; on someone else's, its
 * organizer.
 */
describe("mayNotify on every write to a meeting, not only a guest-list change (milestone review of v0.7.4)", () => {
  const ctx = { nothingDone: CHANGED, now: NOW, own: OWN };
  const UTC_SHAPE = SHAPES.find((s) => s.name === "UTC");
  assert.ok(UTC_SHAPE);
  /** A weekly series the account organizes (Ben plain), or `organizer`'s. */
  const meetingSeries = (organizer = "ORGANIZER:mailto:me@cloud.example"): string =>
    weekly(UTC_SHAPE, "FREQ=WEEKLY;COUNT=5", [organizer]);

  it("a new title or time on the account's own meeting names its attendees the server is free to schedule", () => {
    assert.deepEqual(applyEventPatch(parseCalendar(mine()), MEETING, { summary: "Renamed" }, ctx).mayNotify, ["ben@example.com"]);
    assert.deepEqual(
      applyEventPatch(parseCalendar(mine()), MEETING, { start: "2026-10-01T11:00:00Z" }, ctx).mayNotify,
      ["ben@example.com"]
    );
  });

  it("a new title on someone else's meeting names its organizer", () => {
    assert.deepEqual(applyEventPatch(parseCalendar(THEIRS), MEETING, { summary: "Renamed" }, ctx).mayNotify, ["anna@example.com"]);
  });

  it("a series moved to a new time names the series' attendees", () => {
    const text = meetingSeries();
    assert.deepEqual(shiftSeries(parseCalendar(text), UID, null, { start: "2026-10-01T10:00:00Z" }, ctx).mayNotify, ["ben@example.com"]);
  });

  it("one occurrence changed names them too", () => {
    const text = meetingSeries();
    const found = occurrence(text, "2026-10-08T09:00:00.000Z");
    assert.deepEqual(applyOccurrencePatch(parseCalendar(text), UID, found, { summary: "Just this one" }, ctx).mayNotify, ["ben@example.com"]);
  });

  it("one occurrence cancelled (an EXDATE) names them, and an attendee only its removed override listed", () => {
    const text = meetingSeries().replace(
      "SUMMARY:Weekly (moved)\r\n",
      "SUMMARY:Weekly (moved)\r\nATTENDEE:mailto:ola@example.com\r\n"
    );
    const found = occurrence(text, "2026-10-15T09:00:00.000Z");
    assert.deepEqual(excludeOccurrence(parseCalendar(text), UID, found, ctx).mayNotify, ["ben@example.com", "ola@example.com"]);
  });

  it("one occurrence of someone else's series cancelled names its organizer, who may be sent a decline", () => {
    const text = meetingSeries("ORGANIZER;CN=Anna:mailto:anna@example.com");
    const found = occurrence(text, "2026-10-08T09:00:00.000Z");
    assert.deepEqual(excludeOccurrence(parseCalendar(text), UID, found, ctx).mayNotify, ["anna@example.com"]);
  });

  it("nothing for a series no server schedules", () => {
    const text = weekly(UTC_SHAPE);
    const found = occurrence(text, "2026-10-08T09:00:00.000Z");
    assert.equal(excludeOccurrence(parseCalendar(text), UID, found, ctx).mayNotify, undefined);
    assert.equal(shiftSeries(parseCalendar(text), UID, null, { start: "2026-10-01T10:00:00Z" }, ctx).mayNotify, undefined);
  });
});

describe("mayNotifyAbout — whom the server may email when an event changes calendars (#212, spec 2026-09-29 §2.6)", () => {
  const every = (text: string): ICAL.Component[] => parseCalendar(text).vcal.getAllSubcomponents("vevent");

  it("the account's own meeting: every attendee the server is free to schedule, never one marked CLIENT", () => {
    assert.equal(schedulingObject(every(mine())), true);
    assert.deepEqual(mayNotifyAbout(every(mine()), OWN), ["ben@example.com"]);
  });

  it("someone else's meeting: its organizer, who may be sent a reply as for a deletion", () => {
    assert.equal(schedulingObject(every(THEIRS)), true);
    assert.deepEqual(mayNotifyAbout(every(THEIRS), OWN), ["anna@example.com"]);
  });

  it("nothing for attendees with no ORGANIZER, which no server schedules, and nothing for an event without attendees", () => {
    for (const text of [NO_ORGANIZER, PLAIN]) {
      assert.equal(schedulingObject(every(text)), false);
      assert.equal(mayNotifyAbout(every(text), OWN), undefined);
    }
  });
});
