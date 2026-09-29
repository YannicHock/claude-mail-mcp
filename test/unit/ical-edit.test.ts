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
  describeSeries,
  touchesTime,
  writtenBy,
  type EventPatch,
} from "../../src/ical-edit.js";
import { ToolRefusal } from "../../src/tool-errors.js";
import { buildIcs } from "../../src/ical-build.js";
import { parseCalendar, seriesFor } from "../../src/ical-parse.js";
import { keyOf, sequenceOf } from "../../src/ical-series.js";

const NOW = new Date("2026-09-28T12:00:00Z");

/** {@link applyEventPatch} on the text `text`, parsed here, answering the new text. */
function patched(text: string, uid: string, patch: EventPatch, now: Date = NOW): string {
  return applyEventPatch(parseCalendar(text), uid, patch, "Nothing was changed.", now).ics;
}

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

/**
 * `describeSeries` for `uid` in `text`, found the way `CalDavClient` finds it:
 * one `parseCalendar`, then `seriesFor`. (A `describeStoredEvent` that did
 * this inside src/ical-edit.ts existed for these tests alone, and was dropped
 * in the code-health review of PR #229.)
 */
function describeStoredEvent(text: string, uid: string): ReturnType<typeof describeSeries> {
  return describeSeries(seriesFor(parseCalendar(text).vcal, uid));
}

describe("describeSeries", () => {
  it("finds a plain event and calls it not recurring", () => {
    assert.deepEqual(describeStoredEvent(RICH, "rich-1@example.com"), {
      found: true,
      recurring: false,
      overrideOnly: false,
    });
  });

  it("calls a series with an override recurring", () => {
    assert.deepEqual(describeStoredEvent(SERIES, "series-1@example.com"), {
      found: true,
      recurring: true,
      overrideOnly: false,
    });
  });

  it("compares the UID exactly, not as the substring CalDAV's text-match uses", () => {
    assert.equal(describeStoredEvent(RICH, "rich-1@example.co").found, false);
    assert.equal(describeStoredEvent(RICH, "rich-1").found, false);
  });

  it("tells an object holding only an override from a series (#211.3)", () => {
    const overrideOnly = SERIES.replace(/BEGIN:VEVENT[\s\S]*?END:VEVENT\r\n/, "");
    assert.deepEqual(describeStoredEvent(overrideOnly, "series-1@example.com"), {
      found: true,
      recurring: true,
      overrideOnly: true,
    });
  });
});

describe("applyEventPatch — what survives", () => {
  it("keeps every property it was not asked to change", () => {
    const out = patched(RICH, "rich-1@example.com", { summary: "Planning (moved room)" }, NOW);
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
    const out = patched(RICH, "rich-1@example.com", { location: "Room 5" }, NOW);
    const ve = master(out, "rich-1@example.com");
    assert.equal(ve.getFirstProperty("dtstart")?.getParameter("tzid"), "Europe/Berlin");
    assert.match(out, /BEGIN:VTIMEZONE/);
  });

  it("keeps the overrides of a series when the series is renamed", () => {
    const out = patched(SERIES, "series-1@example.com", { summary: "Daily sync" }, NOW);
    const vcal = new ICAL.Component(ICAL.parse(out));
    const summaries = vcal.getAllSubcomponents("vevent").map((ve) => ve.getFirstPropertyValue("summary"));
    assert.deepEqual(summaries, ["Daily sync", "Standup (moved)"]);
    assert.equal(master(out, "series-1@example.com").getFirstPropertyValue("rrule")?.toString(), "FREQ=WEEKLY;COUNT=5");
  });
});

describe("applyEventPatch — what it changes", () => {
  it("removes description and location when given an empty string", () => {
    const out = patched(RICH, "rich-1@example.com", { description: "", location: "" }, NOW);
    const ve = master(out, "rich-1@example.com");
    assert.equal(ve.hasProperty("description"), false);
    assert.equal(ve.hasProperty("location"), false);
  });

  it("raises SEQUENCE by one and stamps DTSTAMP and LAST-MODIFIED", () => {
    const ve = master(patched(RICH, "rich-1@example.com", { summary: "x" }, NOW), "rich-1@example.com");
    assert.equal(ve.getFirstPropertyValue("sequence"), 3);
    assert.equal(iso(ve.getFirstPropertyValue("dtstamp")), NOW.toISOString());
    assert.equal(iso(ve.getFirstPropertyValue("last-modified")), NOW.toISOString());
  });

  it("starts SEQUENCE at 1 when the event had none", () => {
    const ve = master(patched(ALL_DAY, "allday-1@example.com", { summary: "x" }, NOW), "allday-1@example.com");
    assert.equal(ve.getFirstPropertyValue("sequence"), 1);
  });

  it("moves a timed event by its start and keeps the duration", () => {
    // 09:00–10:00 Berlin (07:00–08:00Z) moved to 15:00 Berlin: still an hour.
    const out = patched(RICH, "rich-1@example.com", { start: "2026-10-01T15:00:00+02:00" }, NOW);
    const ve = master(out, "rich-1@example.com");
    assert.equal(iso(ve.getFirstPropertyValue("dtstart")), "2026-10-01T13:00:00.000Z");
    assert.equal(iso(ve.getFirstPropertyValue("dtend")), "2026-10-01T14:00:00.000Z");
    // v0.7.4 (#208): a new time is written in the event's own zone, no longer as UTC.
    assert.equal(ve.getFirstProperty("dtstart")?.getParameter("tzid"), "Europe/Berlin");
    assert.match(out, /\r\nDTSTART;TZID=Europe\/Berlin:20261001T150000\r\n/);
  });

  it("replaces DURATION with DTEND when the time changes", () => {
    const out = patched(WITH_DURATION, "dur-1@example.com", { start: "2026-10-02T09:00:00Z" }, NOW);
    const ve = master(out, "dur-1@example.com");
    assert.equal(ve.hasProperty("duration"), false);
    assert.equal(iso(ve.getFirstPropertyValue("dtend")), "2026-10-02T09:45:00.000Z");
  });

  it("moves an all-day event by whole days", () => {
    const out = patched(ALL_DAY, "allday-1@example.com", { start: "2026-10-05" }, NOW);
    const ve = master(out, "allday-1@example.com");
    assert.equal(ve.getFirstPropertyValue("dtstart")?.toString(), "2026-10-05");
    assert.equal(ve.getFirstPropertyValue("dtend")?.toString(), "2026-10-07");
  });

  it("turns a timed event into an all-day one when given both bounds", () => {
    const out = patched(
      RICH,
      "rich-1@example.com",
      { allDay: true, start: "2026-10-01", end: "2026-10-02" },
      NOW
    );
    const ve = master(out, "rich-1@example.com");
    assert.equal((ve.getFirstPropertyValue("dtstart") as ICAL.Time).isDate, true);
  });

  it("moves an all-day event given a full datetime by its date part", () => {
    const out = patched(ALL_DAY, "allday-1@example.com", { start: "2026-10-05T00:00:00+02:00" }, NOW);
    assert.equal(master(out, "allday-1@example.com").getFirstPropertyValue("dtstart")?.toString(), "2026-10-05");
  });

  it("removes a description the event never had without complaint, and still counts it as a change", () => {
    // Not "nothing to do": the object is still written, with SEQUENCE raised
    // (#214 — the old title claimed otherwise).
    const out = patched(ALL_DAY, "allday-1@example.com", { description: "" }, NOW);
    const ve = master(out, "allday-1@example.com");
    assert.equal(ve.hasProperty("description"), false);
    assert.equal(ve.getFirstPropertyValue("sequence"), 1);
  });
});

describe("applyEventPatch — what it refuses", () => {
  it("refuses an end at or before the start", () => {
    assert.throws(
      () => patched(RICH, "rich-1@example.com", { end: "2026-10-01T06:00:00Z" }, NOW),
      (err: unknown) => err instanceof ToolRefusal && /Nothing was changed/.test(err.message)
    );
  });

  it("refuses switching to all-day without both bounds", () => {
    assert.throws(
      () => patched(RICH, "rich-1@example.com", { allDay: true, start: "2026-10-01" }, NOW),
      (err: unknown) => err instanceof ToolRefusal && /needs both start and end/.test(err.message)
    );
  });
});

/** A timed event in Europe/Berlin whose object carries no VTIMEZONE, as Nextcloud and iCloud often store one (R6). */
const BERLIN_NO_VTIMEZONE = ics(
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

/** A TZID with no VTIMEZONE that is no IANA name either: nothing can place it. */
const CUSTOM_ZONE = BERLIN_NO_VTIMEZONE.replaceAll("Europe/Berlin", "My Custom Zone");

/** The VTIMEZONE blocks of an object, exactly as serialised. */
function vtimezones(text: string): string[] {
  return [...text.matchAll(/BEGIN:VTIMEZONE\r\n[\s\S]*?END:VTIMEZONE\r\n/g)].map((m) => m[0]);
}

describe("applyEventPatch — a new time keeps the event's zone (#208, #209)", () => {
  it("writes a Berlin event moved by its start as Berlin time, keeps its VTIMEZONE byte for byte, and keeps its length across the DST change", () => {
    // 09:00–10:00 CEST on 1 October, moved to 15:00 CET on 29 October: the
    // clocks went back on the 25th in between.
    const out = patched(RICH, "rich-1@example.com", { start: "2026-10-29T15:00:00+01:00" }, NOW);
    assert.match(out, /\r\nDTSTART;TZID=Europe\/Berlin:20261029T150000\r\n/);
    assert.match(out, /\r\nDTEND;TZID=Europe\/Berlin:20261029T160000\r\n/);
    assert.equal(vtimezones(RICH).length, 1);
    assert.deepEqual(vtimezones(out), vtimezones(RICH));
    const ve = master(out, "rich-1@example.com");
    assert.equal(iso(ve.getFirstPropertyValue("dtstart")), "2026-10-29T14:00:00.000Z");
    assert.equal(iso(ve.getFirstPropertyValue("dtend")), "2026-10-29T15:00:00.000Z");
  });

  it("moves a Berlin event with no VTIMEZONE by its start alone, with the same TZID and still no VTIMEZONE", () => {
    // Refused until v0.7.4: ical.js read the TZID as floating.
    const out = patched(BERLIN_NO_VTIMEZONE, "nozone-1@example.com", { start: "2026-10-29T15:00:00+01:00" }, NOW);
    assert.match(out, /\r\nDTSTART;TZID=Europe\/Berlin:20261029T150000\r\n/);
    assert.match(out, /\r\nDTEND;TZID=Europe\/Berlin:20261029T160000\r\n/);
    assert.equal(vtimezones(out).length, 0, "a VTIMEZONE was added");
  });

  it("changes only the end of such an event, keeping the start where it was", () => {
    const out = patched(BERLIN_NO_VTIMEZONE, "nozone-1@example.com", { end: "2026-10-01T12:00:00+02:00" }, NOW);
    assert.match(out, /\r\nDTSTART;TZID=Europe\/Berlin:20261001T090000\r\n/);
    assert.match(out, /\r\nDTEND;TZID=Europe\/Berlin:20261001T120000\r\n/);
  });

  it("writes a path-like TZID back exactly as it was stored", () => {
    const mozilla = BERLIN_NO_VTIMEZONE.replaceAll("Europe/Berlin", "/mozilla.org/20050126_1/Europe/Berlin");
    const out = patched(mozilla, "nozone-1@example.com", { start: "2026-10-01T15:00:00+02:00" }, NOW);
    assert.match(out, /\r\nDTSTART;TZID=\/mozilla\.org\/20050126_1\/Europe\/Berlin:20261001T150000\r\n/);
  });

  it("reads a time given without an offset as clock time in the event's own zone", () => {
    const out = patched(RICH, "rich-1@example.com", { start: "2026-10-29T15:00:00" }, NOW);
    assert.match(out, /\r\nDTSTART;TZID=Europe\/Berlin:20261029T150000\r\n/);
    assert.equal(iso(master(out, "rich-1@example.com").getFirstPropertyValue("dtstart")), "2026-10-29T14:00:00.000Z");
  });

  it("keeps a floating event floating, moved by its start alone", () => {
    const out = patched(FLOATING, "float-1@example.com", { start: "2026-10-01T15:00:00" }, NOW);
    assert.match(out, /\r\nDTSTART:20261001T150000\r\n/);
    assert.match(out, /\r\nDTEND:20261001T160000\r\n/);
  });

  it("refuses a time with an offset for a floating event, saying why", () => {
    for (const patch of [
      { start: "2026-10-01T15:00:00+02:00" },
      { start: "2026-10-01T15:00:00Z" },
      { start: "2026-10-01T15:00:00", end: "2026-10-01T16:00:00+02:00" },
    ]) {
      assert.throws(
        () => patched(FLOATING, "float-1@example.com", patch, NOW),
        (err: unknown) =>
          err instanceof ToolRefusal &&
          /floating/.test(err.message) &&
          /without an offset/.test(err.message) &&
          /Nothing was changed/.test(err.message),
        JSON.stringify(patch)
      );
    }
  });

  it("still refuses a one-sided change to a TZID nothing can place", () => {
    for (const patch of [{ start: "2026-10-01T11:00:00+02:00" }, { end: "2026-10-01T12:00:00+02:00" }]) {
      assert.throws(
        () => patched(CUSTOM_ZONE, "nozone-1@example.com", patch, NOW),
        (err: unknown) =>
          err instanceof ToolRefusal && /"My Custom Zone"/.test(err.message) && /Nothing was changed/.test(err.message),
        JSON.stringify(patch)
      );
    }
  });

  it("moves such an event when given both bounds, as UTC, since neither old time is needed", () => {
    const out = patched(
      CUSTOM_ZONE,
      "nozone-1@example.com",
      { start: "2026-10-01T11:00:00+02:00", end: "2026-10-01T12:00:00+02:00" },
      NOW
    );
    assert.match(out, /\r\nDTSTART:20261001T090000Z\r\n/);
    assert.match(out, /\r\nDTEND:20261001T100000Z\r\n/);
  });

  it("keeps a UTC event in UTC", () => {
    const out = patched(WITH_DURATION, "dur-1@example.com", { start: "2026-10-02T11:00:00+02:00" }, NOW);
    assert.match(out, /\r\nDTSTART:20261002T090000Z\r\n/);
    assert.match(out, /\r\nDTEND:20261002T094500Z\r\n/);
  });

  it("keeps everything else an update keeps when it rewrites the time", () => {
    const out = patched(RICH, "rich-1@example.com", { start: "2026-10-29T15:00:00+01:00" }, NOW);
    const ve = master(out, "rich-1@example.com");
    assert.equal(ve.getAllSubcomponents("valarm").length, 1, "the alarm was dropped");
    assert.equal(ve.getFirstProperty("attendee")?.getParameter("partstat"), "ACCEPTED");
    assert.equal(ve.getFirstPropertyValue("x-keep-me"), "yes");
  });

  it("leaves the other overrides of a series alone", () => {
    // The series' own time is refused one level up (CalDavClient); the patch
    // itself must still not touch an override's zone when it renames.
    const zoned = SERIES.replaceAll("DTSTART:2026", "DTSTART;TZID=Europe/Berlin:2026")
      .replaceAll("DTEND:2026", "DTEND;TZID=Europe/Berlin:2026")
      .replaceAll(/(DTSTART|DTEND)(;TZID=Europe\/Berlin:\d{8}T\d{6})Z/g, "$1$2");
    const out = patched(zoned, "series-1@example.com", { summary: "Renamed" }, NOW);
    assert.match(out, /\r\nDTSTART;TZID=Europe\/Berlin:20261008T110000\r\n/);
  });
});

describe("applyEventPatch — an event with no end (final review)", () => {
  it("moves it by its start and still gives it no end", () => {
    const out = patched(NO_END, "noend-1@example.com", { start: "2026-10-02T09:00:00Z" }, NOW);
    const ve = master(out, "noend-1@example.com");
    assert.equal(iso(ve.getFirstPropertyValue("dtstart")), "2026-10-02T09:00:00.000Z");
    assert.equal(ve.hasProperty("dtend"), false);
    assert.equal(ve.hasProperty("duration"), false);
  });

  it("gives it an end when one is asked for", () => {
    const out = patched(NO_END, "noend-1@example.com", { end: "2026-10-01T09:30:00Z" }, NOW);
    assert.equal(iso(master(out, "noend-1@example.com").getFirstPropertyValue("dtend")), "2026-10-01T09:30:00.000Z");
  });
});

describe("applyEventPatch — dates it cannot read (final review)", () => {
  it("refuses an unparseable timed start as an answer, not a server failure", () => {
    assert.throws(
      () => patched(RICH, "rich-1@example.com", { start: "tomorrow 9am" }, NOW),
      (err: unknown) => err instanceof ToolRefusal && /"tomorrow 9am"/.test(err.message)
    );
  });

  it("refuses an all-day date that is not a calendar date, instead of writing a rolled-over one", () => {
    for (const patch of [
      { start: "2026-10-05", end: "2026-13-45" },
      { start: "next monday", end: "next tuesday" },
    ]) {
      assert.throws(
        () => patched(ALL_DAY, "allday-1@example.com", patch, NOW),
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

describe("writtenBy — the read-back's test for its own write (PR 3 review, #214)", () => {
  it("reads the main VEVENT's SEQUENCE, treating an absent one as 0", () => {
    assert.equal(writtenBy(RICH, { uid: "rich-1@example.com", sequence: 2 }), true);
    assert.equal(writtenBy(RICH, { uid: "rich-1@example.com", sequence: 3 }), false);
    assert.equal(writtenBy(ALL_DAY, { uid: "allday-1@example.com", sequence: 0 }), true);
  });

  it("is false for a UID the object does not hold, and for text that is not iCalendar", () => {
    assert.equal(writtenBy(RICH, { uid: "someone-else@example.com", sequence: 2 }), false);
    assert.equal(writtenBy("not a calendar", { uid: "rich-1@example.com", sequence: 2 }), false);
  });

  it("knows an override's write by that override's SEQUENCE, not the master's", () => {
    // The master at SEQUENCE 0 (absent), its one override at 7.
    const text = SERIES.replace("RECURRENCE-ID:20261008T090000Z", "RECURRENCE-ID:20261008T090000Z\r\nSEQUENCE:7");
    const [override] = seriesFor(parseCalendar(text).vcal, "series-1@example.com").overrides;
    const key = keyOf(new ICAL.Event(override).recurrenceId, false);
    assert.equal(writtenBy(text, { uid: "series-1@example.com", sequence: 7, override: key }), true);
    assert.equal(writtenBy(text, { uid: "series-1@example.com", sequence: 0, override: key }), false);
    assert.equal(writtenBy(text, { uid: "series-1@example.com", sequence: 0 }), true);
  });
});

describe("sequenceOf (#214)", () => {
  it("is the reading both writtenBy and applyEventPatch use: absent or garbage is 0", () => {
    const withSequence = (value: string | null): ICAL.Component => {
      const text = value === null ? ALL_DAY : ALL_DAY.replace("SUMMARY:", `SEQUENCE:${value}\r\nSUMMARY:`);
      return master(text, "allday-1@example.com");
    };
    assert.equal(sequenceOf(withSequence(null)), 0);
    assert.equal(sequenceOf(withSequence("4")), 4);
    assert.equal(sequenceOf(withSequence("garbage")), 0);
    // What applyEventPatch writes is what writtenBy then reads back.
    const edit = applyEventPatch(parseCalendar(RICH), "rich-1@example.com", { summary: "x" }, "Nothing was changed.", NOW);
    assert.deepEqual(edit.mark, { uid: "rich-1@example.com", sequence: sequenceOf(master(RICH, "rich-1@example.com")) + 1 });
    assert.equal(edit.mark !== null && writtenBy(edit.ics, edit.mark), true);
  });
});

/** The VEVENT's DTSTART and DTEND lines exactly as written, for comparing two objects' times. */
function timeLines(text: string): string[] {
  const vevent = text.slice(text.indexOf("BEGIN:VEVENT"));
  return [...vevent.matchAll(/\r\n((?:DTSTART|DTEND)[;:][^\r]*)/g)].map((m) => m[1]);
}

/** The patch's times, or what its refusal was about: two objects asked the same thing must answer the same. */
function outcome(text: string, uid: string, patch: EventPatch): string[] | string {
  try {
    return timeLines(patched(text, uid, patch, NOW));
  } catch (err) {
    if (!(err instanceof ToolRefusal)) throw err;
    return /at or before it starts/.test(err.message) ? "ends at or before it starts" : err.message;
  }
}

describe("applyEventPatch — the gap and the overlap in an object with its own VTIMEZONE (review of #224)", () => {
  // RICH carries Berlin as an RRULE VTIMEZONE; the clocks go forward at 02:00
  // on 2026-03-29 and back at 03:00 on 2026-10-25. RFC 5545 §3.3.5: a wall
  // time in the gap is read with the offset from before it, one in the
  // overlap is its first occurrence. ical.js's own reading of a VTIMEZONE
  // does neither, and the write used it.

  it("reads a wall time in the overlap as its first occurrence", () => {
    // 02:30 is 00:30Z on the first pass; the end, 00:45Z, is after it. Read
    // as the second pass (01:30Z), the start came after the end and the
    // update was refused.
    const out = patched(RICH, "rich-1@example.com", { start: "2026-10-25T02:30:00", end: "2026-10-25T02:45:00+02:00" }, NOW);
    assert.deepEqual(timeLines(out), [
      "DTSTART;TZID=Europe/Berlin:20261025T023000",
      "DTEND;TZID=Europe/Berlin:20261025T024500",
    ]);
  });

  it("reads a wall time in the gap with the offset from before it, so 02:30 is written as 03:30", () => {
    const out = patched(RICH, "rich-1@example.com", { start: "2026-03-29T02:30:00" }, NOW);
    assert.deepEqual(timeLines(out), [
      "DTSTART;TZID=Europe/Berlin:20260329T033000",
      "DTEND;TZID=Europe/Berlin:20260329T043000",
    ]);
  });

  it("refuses 02:30 to 03:30 across the gap as the zero-length event RFC 5545 makes it, as it does without a VTIMEZONE", () => {
    for (const [text, uid] of [[RICH, "rich-1@example.com"], [BERLIN_NO_VTIMEZONE, "nozone-1@example.com"]] as const) {
      assert.throws(
        () => patched(text, uid, { start: "2026-03-29T02:30:00", end: "2026-03-29T03:30:00" }, NOW),
        (err: unknown) =>
          err instanceof ToolRefusal && /at or before it starts/.test(err.message) && /Nothing was changed/.test(err.message),
        uid
      );
    }
  });

  it("keeps the length of an event moved by its start into the overlap, measured from the first pass", () => {
    // One hour from 00:30Z is 01:30Z: the second 02:30, which no wall time
    // names, so the end is written in UTC.
    const out = patched(RICH, "rich-1@example.com", { start: "2026-10-25T02:30:00" }, NOW);
    assert.deepEqual(timeLines(out), ["DTSTART;TZID=Europe/Berlin:20261025T023000", "DTEND:20261025T013000Z"]);
  });

  it("writes the same times for an object with a VTIMEZONE as for one without", () => {
    const patches = [
      { start: "2026-10-25T02:30:00" },
      { start: "2026-10-25T01:30:00" },
      { start: "2026-10-25T02:30:00", end: "2026-10-25T03:30:00" },
      { start: "2026-10-25T02:30:00+01:00", end: "2026-10-25T04:00:00" },
      { start: "2026-03-29T02:30:00" },
      { start: "2026-03-29T01:30:00", end: "2026-03-29T02:15:00" },
      { start: "2026-03-29T02:30:00", end: "2026-03-29T03:30:00" },
      { end: "2026-10-25T02:30:00" },
      { start: "2026-07-01T09:00:00" },
    ];
    for (const patch of patches) {
      assert.deepEqual(
        outcome(RICH, "rich-1@example.com", patch),
        outcome(BERLIN_NO_VTIMEZONE, "nozone-1@example.com", patch),
        JSON.stringify(patch)
      );
    }
  });
});

describe("applyEventPatch — a bound on the second pass through the overlap (review of #224)", () => {
  it("writes an end that falls on the second 02:30 in UTC, not as a wall time that means the first", () => {
    // Written as TZID 02:30, the end would read as 00:30Z, the start's own
    // instant: a zero-length event for every RFC 5545 reader.
    const out = patched(BERLIN_NO_VTIMEZONE, "nozone-1@example.com", { start: "2026-10-25T02:30:00" }, NOW);
    assert.deepEqual(timeLines(out), ["DTSTART;TZID=Europe/Berlin:20261025T023000", "DTEND:20261025T013000Z"]);
  });

  it("does not write an end before its start when the end's wall time is earlier than the start's", () => {
    // 02:45 CEST is 00:45Z, 02:15 CET is 01:15Z: half an hour, but the wall
    // times run backwards.
    const out = patched(
      BERLIN_NO_VTIMEZONE,
      "nozone-1@example.com",
      { start: "2026-10-25T02:45:00+02:00", end: "2026-10-25T02:15:00+01:00" },
      NOW
    );
    assert.deepEqual(timeLines(out), ["DTSTART;TZID=Europe/Berlin:20261025T024500", "DTEND:20261025T011500Z"]);
  });

  it("writes a start on the second pass in UTC too, and the end that has a wall time in the zone", () => {
    const out = patched(
      BERLIN_NO_VTIMEZONE,
      "nozone-1@example.com",
      { start: "2026-10-25T02:30:00+01:00", end: "2026-10-25T04:00:00+01:00" },
      NOW
    );
    assert.deepEqual(timeLines(out), ["DTSTART:20261025T013000Z", "DTEND;TZID=Europe/Berlin:20261025T040000"]);
  });
});

/** An event create_event wrote on 2026-12-01 in Berlin, VTIMEZONE and all. */
const CREATED = buildIcs(
  {
    uid: "created-1@claude-mail-mcp",
    summary: "Created here",
    start: "2026-12-01T10:00:00+01:00",
    end: "2026-12-01T11:00:00+01:00",
  },
  "Europe/Berlin",
  "Nothing was created.",
  NOW
);

/** The instant `name` in `text` names when read by the object's own VTIMEZONE, as another client reads it. */
function instantByVtimezone(text: string, name: "dtstart" | "dtend"): string {
  const vcal = new ICAL.Component(ICAL.parse(text));
  const component = vcal.getFirstSubcomponent("vtimezone");
  assert.ok(component, "no VTIMEZONE");
  const local = (vcal.getFirstSubcomponent("vevent")?.getFirstPropertyValue(name) as ICAL.Time).clone();
  local.zone = new ICAL.Timezone(component);
  return local.toJSDate().toISOString();
}

describe("applyEventPatch — the VTIMEZONE create_event wrote covers every time the event moves to (review of #224)", () => {
  it("moves it years past the span its VTIMEZONE was generated for, as Berlin time, and the VTIMEZONE follows", () => {
    // Generated for 2025-12 to 2027-12, the block's last observance is +0100:
    // read as the zone's whole truth, 09:00 CEST was written as 08:00.
    const out = patched(CREATED, "created-1@claude-mail-mcp", { start: "2029-07-02T09:00:00+02:00" }, NOW);
    assert.deepEqual(timeLines(out), [
      "DTSTART;TZID=Europe/Berlin:20290702T090000",
      "DTEND;TZID=Europe/Berlin:20290702T100000",
    ]);
    assert.equal(vtimezones(out).length, 1);
    assert.equal(instantByVtimezone(out, "dtstart"), "2029-07-02T07:00:00.000Z");
    assert.equal(instantByVtimezone(out, "dtend"), "2029-07-02T08:00:00.000Z");
  });

  it("moves it to before that span, where ical.js reads the block as offset 0", () => {
    const out = patched(CREATED, "created-1@claude-mail-mcp", { start: "2024-07-02T09:00:00+02:00" }, NOW);
    assert.deepEqual(timeLines(out), [
      "DTSTART;TZID=Europe/Berlin:20240702T090000",
      "DTEND;TZID=Europe/Berlin:20240702T100000",
    ]);
    assert.equal(instantByVtimezone(out, "dtstart"), "2024-07-02T07:00:00.000Z");
    assert.equal(instantByVtimezone(out, "dtend"), "2024-07-02T08:00:00.000Z");
  });

  it("leaves its VTIMEZONE byte for byte when the time is not touched", () => {
    const out = patched(CREATED, "created-1@claude-mail-mcp", { summary: "Renamed" }, NOW);
    assert.equal(vtimezones(CREATED).length, 1);
    assert.deepEqual(vtimezones(out), vtimezones(CREATED));
  });

  it("never rewrites a VTIMEZONE another client wrote, bounded or not, however far the event moves", () => {
    // The same bounded block without this connector's mark is the other
    // client's, and how that client reads the event.
    const foreign = CREATED.replace(/X-CLAUDE-MAIL-MCP[^\r]*\r\n/, "");
    for (const [text, uid] of [[foreign, "created-1@claude-mail-mcp"], [RICH, "rich-1@example.com"]] as const) {
      const out = patched(text, uid, { start: "2029-07-02T09:00:00+02:00" }, NOW);
      assert.deepEqual(vtimezones(out), vtimezones(text), uid);
    }
  });
});
