/**
 * src/ical-expand.ts — a stored object turned into the instances
 * `list_events` reports, in the connector rather than on the server (spec
 * 2026-09-29 §2.2). No network: every case is a hand-written object.
 *
 * Every shape §0.1 found the server's own expansion failing on has a case
 * here as well as against Radicale: the all-day series (R1), the floating
 * series (R2) and the override-only object (R3). So do the two things the
 * connector now has to get right that the server used to: a TZID with no
 * VTIMEZONE (R6), and a rule that never ends.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { expandObject, MAX_OCCURRENCES_PER_OBJECT } from "../../src/ical-expand.js";

function ics(...lines: string[]): string {
  return `${lines.join("\r\n")}\r\n`;
}

function window(start: string, end: string): { start: number; end: number } {
  return { start: Date.parse(start), end: Date.parse(end) };
}

const OCTOBER = window("2026-10-01T00:00:00Z", "2026-11-01T00:00:00Z");
const OPTS = { url: "https://dav.example/cal/a.ics", etag: '"e1"' };

const BERLIN_VTIMEZONE = [
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
];

/**
 * Weekly on Thursdays from 2026-10-01, four times, plus an extra Saturday
 * (RDATE); the third Thursday cancelled (EXDATE); the second moved to 11:00;
 * the fourth moved out to December.
 */
const FULL_SERIES = ics(
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//Other Client//EN",
  "BEGIN:VEVENT",
  "UID:full@example.com",
  "DTSTAMP:20260901T080000Z",
  "DTSTART:20261001T090000Z",
  "DTEND:20261001T093000Z",
  "RRULE:FREQ=WEEKLY;COUNT=4",
  "RDATE:20261003T090000Z",
  "EXDATE:20261015T090000Z",
  "SUMMARY:Standup",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:full@example.com",
  "DTSTAMP:20260901T080000Z",
  "RECURRENCE-ID:20261008T090000Z",
  "DTSTART:20261008T110000Z",
  "DTEND:20261008T113000Z",
  "SUMMARY:Standup (moved)",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:full@example.com",
  "DTSTAMP:20260901T080000Z",
  "RECURRENCE-ID:20261022T090000Z",
  "DTSTART:20261201T090000Z",
  "DTEND:20261201T093000Z",
  "SUMMARY:Standup (December)",
  "END:VEVENT",
  "END:VCALENDAR"
);

describe("expandObject — a series", () => {
  it("applies RRULE, RDATE, EXDATE and both overrides, one of them moved out of the window", () => {
    const { instances, skipped } = expandObject(FULL_SERIES, OCTOBER, OPTS);
    assert.equal(skipped, undefined);
    assert.deepEqual(
      instances.map((e) => [e.recurrenceId, e.start, e.end, e.summary]),
      [
        ["2026-10-01T09:00:00.000Z", "2026-10-01T09:00:00.000Z", "2026-10-01T09:30:00.000Z", "Standup"],
        ["2026-10-03T09:00:00.000Z", "2026-10-03T09:00:00.000Z", "2026-10-03T09:30:00.000Z", "Standup"],
        ["2026-10-08T09:00:00.000Z", "2026-10-08T11:00:00.000Z", "2026-10-08T11:30:00.000Z", "Standup (moved)"],
      ]
    );
    for (const e of instances) {
      assert.equal(e.uid, "full@example.com");
      assert.equal(e.url, OPTS.url);
      assert.equal(e.etag, OPTS.etag);
      assert.equal(e.timezone, "UTC");
      assert.equal(e.allDay, false);
    }
  });

  it("finds an occurrence moved into the window from outside it, in either direction", () => {
    const december = expandObject(FULL_SERIES, window("2026-11-25T00:00:00Z", "2027-01-01T00:00:00Z"), OPTS);
    assert.deepEqual(
      december.instances.map((e) => [e.recurrenceId, e.start]),
      [["2026-10-22T09:00:00.000Z", "2026-12-01T09:00:00.000Z"]]
    );
    const early = FULL_SERIES.replace("DTSTART:20261201T090000Z", "DTSTART:20261002T090000Z").replace(
      "DTEND:20261201T093000Z",
      "DTEND:20261002T093000Z"
    );
    const firstWeek = expandObject(early, window("2026-10-01T00:00:00Z", "2026-10-05T00:00:00Z"), OPTS);
    assert.deepEqual(
      firstWeek.instances.map((e) => e.recurrenceId),
      ["2026-10-01T09:00:00.000Z", "2026-10-22T09:00:00.000Z", "2026-10-03T09:00:00.000Z"]
    );
  });

  it("stops an endless FREQ=MINUTELY rule at the cap, and says so in skipped", () => {
    const endless = ics(
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Other Client//EN",
      "BEGIN:VEVENT",
      "UID:minutely@example.com",
      "DTSTAMP:20260901T080000Z",
      "DTSTART:20261001T000000Z",
      "DURATION:PT1M",
      "RRULE:FREQ=MINUTELY",
      "SUMMARY:Tick",
      "END:VEVENT",
      "END:VCALENDAR"
    );
    const { instances, skipped } = expandObject(endless, OCTOBER, OPTS);
    assert.equal(instances.length, MAX_OCCURRENCES_PER_OBJECT);
    assert.equal(MAX_OCCURRENCES_PER_OBJECT, 1000);
    assert.match(skipped ?? "", /more than 1000 occurrences/);
  });

  it("stops walking a rule that is still short of the window after the step budget", () => {
    // A minutely rule from 2020 is millions of steps short of October 2026.
    const old = ics(
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Other Client//EN",
      "BEGIN:VEVENT",
      "UID:old-minutely@example.com",
      "DTSTAMP:20200101T000000Z",
      "DTSTART:20200101T000000Z",
      "DURATION:PT1M",
      "RRULE:FREQ=MINUTELY",
      "END:VEVENT",
      "END:VCALENDAR"
    );
    const started = Date.now();
    const { instances, skipped } = expandObject(old, OCTOBER, OPTS);
    assert.deepEqual(instances, []);
    assert.match(skipped ?? "", /gave up/);
    assert.ok(Date.now() - started < 10_000, "the budget did not bound the walk");
  });
});

describe("expandObject — zones (R6, #209)", () => {
  /** Berlin, weekly at 09:00, across the change back to CET on 2026-10-25. */
  function berlinWeekly(withVtimezone: boolean, tzid = "Europe/Berlin"): string {
    return ics(
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Other Client//EN",
      ...(withVtimezone ? BERLIN_VTIMEZONE : []),
      "BEGIN:VEVENT",
      "UID:berlin@example.com",
      "DTSTAMP:20260901T080000Z",
      `DTSTART;TZID=${tzid}:20261022T090000`,
      `DTEND;TZID=${tzid}:20261022T100000`,
      "RRULE:FREQ=WEEKLY;COUNT=2",
      "SUMMARY:Weekly",
      "END:VEVENT",
      "END:VCALENDAR"
    );
  }

  it("expands a TZID with no VTIMEZONE to the same instants as with one", () => {
    const expected = [
      ["2026-10-22T07:00:00.000Z", "2026-10-22T07:00:00.000Z"],
      ["2026-10-29T08:00:00.000Z", "2026-10-29T08:00:00.000Z"],
    ];
    for (const withVtimezone of [true, false]) {
      const { instances, skipped } = expandObject(berlinWeekly(withVtimezone), OCTOBER, OPTS);
      assert.equal(skipped, undefined);
      assert.deepEqual(instances.map((e) => [e.recurrenceId, e.start]), expected, `withVtimezone: ${withVtimezone}`);
      assert.deepEqual(instances.map((e) => e.timezone), ["Europe/Berlin", "Europe/Berlin"]);
    }
  });

  it("skips an unknown TZID with no VTIMEZONE and names it, rather than throwing", () => {
    const { instances, skipped } = expandObject(berlinWeekly(false, "My Custom Zone"), OCTOBER, OPTS);
    assert.deepEqual(instances, []);
    assert.match(skipped ?? "", /"My Custom Zone"/);
  });

  it("reports a floating series as clock time with no offset (R2)", () => {
    const floating = berlinWeekly(false).replaceAll(";TZID=Europe/Berlin", "");
    const { instances } = expandObject(floating, OCTOBER, OPTS);
    assert.deepEqual(
      instances.map((e) => [e.recurrenceId, e.start, e.end, e.timezone]),
      [
        ["2026-10-22T09:00:00", "2026-10-22T09:00:00", "2026-10-22T10:00:00", "floating"],
        ["2026-10-29T09:00:00", "2026-10-29T09:00:00", "2026-10-29T10:00:00", "floating"],
      ]
    );
  });
});

describe("expandObject — shapes the server's expansion failed on", () => {
  it("reports an all-day series' recurrenceId as a date, never a midnight (R1)", () => {
    const allDay = ics(
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Other Client//EN",
      "BEGIN:VEVENT",
      "UID:allday-series@example.com",
      "DTSTAMP:20260901T080000Z",
      "DTSTART;VALUE=DATE:20261001",
      "DTEND;VALUE=DATE:20261002",
      "RRULE:FREQ=WEEKLY;COUNT=3",
      "SUMMARY:Bins out",
      "END:VEVENT",
      "END:VCALENDAR"
    );
    const { instances } = expandObject(allDay, OCTOBER, OPTS);
    assert.deepEqual(
      instances.map((e) => [e.recurrenceId, e.start, e.end, e.allDay]),
      [
        ["2026-10-01", "2026-10-01", "2026-10-02", true],
        ["2026-10-08", "2026-10-08", "2026-10-09", true],
        ["2026-10-15", "2026-10-15", "2026-10-16", true],
      ]
    );
  });

  it("lists an override with no master as the one instance it is (R3)", () => {
    const overrideOnly = ics(
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Other Client//EN",
      "BEGIN:VEVENT",
      "UID:invited-once@example.com",
      "DTSTAMP:20260901T080000Z",
      "RECURRENCE-ID:20261008T090000Z",
      "DTSTART:20261008T100000Z",
      "DTEND:20261008T110000Z",
      "SUMMARY:The one I was invited to",
      "END:VEVENT",
      "END:VCALENDAR"
    );
    const { instances } = expandObject(overrideOnly, OCTOBER, OPTS);
    assert.deepEqual(
      instances.map((e) => [e.recurrenceId, e.start, e.summary]),
      [["2026-10-08T09:00:00.000Z", "2026-10-08T10:00:00.000Z", "The one I was invited to"]]
    );
  });

  it("names an object it cannot parse in skipped, rather than throwing (#211.2)", () => {
    const broken = ics("BEGIN:VCALENDAR", "BEGIN:VEVENT", "X-FOO;BAR:val", "END:VEVENT", "END:VCALENDAR");
    const { instances, skipped } = expandObject(broken, OCTOBER, OPTS);
    assert.deepEqual(instances, []);
    assert.match(skipped ?? "", /could not be read/);
  });
});

describe("expandObject — a plain event", () => {
  it("reports what list_events always did, plus timezone and transparent", () => {
    const plain = ics(
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Other Client//EN",
      "BEGIN:VEVENT",
      "UID:plain@example.com",
      "DTSTAMP:20260901T080000Z",
      "DTSTART:20261002T090000Z",
      "DTEND:20261002T100000Z",
      "SUMMARY:Dentist",
      "LOCATION:Main St",
      "TRANSP:TRANSPARENT",
      "STATUS:CONFIRMED",
      "ORGANIZER:mailto:me@example.com",
      "ATTENDEE;PARTSTAT=ACCEPTED:mailto:ben@example.com",
      "END:VEVENT",
      "END:VCALENDAR"
    );
    assert.deepEqual(expandObject(plain, OCTOBER, OPTS).instances, [
      {
        uid: "plain@example.com",
        url: OPTS.url,
        summary: "Dentist",
        description: null,
        location: "Main St",
        start: "2026-10-02T09:00:00.000Z",
        end: "2026-10-02T10:00:00.000Z",
        allDay: false,
        timezone: "UTC",
        transparent: true,
        organizer: "mailto:me@example.com",
        attendees: ["mailto:ben@example.com"],
        status: "CONFIRMED",
        recurrenceId: null,
        etag: '"e1"',
      },
    ]);
  });

  it("leaves out an event outside the window", () => {
    const plain = FULL_SERIES.replace("RRULE:FREQ=WEEKLY;COUNT=4\r\n", "")
      .replace("RDATE:20261003T090000Z\r\n", "")
      .replace("EXDATE:20261015T090000Z\r\n", "");
    assert.deepEqual(expandObject(plain, window("2026-11-01T00:00:00Z", "2026-11-30T00:00:00Z"), OPTS).instances, []);
  });
});
