/**
 * src/ical-edit.ts — what an update keeps, what it changes, and what it
 * refuses. No network: every case is a hand-written object and the string
 * that comes back.
 *
 * The fixtures carry every property spec §4.4 promises to preserve, because a
 * test that only ever edits a bare VEVENT cannot tell an in-place edit from a
 * rebuild — and a rebuild is the failure #152 names.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import ICAL from "ical.js";

import {
  applyEventPatch,
  changesSomething,
  describeStoredEvent,
  touchesTime,
} from "../../src/ical-edit.js";
import { ToolRefusal } from "../../src/tool-errors.js";

const NOW = new Date("2026-09-28T12:00:00Z");

/** Join lines with CRLF, as RFC 5545 and every CalDAV server do. */
function ics(...lines: string[]): string {
  return `${lines.join("\r\n")}\r\n`;
}

/** A timed event in Europe/Berlin with everything an in-place edit must keep. */
const RICH = ics(
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//Other Client//EN",
  "BEGIN:VTIMEZONE",
  "TZID:Europe/Berlin",
  "BEGIN:STANDARD",
  "DTSTART:19701025T030000",
  "TZOFFSETFROM:+0200",
  "TZOFFSETTO:+0100",
  "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU",
  "END:STANDARD",
  "BEGIN:DAYLIGHT",
  "DTSTART:19700329T020000",
  "TZOFFSETFROM:+0100",
  "TZOFFSETTO:+0200",
  "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU",
  "END:DAYLIGHT",
  "END:VTIMEZONE",
  "BEGIN:VEVENT",
  "UID:rich-1@example.com",
  "DTSTAMP:20260901T080000Z",
  "DTSTART;TZID=Europe/Berlin:20261001T090000",
  "DTEND;TZID=Europe/Berlin:20261001T100000",
  "SUMMARY:Planning",
  "DESCRIPTION:Agenda to follow",
  "LOCATION:Room 4",
  "SEQUENCE:2",
  "ORGANIZER;CN=Anna:mailto:anna@example.com",
  "ATTENDEE;CN=Ben;PARTSTAT=ACCEPTED;ROLE=REQ-PARTICIPANT:mailto:ben@example.com",
  "CATEGORIES:work",
  "X-KEEP-ME:yes",
  "BEGIN:VALARM",
  "ACTION:DISPLAY",
  "TRIGGER:-PT15M",
  "DESCRIPTION:Reminder",
  "END:VALARM",
  "END:VEVENT",
  "END:VCALENDAR"
);

/** A weekly series with one moved occurrence. */
const SERIES = ics(
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//Other Client//EN",
  "BEGIN:VEVENT",
  "UID:series-1@example.com",
  "DTSTAMP:20260901T080000Z",
  "DTSTART:20261001T090000Z",
  "DTEND:20261001T093000Z",
  "RRULE:FREQ=WEEKLY;COUNT=5",
  "SUMMARY:Standup",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:series-1@example.com",
  "DTSTAMP:20260901T080000Z",
  "RECURRENCE-ID:20261008T090000Z",
  "DTSTART:20261008T110000Z",
  "DTEND:20261008T113000Z",
  "SUMMARY:Standup (moved)",
  "END:VEVENT",
  "END:VCALENDAR"
);

/** An all-day event over two days (end is exclusive). */
const ALL_DAY = ics(
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//Other Client//EN",
  "BEGIN:VEVENT",
  "UID:allday-1@example.com",
  "DTSTAMP:20260901T080000Z",
  "DTSTART;VALUE=DATE:20261001",
  "DTEND;VALUE=DATE:20261003",
  "SUMMARY:Offsite",
  "END:VEVENT",
  "END:VCALENDAR"
);

/** A timed event that states its length as DURATION rather than DTEND. */
const WITH_DURATION = ics(
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//Other Client//EN",
  "BEGIN:VEVENT",
  "UID:dur-1@example.com",
  "DTSTAMP:20260901T080000Z",
  "DTSTART:20261001T090000Z",
  "DURATION:PT45M",
  "SUMMARY:Call",
  "END:VEVENT",
  "END:VCALENDAR"
);

/** The first VEVENT for `uid` without a RECURRENCE-ID, parsed back out. */
function master(text: string, uid: string): ICAL.Component {
  const vcal = new ICAL.Component(ICAL.parse(text));
  const found = vcal
    .getAllSubcomponents("vevent")
    .find((ve) => ve.getFirstPropertyValue("uid") === uid && !ve.hasProperty("recurrence-id"));
  assert.ok(found, `no main VEVENT for ${uid}`);
  return found;
}

function iso(time: unknown): string {
  return (time as ICAL.Time).toJSDate().toISOString();
}

describe("describeStoredEvent", () => {
  it("finds a plain event and calls it not recurring", () => {
    assert.deepEqual(describeStoredEvent(RICH, "rich-1@example.com"), {
      found: true,
      recurring: false,
    });
  });

  it("calls a series with an override recurring", () => {
    assert.deepEqual(describeStoredEvent(SERIES, "series-1@example.com"), {
      found: true,
      recurring: true,
    });
  });

  it("compares the UID exactly, not as the substring CalDAV's text-match uses", () => {
    assert.equal(describeStoredEvent(RICH, "rich-1@example.co").found, false);
    assert.equal(describeStoredEvent(RICH, "rich-1").found, false);
  });
});

describe("applyEventPatch — what survives", () => {
  it("keeps every property it was not asked to change", () => {
    const out = applyEventPatch(RICH, "rich-1@example.com", { summary: "Planning (moved room)" }, NOW);
    const ve = master(out, "rich-1@example.com");

    assert.equal(ve.getFirstPropertyValue("summary"), "Planning (moved room)");
    assert.equal(ve.getFirstPropertyValue("description"), "Agenda to follow");
    assert.equal(ve.getFirstPropertyValue("location"), "Room 4");
    assert.equal(ve.getFirstPropertyValue("x-keep-me"), "yes");
    assert.equal(ve.getFirstPropertyValue("categories"), "work");
    assert.equal(ve.getAllSubcomponents("valarm").length, 1, "the alarm was dropped");

    const attendee = ve.getFirstProperty("attendee");
    assert.ok(attendee, "the attendee was dropped");
    assert.equal(attendee.getParameter("partstat"), "ACCEPTED");
    assert.equal(attendee.getParameter("cn"), "Ben");
    assert.equal(String(ve.getFirstPropertyValue("organizer")), "mailto:anna@example.com");
  });

  it("leaves the time and its TZID alone when the time is not touched", () => {
    const out = applyEventPatch(RICH, "rich-1@example.com", { location: "Room 5" }, NOW);
    const ve = master(out, "rich-1@example.com");
    assert.equal(ve.getFirstProperty("dtstart")?.getParameter("tzid"), "Europe/Berlin");
    assert.match(out, /BEGIN:VTIMEZONE/);
  });

  it("keeps the overrides of a series when the series is renamed", () => {
    const out = applyEventPatch(SERIES, "series-1@example.com", { summary: "Daily sync" }, NOW);
    const vcal = new ICAL.Component(ICAL.parse(out));
    const summaries = vcal.getAllSubcomponents("vevent").map((ve) => ve.getFirstPropertyValue("summary"));
    assert.deepEqual(summaries, ["Daily sync", "Standup (moved)"]);
    assert.equal(master(out, "series-1@example.com").getFirstPropertyValue("rrule")?.toString(), "FREQ=WEEKLY;COUNT=5");
  });
});

describe("applyEventPatch — what it changes", () => {
  it("removes description and location when given an empty string", () => {
    const out = applyEventPatch(RICH, "rich-1@example.com", { description: "", location: "" }, NOW);
    const ve = master(out, "rich-1@example.com");
    assert.equal(ve.hasProperty("description"), false);
    assert.equal(ve.hasProperty("location"), false);
  });

  it("raises SEQUENCE by one and stamps DTSTAMP and LAST-MODIFIED", () => {
    const ve = master(applyEventPatch(RICH, "rich-1@example.com", { summary: "x" }, NOW), "rich-1@example.com");
    assert.equal(ve.getFirstPropertyValue("sequence"), 3);
    assert.equal(iso(ve.getFirstPropertyValue("dtstamp")), NOW.toISOString());
    assert.equal(iso(ve.getFirstPropertyValue("last-modified")), NOW.toISOString());
  });

  it("starts SEQUENCE at 1 when the event had none", () => {
    const ve = master(applyEventPatch(ALL_DAY, "allday-1@example.com", { summary: "x" }, NOW), "allday-1@example.com");
    assert.equal(ve.getFirstPropertyValue("sequence"), 1);
  });

  it("moves a timed event by its start and keeps the duration", () => {
    // 09:00–10:00 Berlin (07:00–08:00Z) moved to 15:00 Berlin: still an hour.
    const out = applyEventPatch(RICH, "rich-1@example.com", { start: "2026-10-01T15:00:00+02:00" }, NOW);
    const ve = master(out, "rich-1@example.com");
    assert.equal(iso(ve.getFirstPropertyValue("dtstart")), "2026-10-01T13:00:00.000Z");
    assert.equal(iso(ve.getFirstPropertyValue("dtend")), "2026-10-01T14:00:00.000Z");
    assert.equal(ve.getFirstProperty("dtstart")?.getParameter("tzid"), undefined, "a rewritten time is UTC (spec §2.4)");
  });

  it("replaces DURATION with DTEND when the time changes", () => {
    const out = applyEventPatch(WITH_DURATION, "dur-1@example.com", { start: "2026-10-02T09:00:00Z" }, NOW);
    const ve = master(out, "dur-1@example.com");
    assert.equal(ve.hasProperty("duration"), false);
    assert.equal(iso(ve.getFirstPropertyValue("dtend")), "2026-10-02T09:45:00.000Z");
  });

  it("moves an all-day event by whole days", () => {
    const out = applyEventPatch(ALL_DAY, "allday-1@example.com", { start: "2026-10-05" }, NOW);
    const ve = master(out, "allday-1@example.com");
    assert.equal(ve.getFirstPropertyValue("dtstart")?.toString(), "2026-10-05");
    assert.equal(ve.getFirstPropertyValue("dtend")?.toString(), "2026-10-07");
  });

  it("turns a timed event into an all-day one when given both bounds", () => {
    const out = applyEventPatch(
      RICH,
      "rich-1@example.com",
      { allDay: true, start: "2026-10-01", end: "2026-10-02" },
      NOW
    );
    const ve = master(out, "rich-1@example.com");
    assert.equal((ve.getFirstPropertyValue("dtstart") as ICAL.Time).isDate, true);
  });

  it("moves an all-day event given a full datetime by its date part", () => {
    const out = applyEventPatch(ALL_DAY, "allday-1@example.com", { start: "2026-10-05T00:00:00+02:00" }, NOW);
    assert.equal(master(out, "allday-1@example.com").getFirstPropertyValue("dtstart")?.toString(), "2026-10-05");
  });

  it("treats removing a description the event never had as nothing to do", () => {
    const out = applyEventPatch(ALL_DAY, "allday-1@example.com", { description: "" }, NOW);
    assert.equal(master(out, "allday-1@example.com").hasProperty("description"), false);
  });
});

describe("applyEventPatch — what it refuses", () => {
  it("refuses an end at or before the start", () => {
    assert.throws(
      () => applyEventPatch(RICH, "rich-1@example.com", { end: "2026-10-01T06:00:00Z" }, NOW),
      (err: unknown) => err instanceof ToolRefusal && /Nothing was changed/.test(err.message)
    );
  });

  it("refuses switching to all-day without both bounds", () => {
    assert.throws(
      () => applyEventPatch(RICH, "rich-1@example.com", { allDay: true, start: "2026-10-01" }, NOW),
      (err: unknown) => err instanceof ToolRefusal && /needs both start and end/.test(err.message)
    );
  });
});

/** A timed event whose TZID has no VTIMEZONE in the object: ical.js cannot place it. */
const UNRESOLVED_TZID = ics(
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//Other Client//EN",
  "BEGIN:VEVENT",
  "UID:nozone-1@example.com",
  "DTSTAMP:20260901T080000Z",
  "DTSTART;TZID=Europe/Berlin:20261001T090000",
  "DTEND;TZID=Europe/Berlin:20261001T100000",
  "SUMMARY:Planning",
  "END:VEVENT",
  "END:VCALENDAR"
);

/** A floating timed event: a clock time with no zone at all. */
const FLOATING = ics(
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//Other Client//EN",
  "BEGIN:VEVENT",
  "UID:float-1@example.com",
  "DTSTAMP:20260901T080000Z",
  "DTSTART:20261001T090000",
  "DTEND:20261001T100000",
  "SUMMARY:Planning",
  "END:VEVENT",
  "END:VCALENDAR"
);

/** A timed event with neither DTEND nor DURATION: RFC 5545 gives it no length. */
const NO_END = ics(
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//Other Client//EN",
  "BEGIN:VEVENT",
  "UID:noend-1@example.com",
  "DTSTAMP:20260901T080000Z",
  "DTSTART:20261001T090000Z",
  "SUMMARY:Reminder",
  "END:VEVENT",
  "END:VCALENDAR"
);

describe("applyEventPatch — times it cannot place (final review)", () => {
  it("refuses an end-only change on a TZID it has no VTIMEZONE for, rather than moving the start", () => {
    for (const end of ["2026-10-01T12:00:00+02:00", "2026-10-01T11:00:00+02:00"]) {
      assert.throws(
        () => applyEventPatch(UNRESOLVED_TZID, "nozone-1@example.com", { end }, NOW),
        (err: unknown) =>
          err instanceof ToolRefusal && /time zone/.test(err.message) && /Nothing was changed/.test(err.message)
      );
    }
  });

  it("refuses a start-only move of a floating event, which would need its old length", () => {
    assert.throws(
      () => applyEventPatch(FLOATING, "float-1@example.com", { start: "2026-10-02T09:00:00Z" }, NOW),
      (err: unknown) => err instanceof ToolRefusal && /time zone/.test(err.message)
    );
  });

  it("still moves such an event when given both bounds, since neither old time is needed", () => {
    const out = applyEventPatch(
      UNRESOLVED_TZID,
      "nozone-1@example.com",
      { start: "2026-10-01T11:00:00+02:00", end: "2026-10-01T12:00:00+02:00" },
      NOW
    );
    const ve = master(out, "nozone-1@example.com");
    assert.equal(iso(ve.getFirstPropertyValue("dtstart")), "2026-10-01T09:00:00.000Z");
    assert.equal(iso(ve.getFirstPropertyValue("dtend")), "2026-10-01T10:00:00.000Z");
  });
});

describe("applyEventPatch — an event with no end (final review)", () => {
  it("moves it by its start and still gives it no end", () => {
    const out = applyEventPatch(NO_END, "noend-1@example.com", { start: "2026-10-02T09:00:00Z" }, NOW);
    const ve = master(out, "noend-1@example.com");
    assert.equal(iso(ve.getFirstPropertyValue("dtstart")), "2026-10-02T09:00:00.000Z");
    assert.equal(ve.hasProperty("dtend"), false);
    assert.equal(ve.hasProperty("duration"), false);
  });

  it("gives it an end when one is asked for", () => {
    const out = applyEventPatch(NO_END, "noend-1@example.com", { end: "2026-10-01T09:30:00Z" }, NOW);
    assert.equal(iso(master(out, "noend-1@example.com").getFirstPropertyValue("dtend")), "2026-10-01T09:30:00.000Z");
  });
});

describe("applyEventPatch — dates it cannot read (final review)", () => {
  it("refuses an unparseable timed start as an answer, not a server failure", () => {
    assert.throws(
      () => applyEventPatch(RICH, "rich-1@example.com", { start: "tomorrow 9am" }, NOW),
      (err: unknown) => err instanceof ToolRefusal && /"tomorrow 9am"/.test(err.message)
    );
  });

  it("refuses an all-day date that is not a calendar date, instead of writing a rolled-over one", () => {
    for (const patch of [
      { start: "2026-10-05", end: "2026-13-45" },
      { start: "next monday", end: "next tuesday" },
    ]) {
      assert.throws(
        () => applyEventPatch(ALL_DAY, "allday-1@example.com", patch, NOW),
        (err: unknown) => err instanceof ToolRefusal && /Nothing was changed/.test(err.message)
      );
    }
  });
});

describe("touchesTime / changesSomething", () => {
  it("tells a text-only patch from a time patch, and an empty one from both", () => {
    assert.equal(touchesTime({ summary: "x" }), false);
    assert.equal(touchesTime({ end: "2026-10-01T10:00:00Z" }), true);
    assert.equal(touchesTime({ allDay: false }), true);
    assert.equal(changesSomething({}), false);
    assert.equal(changesSomething({ location: "" }), true);
  });
});
