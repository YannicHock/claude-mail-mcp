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

import ICAL from "ical.js";

import { expandObject, impossibleRule, MAX_OCCURRENCES_PER_OBJECT } from "../../src/ical-expand.js";
import { EXPANSION_DEADLINE_MS } from "../../src/ical-worker-pool.js";

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

/** A VEVENT's lines, for the review cases below. */
function vevent(...lines: string[]): string[] {
  return ["BEGIN:VEVENT", "DTSTAMP:20260901T080000Z", ...lines, "END:VEVENT"];
}

function calendar(...components: string[][]): string {
  return ics("BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Other Client//EN", ...components.flat(), "END:VCALENDAR");
}

describe("impossibleRule — a rule that can never match a date is refused before it is walked", () => {
  const rule = (text: string): ICAL.Recur => ICAL.Recur.fromString(text);

  it("names BYMONTHDAY past the last day of every BYMONTH given", () => {
    assert.match(impossibleRule(rule("FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30")) ?? "", /BYMONTHDAY=30.*BYMONTH=2/);
    assert.match(impossibleRule(rule("FREQ=HOURLY;BYMONTH=4,6,9,11;BYMONTHDAY=31")) ?? "", /BYMONTHDAY=31/);
    assert.match(impossibleRule(rule("FREQ=DAILY;BYMONTH=2;BYMONTHDAY=-30,-31")) ?? "", /BYMONTHDAY=-30,-31/);
  });

  it("lets through every combination that has a date, however rare", () => {
    assert.equal(impossibleRule(rule("FREQ=DAILY;BYMONTH=2;BYMONTHDAY=29")), null, "every leap year");
    assert.equal(impossibleRule(rule("FREQ=DAILY;BYMONTH=2,4;BYMONTHDAY=30")), null, "April has a 30th");
    assert.equal(impossibleRule(rule("FREQ=DAILY;BYMONTH=2;BYMONTHDAY=-29")), null);
    assert.equal(impossibleRule(rule("FREQ=DAILY;BYMONTHDAY=31")), null, "no BYMONTH: seven months have one");
    assert.equal(impossibleRule(rule("FREQ=WEEKLY;BYDAY=MO")), null);
  });

  it("lists a series whose rule can never match without walking it: its start, and says why (the review's hang)", () => {
    for (const rrule of ["RRULE:FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30", "RRULE:FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30;COUNT=3"]) {
      const obj = calendar(
        vevent("UID:never@example.com", "DTSTART:20261005T090000Z", "DTEND:20261005T100000Z", rrule, "SUMMARY:Never")
      );
      const started = Date.now();
      const { instances, skipped } = expandObject(obj, OCTOBER, OPTS);
      assert.ok(Date.now() - started < 1000, "the rule was walked");
      assert.deepEqual(
        instances.map((e) => [e.start, e.recurrenceId]),
        [["2026-10-05T09:00:00.000Z", "2026-10-05T09:00:00.000Z"]]
      );
      assert.match(skipped ?? "", /can never match/);
    }
  });
});

describe("expandObject — overrides the walk does not meet (review of #223)", () => {
  /** Weekly on Thursdays 09:00Z from 2026-10-01, four times. */
  const MASTER = [
    "UID:ov@example.com",
    "DTSTART:20261001T090000Z",
    "DTEND:20261001T093000Z",
    "RRULE:FREQ=WEEKLY;COUNT=4",
    "SUMMARY:Standup",
  ];

  it("(a) lists an override whose occurrence is also in EXDATE, at its own time", () => {
    const obj = calendar(
      vevent(...MASTER, "EXDATE:20261008T090000Z"),
      vevent(
        "UID:ov@example.com",
        "RECURRENCE-ID:20261008T090000Z",
        "DTSTART:20261008T110000Z",
        "DTEND:20261008T113000Z",
        "SUMMARY:Moved"
      )
    );
    const { instances, skipped } = expandObject(obj, OCTOBER, OPTS);
    assert.equal(skipped, undefined);
    assert.deepEqual(
      instances.map((e) => [e.recurrenceId, e.start, e.summary]),
      [
        ["2026-10-01T09:00:00.000Z", "2026-10-01T09:00:00.000Z", "Standup"],
        ["2026-10-08T09:00:00.000Z", "2026-10-08T11:00:00.000Z", "Moved"],
        ["2026-10-15T09:00:00.000Z", "2026-10-15T09:00:00.000Z", "Standup"],
        ["2026-10-22T09:00:00.000Z", "2026-10-22T09:00:00.000Z", "Standup"],
      ]
    );
  });

  it("(b) matches an override whose RECURRENCE-ID is in another zone by its instant, and drops the master's occurrence", () => {
    const obj = calendar(
      vevent(
        "UID:zoned@example.com",
        "DTSTART;TZID=Europe/Berlin:20261001T090000",
        "DTEND;TZID=Europe/Berlin:20261001T100000",
        "RRULE:FREQ=WEEKLY;COUNT=3",
        "SUMMARY:Berlin"
      ),
      // 03:00 in New York on 2026-10-08 is 09:00 in Berlin: the second occurrence.
      vevent(
        "UID:zoned@example.com",
        "RECURRENCE-ID;TZID=America/New_York:20261008T030000",
        "DTSTART;TZID=Europe/Berlin:20261008T140000",
        "DTEND;TZID=Europe/Berlin:20261008T150000",
        "SUMMARY:Berlin (afternoon)"
      )
    );
    const { instances } = expandObject(obj, OCTOBER, OPTS);
    assert.deepEqual(
      instances.map((e) => [e.recurrenceId, e.start, e.summary]),
      [
        ["2026-10-01T07:00:00.000Z", "2026-10-01T07:00:00.000Z", "Berlin"],
        ["2026-10-08T07:00:00.000Z", "2026-10-08T12:00:00.000Z", "Berlin (afternoon)"],
        ["2026-10-15T07:00:00.000Z", "2026-10-15T07:00:00.000Z", "Berlin"],
      ]
    );
  });

  it("(c) matches a DATE-TIME RECURRENCE-ID to an all-day series by its date", () => {
    const obj = calendar(
      vevent(
        "UID:bins@example.com",
        "DTSTART;VALUE=DATE:20261001",
        "DTEND;VALUE=DATE:20261002",
        "RRULE:FREQ=WEEKLY;COUNT=3",
        "SUMMARY:Bins"
      ),
      vevent(
        "UID:bins@example.com",
        "RECURRENCE-ID:20261008T000000",
        "DTSTART;VALUE=DATE:20261009",
        "DTEND;VALUE=DATE:20261010",
        "SUMMARY:Bins (Friday)"
      )
    );
    const { instances } = expandObject(obj, OCTOBER, OPTS);
    assert.deepEqual(
      instances.map((e) => [e.recurrenceId, e.start, e.summary]),
      [
        ["2026-10-01", "2026-10-01", "Bins"],
        ["2026-10-08", "2026-10-09", "Bins (Friday)"],
        ["2026-10-15", "2026-10-15", "Bins"],
      ]
    );
  });

  it("(d) lists an override whose RECURRENCE-ID matches no occurrence, at its own time, beside the whole series", () => {
    const obj = calendar(
      vevent(...MASTER),
      vevent(
        "UID:ov@example.com",
        "RECURRENCE-ID:20261010T090000Z",
        "DTSTART:20261010T100000Z",
        "DTEND:20261010T110000Z",
        "SUMMARY:Orphan"
      )
    );
    const { instances } = expandObject(obj, OCTOBER, OPTS);
    assert.deepEqual(
      instances.map((e) => [e.recurrenceId, e.start, e.summary]),
      [
        ["2026-10-01T09:00:00.000Z", "2026-10-01T09:00:00.000Z", "Standup"],
        ["2026-10-08T09:00:00.000Z", "2026-10-08T09:00:00.000Z", "Standup"],
        ["2026-10-10T09:00:00.000Z", "2026-10-10T10:00:00.000Z", "Orphan"],
        ["2026-10-15T09:00:00.000Z", "2026-10-15T09:00:00.000Z", "Standup"],
        ["2026-10-22T09:00:00.000Z", "2026-10-22T09:00:00.000Z", "Standup"],
      ]
    );
  });

  it("keeps RANGE=THISANDFUTURE: every later occurrence is shifted and renamed", () => {
    const obj = calendar(
      vevent(...MASTER),
      vevent(
        "UID:ov@example.com",
        "RECURRENCE-ID;RANGE=THISANDFUTURE:20261015T090000Z",
        "DTSTART:20261015T100000Z",
        "DTEND:20261015T103000Z",
        "SUMMARY:Later"
      )
    );
    const { instances } = expandObject(obj, OCTOBER, OPTS);
    assert.deepEqual(
      instances.map((e) => [e.recurrenceId, e.start, e.summary]),
      [
        ["2026-10-01T09:00:00.000Z", "2026-10-01T09:00:00.000Z", "Standup"],
        ["2026-10-08T09:00:00.000Z", "2026-10-08T09:00:00.000Z", "Standup"],
        ["2026-10-15T09:00:00.000Z", "2026-10-15T10:00:00.000Z", "Later"],
        ["2026-10-22T09:00:00.000Z", "2026-10-22T10:00:00.000Z", "Later"],
      ]
    );
  });
});

describe("expandObject — RDATE;VALUE=PERIOD (review of #223)", () => {
  it("lists each period from its start to its end, or its start plus its duration", () => {
    const obj = calendar(
      vevent(
        "UID:period@example.com",
        "DTSTART:20261001T090000Z",
        "DTEND:20261001T093000Z",
        "RRULE:FREQ=WEEKLY;COUNT=2",
        "RDATE;VALUE=PERIOD:20261005T090000Z/20261005T120000Z,20261006T090000Z/PT45M",
        "SUMMARY:Workshop"
      )
    );
    const { instances, skipped } = expandObject(obj, OCTOBER, OPTS);
    assert.equal(skipped, undefined);
    assert.deepEqual(
      instances.map((e) => [e.recurrenceId, e.start, e.end]),
      [
        ["2026-10-01T09:00:00.000Z", "2026-10-01T09:00:00.000Z", "2026-10-01T09:30:00.000Z"],
        ["2026-10-05T09:00:00.000Z", "2026-10-05T09:00:00.000Z", "2026-10-05T12:00:00.000Z"],
        ["2026-10-06T09:00:00.000Z", "2026-10-06T09:00:00.000Z", "2026-10-06T09:45:00.000Z"],
        ["2026-10-08T09:00:00.000Z", "2026-10-08T09:00:00.000Z", "2026-10-08T09:30:00.000Z"],
      ]
    );
  });

  it("places a zoned period by its TZID, with or without a VTIMEZONE", () => {
    for (const withVtimezone of [true, false]) {
      const obj = calendar(
        ...(withVtimezone ? [BERLIN_VTIMEZONE] : []),
        vevent(
          "UID:period-berlin@example.com",
          "DTSTART;TZID=Europe/Berlin:20261001T090000",
          "DTEND;TZID=Europe/Berlin:20261001T093000",
          // No RRULE: the DTSTART instance is listed all the same (#226).
          "RDATE;VALUE=PERIOD;TZID=Europe/Berlin:20261005T090000/PT2H"
        )
      );
      const { instances } = expandObject(obj, OCTOBER, OPTS);
      assert.deepEqual(
        instances.map((e) => [e.start, e.end, e.timezone]),
        [
          ["2026-10-01T07:00:00.000Z", "2026-10-01T07:30:00.000Z", "Europe/Berlin"],
          ["2026-10-05T07:00:00.000Z", "2026-10-05T09:00:00.000Z", "Europe/Berlin"],
        ],
        `withVtimezone: ${withVtimezone}`
      );
    }
  });
});

describe("expandObject — an IANA zone with no VTIMEZONE costs about what one with it does (review of #223)", () => {
  /** Daily at 09:00 Berlin since 2016: about 3,900 steps from its start to October 2026. */
  function dailySince2016(withVtimezone: boolean): string {
    return calendar(
      ...(withVtimezone ? [BERLIN_VTIMEZONE] : []),
      vevent("UID:daily@example.com", "DTSTART;TZID=Europe/Berlin:20160101T090000", "DURATION:PT1H", "RRULE:FREQ=DAILY")
    );
  }

  /** The best of three runs, so one garbage collection does not decide the test. */
  function fastest(obj: string): number {
    let best = Infinity;
    for (let i = 0; i < 3; i++) {
      const started = performance.now();
      const { instances } = expandObject(obj, OCTOBER, OPTS);
      best = Math.min(best, performance.now() - started);
      assert.equal(instances.length, 31);
    }
    return best;
  }

  it("expands through Intl within 2.5× of the VTIMEZONE's time (it was 5–6×)", () => {
    const withVtimezone = fastest(dailySince2016(true));
    const throughIntl = fastest(dailySince2016(false));
    assert.ok(
      throughIntl < withVtimezone * 2.5,
      `Intl took ${throughIntl.toFixed(0)} ms, the VTIMEZONE ${withVtimezone.toFixed(0)} ms`
    );
  });
});

describe("expandObject — one override per RECURRENCE-ID (review of #225)", () => {
  /** Weekly on Thursdays 09:00Z from 2026-10-01, three times. */
  const MASTER = [
    "UID:dup@example.com",
    "DTSTART:20261001T090000Z",
    "DTEND:20261001T093000Z",
    "RRULE:FREQ=WEEKLY;COUNT=3",
    "SUMMARY:Standup",
  ];
  function override(sequence: number | null, summary: string, hour: string): string[] {
    return vevent(
      "UID:dup@example.com",
      "RECURRENCE-ID:20261008T090000Z",
      ...(sequence === null ? [] : [`SEQUENCE:${sequence}`]),
      `DTSTART:20261008T${hour}0000Z`,
      `DTEND:20261008T${hour}3000Z`,
      `SUMMARY:${summary}`
    );
  }

  it("keeps the one with the highest SEQUENCE, wherever it is, and lists no other as an extra event", () => {
    for (const obj of [
      calendar(vevent(...MASTER), override(1, "Old", "11"), override(2, "New", "12")),
      calendar(vevent(...MASTER), override(2, "New", "12"), override(1, "Old", "11")),
    ]) {
      const { instances, skipped } = expandObject(obj, OCTOBER, OPTS);
      assert.equal(skipped, undefined);
      assert.deepEqual(
        instances.map((e) => [e.recurrenceId, e.start, e.summary]),
        [
          ["2026-10-01T09:00:00.000Z", "2026-10-01T09:00:00.000Z", "Standup"],
          ["2026-10-08T09:00:00.000Z", "2026-10-08T12:00:00.000Z", "New"],
          ["2026-10-15T09:00:00.000Z", "2026-10-15T09:00:00.000Z", "Standup"],
        ]
      );
    }
  });

  it("keeps the later one in the object when their SEQUENCE ties (a missing SEQUENCE is 0)", () => {
    const obj = calendar(vevent(...MASTER), override(null, "First", "11"), override(0, "Second", "12"));
    const { instances } = expandObject(obj, OCTOBER, OPTS);
    assert.deepEqual(
      instances.map((e) => e.summary),
      ["Standup", "Second", "Standup"]
    );
  });

  it("does the same for overrides with no master (R3)", () => {
    const obj = calendar(override(3, "New", "12"), override(1, "Old", "11"));
    const { instances } = expandObject(obj, OCTOBER, OPTS);
    assert.deepEqual(
      instances.map((e) => [e.recurrenceId, e.summary]),
      [["2026-10-08T09:00:00.000Z", "New"]]
    );
  });

  it("matches a RECURRENCE-ID;VALUE=DATE to the timed occurrence on that date, rather than listing both", () => {
    const obj = calendar(
      vevent(...MASTER),
      vevent(
        "UID:dup@example.com",
        "RECURRENCE-ID;VALUE=DATE:20261008",
        "DTSTART:20261008T140000Z",
        "DTEND:20261008T143000Z",
        "SUMMARY:Afternoon"
      )
    );
    const { instances } = expandObject(obj, OCTOBER, OPTS);
    assert.deepEqual(
      instances.map((e) => [e.recurrenceId, e.start, e.summary]),
      [
        ["2026-10-01T09:00:00.000Z", "2026-10-01T09:00:00.000Z", "Standup"],
        ["2026-10-08T09:00:00.000Z", "2026-10-08T14:00:00.000Z", "Afternoon"],
        ["2026-10-15T09:00:00.000Z", "2026-10-15T09:00:00.000Z", "Standup"],
      ]
    );
  });
});

describe("expandObject — a long sparse series in an IANA zone stays well inside the deadline (review of #225)", () => {
  it("expands a yearly series since the year 100 in New York, cold, in under half the worker's deadline", () => {
    // 1,926 years from its start to 2026. Scanning every UTC year it touched
    // day by day cost 3.7 s — past the worker's 3 s deadline, so an honest
    // event was skipped as one that may never end.
    const obj = calendar(
      vevent(
        "UID:ancient@example.com",
        "DTSTART;TZID=America/New_York:01000101T090000",
        "DURATION:PT1H",
        "RRULE:FREQ=YEARLY",
        "SUMMARY:New year"
      )
    );
    const started = performance.now();
    const { instances, skipped } = expandObject(obj, window("2026-01-01T00:00:00Z", "2027-01-01T00:00:00Z"), OPTS);
    const elapsed = performance.now() - started;
    assert.equal(skipped, undefined);
    assert.deepEqual(
      instances.map((e) => e.start),
      ["2026-01-01T14:00:00.000Z"]
    );
    // The bound is the worker's deadline, halved, not a second (review of
    // PR #232): alone this takes about 300 ms, but in the full unit suite, with
    // other files' workers busy on the same cores, 850–970 ms, and a second
    // failed now and then. What it guards against is the 3.7 s the day-by-day
    // scan cost, past the 3 s deadline — an honest event then skipped as one
    // that may never end. Half the deadline still fails that by more than
    // two times, and says how close to the deadline an honest series may come.
    assert.ok(elapsed < EXPANSION_DEADLINE_MS / 2, `took ${elapsed.toFixed(0)} ms, against a deadline of ${EXPANSION_DEADLINE_MS} ms`);
  });
});

describe("expandObject — a series of DTSTART and RDATE with no RRULE keeps its first occurrence (#226)", () => {
  // RFC 5545 §3.8.5.2: the recurrence set is the DTSTART instance, plus every
  // RRULE and RDATE instance, minus EXDATE. ical.js's iterator, given RDATE
  // and no RRULE, lists the RDATEs and leaves the DTSTART instance out.
  const rdateOnly = (...extra: string[]): string =>
    calendar(
      vevent("UID:rdate@example.com", "DTSTART:20261001T090000Z", "DTEND:20261001T100000Z", ...extra, "SUMMARY:Talks")
    );

  it("lists the DTSTART occurrence before the RDATE ones", () => {
    const { instances, skipped } = expandObject(rdateOnly("RDATE:20261005T090000Z,20261008T090000Z"), OCTOBER, OPTS);
    assert.equal(skipped, undefined);
    assert.deepEqual(
      instances.map((e) => [e.recurrenceId, e.start, e.end]),
      [
        ["2026-10-01T09:00:00.000Z", "2026-10-01T09:00:00.000Z", "2026-10-01T10:00:00.000Z"],
        ["2026-10-05T09:00:00.000Z", "2026-10-05T09:00:00.000Z", "2026-10-05T10:00:00.000Z"],
        ["2026-10-08T09:00:00.000Z", "2026-10-08T09:00:00.000Z", "2026-10-08T10:00:00.000Z"],
      ]
    );
  });

  it("lists an RDATE equal to DTSTART once, however it is written", () => {
    for (const same of ["RDATE:20261001T090000Z", "RDATE;TZID=Europe/Berlin:20261001T110000"]) {
      const { instances } = expandObject(rdateOnly(same, "RDATE:20261008T090000Z"), OCTOBER, OPTS);
      assert.deepEqual(
        instances.map((e) => e.start),
        ["2026-10-01T09:00:00.000Z", "2026-10-08T09:00:00.000Z"],
        same
      );
    }
  });

  it("puts an RDATE before DTSTART in its place, and leaves DTSTART out when an EXDATE names it", () => {
    const early = expandObject(rdateOnly("RDATE:20260920T090000Z"), window("2026-09-01T00:00:00Z", "2026-11-01T00:00:00Z"), OPTS);
    assert.deepEqual(
      early.instances.map((e) => e.start),
      ["2026-09-20T09:00:00.000Z", "2026-10-01T09:00:00.000Z"]
    );
    const excluded = expandObject(rdateOnly("RDATE:20261005T090000Z", "EXDATE:20261001T090000Z"), OCTOBER, OPTS);
    assert.deepEqual(
      excluded.instances.map((e) => e.start),
      ["2026-10-05T09:00:00.000Z"]
    );
  });

  it("does the same for an all-day series, a zoned one, and one whose impossible RRULE was dropped", () => {
    const allDay = calendar(
      vevent("UID:rdate-day@example.com", "DTSTART;VALUE=DATE:20261001", "DTEND;VALUE=DATE:20261002", "RDATE;VALUE=DATE:20261005")
    );
    assert.deepEqual(
      expandObject(allDay, OCTOBER, OPTS).instances.map((e) => e.recurrenceId),
      ["2026-10-01", "2026-10-05"]
    );
    const zoned = calendar(
      vevent(
        "UID:rdate-berlin@example.com",
        "DTSTART;TZID=Europe/Berlin:20261001T090000",
        "DTEND;TZID=Europe/Berlin:20261001T100000",
        "RDATE;TZID=Europe/Berlin:20261029T090000"
      )
    );
    assert.deepEqual(
      expandObject(zoned, OCTOBER, OPTS).instances.map((e) => e.start),
      ["2026-10-01T07:00:00.000Z", "2026-10-29T08:00:00.000Z"]
    );
    // The note says "only its start and any RDATE are listed": its start too.
    const impossible = rdateOnly("RRULE:FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30", "RDATE:20261005T090000Z");
    const { instances, skipped } = expandObject(impossible, OCTOBER, OPTS);
    assert.match(skipped ?? "", /can never match/);
    assert.deepEqual(
      instances.map((e) => e.start),
      ["2026-10-01T09:00:00.000Z", "2026-10-05T09:00:00.000Z"]
    );
  });

  it("gives the DTSTART occurrence its override, like any other", () => {
    const obj = calendar(
      vevent("UID:rdate@example.com", "DTSTART:20261001T090000Z", "DTEND:20261001T100000Z", "RDATE:20261005T090000Z", "SUMMARY:Talks"),
      vevent(
        "UID:rdate@example.com",
        "RECURRENCE-ID:20261001T090000Z",
        "DTSTART:20261001T140000Z",
        "DTEND:20261001T150000Z",
        "SUMMARY:Talks (moved)"
      )
    );
    const { instances } = expandObject(obj, OCTOBER, OPTS);
    assert.deepEqual(
      instances.map((e) => [e.recurrenceId, e.start, e.summary]),
      [
        ["2026-10-01T09:00:00.000Z", "2026-10-01T14:00:00.000Z", "Talks (moved)"],
        ["2026-10-05T09:00:00.000Z", "2026-10-05T09:00:00.000Z", "Talks"],
      ]
    );
  });
});
