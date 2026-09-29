/**
 * One occurrence of a series (#206, spec 2026-09-29 §2.3) and a series' time
 * (#207, §2.4), in the pure modules: src/ical-expand.ts's `findOccurrence`,
 * the worker operation that matches a caller's `recurrence_id` against the
 * expanded series, and src/ical-edit.ts's edits that write what it found.
 *
 * Every case runs against a fixture for each shape a series' DTSTART can
 * have — TZID with its VTIMEZONE, TZID without one, UTC, DATE, and floating —
 * and is checked twice: by the lines written, and by `expandObject`, the
 * reader `list_events` uses, so a write that reads back differently from what
 * it claims fails here and not on a user's calendar.
 *
 * The fixtures carry what an in-place edit must keep (VALARM, ATTENDEE with
 * its parameters, an X- property, the VTIMEZONE, another override), because
 * a test that only edits a bare VEVENT cannot tell an edit from a rebuild.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { applyOccurrencePatch, excludeOccurrence, type EventPatch } from "../../src/ical-edit.js";
import { expandObject, findOccurrence, type FoundOccurrence } from "../../src/ical-expand.js";
import { parseCalendar } from "../../src/ical-parse.js";
import { OP_ACTIONS, WORKER_OPS } from "../../src/ical-worker-ops.js";
import { ToolRefusal } from "../../src/tool-refusal.js";

const NOW = new Date("2026-09-28T12:00:00Z");
const CHANGED = "Nothing was changed.";
const DELETED = "Nothing was deleted.";
const UID = "weekly@example.com";

function ics(...lines: string[]): string {
  return `${lines.join("\r\n")}\r\n`;
}

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

type ShapeName = "TZID with VTIMEZONE" | "TZID without VTIMEZONE" | "UTC" | "DATE" | "floating";

interface Shape {
  name: ShapeName;
  vtimezone: boolean;
  allDay: boolean;
  /** A property holding the time `hhmm` (ignored for DATE) on `ymd`, as the shape stores it. */
  line(prop: string, ymd: string, hhmm: string): string;
  /** What list_events reports as the recurrenceId of the 09:00 occurrence on `ymd` (YYYY-MM-DD). */
  reported(ymd: string): string;
}

/** Berlin is +02:00 until 2026-10-25 and +01:00 after. */
function berlinUtc(ymd: string, hour: number): string {
  const offset = ymd < "2026-10-25" ? 2 : 1;
  return `${ymd}T${String(hour - offset).padStart(2, "0")}:00:00.000Z`;
}

const SHAPES: Shape[] = [
  {
    name: "TZID with VTIMEZONE",
    vtimezone: true,
    allDay: false,
    line: (prop, ymd, hhmm) => `${prop};TZID=Europe/Berlin:${ymd}T${hhmm}00`,
    reported: (ymd) => berlinUtc(ymd, 9),
  },
  {
    name: "TZID without VTIMEZONE",
    vtimezone: false,
    allDay: false,
    line: (prop, ymd, hhmm) => `${prop};TZID=Europe/Berlin:${ymd}T${hhmm}00`,
    reported: (ymd) => berlinUtc(ymd, 9),
  },
  {
    name: "UTC",
    vtimezone: false,
    allDay: false,
    line: (prop, ymd, hhmm) => `${prop}:${ymd}T${hhmm}00Z`,
    reported: (ymd) => `${ymd}T09:00:00.000Z`,
  },
  {
    name: "DATE",
    vtimezone: false,
    allDay: true,
    line: (prop, ymd) => `${prop};VALUE=DATE:${ymd}`,
    reported: (ymd) => ymd,
  },
  {
    name: "floating",
    vtimezone: false,
    allDay: false,
    line: (prop, ymd, hhmm) => `${prop}:${ymd}T${hhmm}00`,
    reported: (ymd) => `${ymd}T09:00:00`,
  },
];

/** `20261008` from `2026-10-08`. */
function compact(ymd: string): string {
  return ymd.replaceAll("-", "");
}

/** The day after `ymd` (compact form), for an all-day DTEND. */
function dayAfter(ymd: string): string {
  const d = new Date(`${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10).replaceAll("-", "");
}

/**
 * A weekly series of five Thursdays from 2026-10-01, 09:00–09:30 (a day long
 * for DATE), with everything an edit must keep, and one override: the third
 * Thursday, 2026-10-15, moved to 11:00 (to the Friday for DATE).
 */
function weekly(shape: Shape, rrule = "FREQ=WEEKLY;COUNT=5", masterExtra: string[] = []): string {
  const end = (ymd: string, hhmm: string): string =>
    shape.allDay ? shape.line("DTEND", dayAfter(ymd), hhmm) : shape.line("DTEND", ymd, hhmm);
  return ics(
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Other Client//EN",
    ...(shape.vtimezone ? BERLIN_VTIMEZONE : []),
    "BEGIN:VEVENT",
    `UID:${UID}`,
    "DTSTAMP:20260901T080000Z",
    shape.line("DTSTART", "20261001", "0900"),
    end("20261001", "0930"),
    `RRULE:${rrule}`,
    ...masterExtra,
    "SUMMARY:Weekly",
    "SEQUENCE:3",
    "ATTENDEE;CN=Ben;PARTSTAT=ACCEPTED;ROLE=REQ-PARTICIPANT:mailto:ben@example.com",
    "X-KEEP-ME:yes",
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    "TRIGGER:-PT15M",
    "DESCRIPTION:Reminder",
    "END:VALARM",
    "END:VEVENT",
    "BEGIN:VEVENT",
    `UID:${UID}`,
    "DTSTAMP:20260901T080000Z",
    shape.line("RECURRENCE-ID", "20261015", "0900"),
    shape.allDay ? shape.line("DTSTART", "20261016", "") : shape.line("DTSTART", "20261015", "1100"),
    shape.allDay ? shape.line("DTEND", "20261017", "") : shape.line("DTEND", "20261015", "1130"),
    "SUMMARY:Weekly (moved)",
    "SEQUENCE:1",
    "END:VEVENT",
    "END:VCALENDAR"
  );
}

/** RFC 5545 §3.1: a long line is folded at 75 octets; compare content lines, not folds. */
function unfold(text: string): string {
  return text.replaceAll("\r\n ", "");
}

/** The VEVENT blocks of an object, as serialised, unfolded. */
function vevents(text: string): string[] {
  return [...unfold(text).matchAll(/BEGIN:VEVENT\r\n[\s\S]*?END:VEVENT\r\n/g)].map((m) => m[0]);
}

/** The VEVENT block whose RECURRENCE-ID line is `rid`, or the master for null. */
function block(text: string, rid: string | null): string {
  const found = vevents(text).find((b) => (rid === null ? !/\r\nRECURRENCE-ID[;:]/.test(b) : b.includes(`\r\n${rid}\r\n`)));
  assert.ok(found, `no VEVENT ${rid ?? "(master)"} in:\n${text}`);
  return found;
}

function vtimezones(text: string): string[] {
  return [...text.matchAll(/BEGIN:VTIMEZONE\r\n[\s\S]*?END:VTIMEZONE\r\n/g)].map((m) => m[0]);
}

/** What list_events would list for the object: [recurrenceId, start, summary] per instance. */
function listed(text: string): Array<[string | null, string, string | null]> {
  const { instances, skipped } = expandObject(
    text,
    { start: Date.parse("2026-09-01T00:00:00Z"), end: Date.parse("2027-12-31T00:00:00Z") },
    { url: "https://dav.example/cal/weekly.ics", etag: null }
  );
  assert.equal(skipped, undefined, `the object could not be listed: ${skipped}`);
  return instances.map((e) => [e.recurrenceId, e.start, e.summary]);
}

/** `findOccurrence`, which must find it. */
function occurrence(text: string, rid: string | null, uid = UID): FoundOccurrence {
  const found = findOccurrence(text, uid, rid);
  assert.ok(found.found, `not found: ${found.found ? "" : found.reason}`);
  return found;
}

function updateOne(text: string, rid: string | null, patch: EventPatch, uid = UID): string {
  return applyOccurrencePatch(parseCalendar(text), uid, occurrence(text, rid, uid), patch, CHANGED, NOW).ics;
}

function deleteOne(text: string, rid: string, uid = UID): string {
  return excludeOccurrence(parseCalendar(text), uid, occurrence(text, rid, uid), DELETED, NOW).ics;
}

describe("findOccurrence — a recurrence_id is matched against the expanded series, never built (spec §2.3)", () => {
  it("is a worker operation, with its own words for a timeout (src/ical-worker-ops.ts)", () => {
    assert.equal(WORKER_OPS.findOccurrence, findOccurrence);
    assert.match(OP_ACTIONS.findOccurrence, /occurrence/);
  });

  for (const shape of SHAPES) {
    it(`${shape.name}: finds the occurrence list_events reported, and hands back plain data`, () => {
      const text = weekly(shape);
      const rid = shape.reported("2026-10-08");
      assert.ok(listed(text).some(([r]) => r === rid), `list_events does not report ${rid}`);
      const found = occurrence(text, rid);
      assert.equal(found.recurrenceId, rid);
      assert.equal(found.isDate, shape.allDay);
      assert.equal(found.current, null, "the second Thursday has no override");
      // Structured clone carries it across the worker boundary unchanged.
      assert.deepEqual(structuredClone(found), found);
    });

    it(`${shape.name}: finds an overridden occurrence by its original start, and names its override`, () => {
      const text = weekly(shape);
      const found = occurrence(text, shape.reported("2026-10-15"));
      assert.notEqual(found.current, null);
      assert.deepEqual(found.overrides, [found.current]);
    });

    it(`${shape.name}: refuses an instant between two occurrences, and says what it is not`, () => {
      const between = shape.allDay ? "2026-10-10" : shape.reported("2026-10-10");
      const found = findOccurrence(weekly(shape), UID, between);
      assert.equal(found.found, false);
      assert.match(found.found ? "" : found.reason, /is not an occurrence/);
    });
  }

  it("round-trips an all-day series' recurrence_id as a date, and never as a midnight (Review Focus 2)", () => {
    const text = weekly(SHAPES[3]);
    assert.equal(occurrence(text, "2026-10-08").recurrenceId, "2026-10-08");
    for (const midnight of ["2026-10-08T00:00:00.000Z", "2026-10-08T00:00:00+02:00", "2026-10-08T00:00:00"]) {
      assert.equal(findOccurrence(text, UID, midnight).found, false, midnight);
    }
  });

  it("does not take a date for an occurrence of a timed series", () => {
    assert.equal(findOccurrence(weekly(SHAPES[0]), UID, "2026-10-08").found, false);
  });

  it("matches the same instant however it is written", () => {
    const text = weekly(SHAPES[0]);
    for (const same of ["2026-10-08T07:00:00Z", "2026-10-08T09:00:00+02:00", "2026-10-08T07:00:00.000Z"]) {
      assert.equal(occurrence(text, same).recurrenceId, "2026-10-08T07:00:00.000Z", same);
    }
  });

  it("refuses a recurrence_id on an event that does not recur", () => {
    const single = weekly(SHAPES[2]).replace("RRULE:FREQ=WEEKLY;COUNT=5\r\n", "").replace(/BEGIN:VEVENT\r\n(?:(?!END:VEVENT)[\s\S])*RECURRENCE-ID[\s\S]*?END:VEVENT\r\n/, "");
    const found = findOccurrence(single, UID, "2026-10-01T09:00:00.000Z");
    assert.equal(found.found, false);
    assert.match(found.found ? "" : found.reason, /does not recur/);
  });

  it("does not find an occurrence an EXDATE took out", () => {
    const text = weekly(SHAPES[2], "FREQ=WEEKLY;COUNT=5", ["EXDATE:20261008T090000Z"]);
    assert.equal(findOccurrence(text, UID, "2026-10-08T09:00:00.000Z").found, false);
  });

  it("says whether the series has an occurrence besides the one found", () => {
    assert.equal(occurrence(weekly(SHAPES[2]), "2026-10-08T09:00:00.000Z").others, true);
    const once = weekly(SHAPES[2], "FREQ=WEEKLY;COUNT=1").replace(/BEGIN:VEVENT\r\n(?:(?!END:VEVENT)[\s\S])*RECURRENCE-ID[\s\S]*?END:VEVENT\r\n/, "");
    assert.equal(occurrence(once, "2026-10-01T09:00:00.000Z").others, false);
  });

  it("never throws for what is in the object: an unreadable one is an answer", () => {
    const found = findOccurrence("BEGIN:VCALENDAR\r\nnonsense", UID, "2026-10-08");
    assert.equal(found.found, false);
  });
});

describe("applyOccurrencePatch — one occurrence changed (#206)", () => {
  for (const shape of SHAPES) {
    it(`${shape.name}: an occurrence with no override gets one — RECURRENCE-ID in the master's type and zone, the master's VALARM, no RRULE, RDATE or EXDATE — and the master is unchanged`, () => {
      const text = weekly(shape, "FREQ=WEEKLY;COUNT=5", [shape.line("EXDATE", "20261022", "0900")]);
      const out = updateOne(text, shape.reported("2026-10-08"), { summary: "Just this once" });
      const ridLine = shape.line("RECURRENCE-ID", "20261008", "0900");
      const override = block(out, ridLine);
      assert.match(override, /\r\nSUMMARY:Just this once\r\n/);
      assert.match(override, /BEGIN:VALARM\r\nACTION:DISPLAY\r\nTRIGGER:-PT15M/);
      assert.match(override, /ATTENDEE;CN=Ben;PARTSTAT=ACCEPTED;ROLE=REQ-PARTICIPANT:mailto:ben@example.com/);
      assert.match(override, /X-KEEP-ME:yes/);
      assert.doesNotMatch(override, /\r\n(?:RRULE|RDATE|EXDATE)[;:]/);
      // Its own time is the occurrence's: the same form, the same clock.
      assert.match(override, new RegExp(`\\r\\n${escape(shape.line("DTSTART", "20261008", "0900"))}\\r\\n`));
      assert.equal(block(out, null), block(text, null), "the master changed");
      assert.equal(block(out, shape.line("RECURRENCE-ID", "20261015", "0900")), block(text, shape.line("RECURRENCE-ID", "20261015", "0900")), "the other override changed");
      assert.deepEqual(vtimezones(out), vtimezones(text));

      const before = listed(text);
      const after = listed(out);
      assert.deepEqual(
        after.map(([r, s]) => [r, s]),
        before.map(([r, s]) => [r, s]),
        "an edit of the summary moved an occurrence"
      );
      assert.deepEqual(
        after.filter(([, , summary]) => summary === "Just this once").map(([r]) => r),
        [shape.reported("2026-10-08")]
      );
    });

    it(`${shape.name}: an occurrence with an override has that override edited, and nothing else`, () => {
      const text = weekly(shape);
      const ridLine = shape.line("RECURRENCE-ID", "20261015", "0900");
      const out = updateOne(text, shape.reported("2026-10-15"), { location: "Room 7" });
      assert.equal(vevents(out).length, 2, "a VEVENT was added");
      const override = block(out, ridLine);
      assert.match(override, /\r\nLOCATION:Room 7\r\n/);
      assert.match(override, /\r\nSUMMARY:Weekly \(moved\)\r\n/);
      assert.match(override, /\r\nSEQUENCE:2\r\n/);
      assert.equal(block(out, null), block(text, null), "the master changed");
    });

    it(`${shape.name}: deleting an occurrence adds an EXDATE in the master's type and zone, removes its override, and raises the master's SEQUENCE`, () => {
      const text = weekly(shape);
      const out = deleteOne(text, shape.reported("2026-10-15"));
      const master = block(out, null);
      assert.match(master, new RegExp(`\\r\\n${escape(shape.line("EXDATE", "20261015", "0900"))}\\r\\n`));
      assert.match(master, /\r\nSEQUENCE:4\r\n/);
      assert.match(master, /BEGIN:VALARM/);
      assert.equal(vevents(out).length, 1, "the override was kept");
      assert.deepEqual(vtimezones(out), vtimezones(text));
      assert.deepEqual(
        listed(out).map(([r]) => r),
        ["2026-10-01", "2026-10-08", "2026-10-22", "2026-10-29"].map((d) => shape.reported(d))
      );
    });
  }

  it("moves one occurrence to a new time in the series' zone, keeping its length, across the DST change", () => {
    // The fifth Thursday, 2026-10-29, is after the clocks went back.
    const text = weekly(SHAPES[0]);
    const out = updateOne(text, "2026-10-29T08:00:00.000Z", { start: "2026-10-29T15:00:00" });
    const override = block(out, "RECURRENCE-ID;TZID=Europe/Berlin:20261029T090000");
    assert.match(override, /\r\nDTSTART;TZID=Europe\/Berlin:20261029T150000\r\n/);
    assert.match(override, /\r\nDTEND;TZID=Europe\/Berlin:20261029T153000\r\n/);
    assert.deepEqual(listed(out).at(-1), ["2026-10-29T08:00:00.000Z", "2026-10-29T14:00:00.000Z", "Weekly"]);
  });

  it("moves an occurrence to another day, which is only that occurrence's business", () => {
    const out = updateOne(weekly(SHAPES[2]), "2026-10-08T09:00:00.000Z", { start: "2026-10-09T09:00:00Z" });
    assert.ok(listed(out).some(([r, s]) => r === "2026-10-08T09:00:00.000Z" && s === "2026-10-09T09:00:00.000Z"));
  });

  it("refuses to switch one occurrence between all-day and timed", () => {
    assert.throws(
      () => updateOne(weekly(SHAPES[2]), "2026-10-08T09:00:00.000Z", { allDay: true, start: "2026-10-08", end: "2026-10-09" }),
      (err: unknown) => err instanceof ToolRefusal && /all-day/.test(err.message) && err.message.endsWith(CHANGED)
    );
  });

  it("refuses an offset for an occurrence of a floating series, as for the series itself", () => {
    assert.throws(
      () => updateOne(weekly(SHAPES[4]), "2026-10-08T09:00:00", { start: "2026-10-08T11:00:00+02:00" }),
      (err: unknown) => err instanceof ToolRefusal && /floating/.test(err.message) && /Nothing was changed/.test(err.message)
    );
  });
});

/** One VEVENT with a RECURRENCE-ID and no master: an invitation to a single instance (#211.3). */
const OVERRIDE_ONLY = ics(
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//Other Client//EN",
  "BEGIN:VEVENT",
  "UID:invited@example.com",
  "DTSTAMP:20260901T080000Z",
  "RECURRENCE-ID:20261008T090000Z",
  "DTSTART:20261008T100000Z",
  "DTEND:20261008T110000Z",
  "SUMMARY:The one I was invited to",
  "ATTENDEE;CN=Me;PARTSTAT=NEEDS-ACTION:mailto:me@example.com",
  "END:VEVENT",
  "END:VCALENDAR"
);

describe("an override with no master (#211.3)", () => {
  it("is changed with its recurrence_id", () => {
    const out = updateOne(OVERRIDE_ONLY, "2026-10-08T09:00:00.000Z", { summary: "Accepted it" }, "invited@example.com");
    assert.match(out, /\r\nSUMMARY:Accepted it\r\n/);
    assert.match(out, /PARTSTAT=NEEDS-ACTION/);
    assert.equal(vevents(out).length, 1);
  });

  it("is changed without one, being the only occurrence the object holds", () => {
    const out = updateOne(OVERRIDE_ONLY, null, { start: "2026-10-08T12:00:00Z" }, "invited@example.com");
    assert.match(out, /\r\nDTSTART:20261008T120000Z\r\n/);
    assert.match(out, /\r\nDTEND:20261008T130000Z\r\n/);
    assert.match(out, /\r\nRECURRENCE-ID:20261008T090000Z\r\n/);
  });

  it("asks for a recurrence_id when the object holds more than one occurrence", () => {
    const two = OVERRIDE_ONLY.replace(
      "END:VCALENDAR",
      "BEGIN:VEVENT\r\nUID:invited@example.com\r\nDTSTAMP:20260901T080000Z\r\nRECURRENCE-ID:20261015T090000Z\r\nDTSTART:20261015T100000Z\r\nDTEND:20261015T110000Z\r\nSUMMARY:And this one\r\nEND:VEVENT\r\nEND:VCALENDAR"
    );
    const found = findOccurrence(two, "invited@example.com", null);
    assert.equal(found.found, false);
    assert.match(found.found ? "" : found.reason, /recurrence_id/);
  });

  it("needs a recurrence_id on a series that has a master", () => {
    const found = findOccurrence(weekly(SHAPES[2]), UID, null);
    assert.equal(found.found, false);
  });
});

/** A RegExp source for `text` taken literally. */
function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}
