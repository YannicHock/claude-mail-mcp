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

import { applyOccurrencePatch, excludeOccurrence, shiftSeries, writtenBy, type EventPatch } from "../../src/ical-edit.js";
import { expandObject, findOccurrence, type FoundOccurrence } from "../../src/ical-expand.js";
import { buildIcs } from "../../src/ical-build.js";
import { parseCalendar } from "../../src/ical-parse.js";
import { instantToZonedWall } from "../../src/ical-zones.js";
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

/**
 * A change another client made to "this and all following occurrences": an
 * override with `RECURRENCE-ID;RANGE=THISANDFUTURE`, which moves and retitles
 * every occurrence from its own on. Each one-occurrence write must change
 * exactly the occurrence it names — the fix-pass review of PR #229 found all
 * three ignoring RANGE: a new override copied from the master reverted the
 * occurrence to the series' old time and title, deleting the anchor took the
 * override and every later occurrence's change with it, and editing the
 * anchor edited the override, RANGE and all, so every later one moved too.
 */
describe("RANGE=THISANDFUTURE — a one-occurrence write changes exactly one occurrence (fix-pass review of PR #229)", () => {
  /** The instant list_events reports for `hour`:00 on `ymd` in `shape`'s clock. */
  function at(shape: Shape, ymd: string, hour: number): string {
    return shape.name === "UTC" ? `${ymd}T${String(hour).padStart(2, "0")}:00:00.000Z` : berlinUtc(ymd, hour);
  }

  /**
   * Six Thursdays from 2026-10-01, 09:00–10:00 "A" on `shape`'s clock; from
   * 2026-10-15 on, a THISANDFUTURE override makes them 11:00–12:00 "B".
   * `extra` are further override VEVENTs, as their lines.
   */
  function ranged(shape: Shape, count = 6, extra: string[][] = []): string {
    return series(shape, "20261001", `FREQ=WEEKLY;COUNT=${count}`, [], [
      [
        shape.line("RECURRENCE-ID;RANGE=THISANDFUTURE", "20261015", "0900"),
        shape.line("DTSTART", "20261015", "1100"),
        shape.line("DTEND", "20261015", "1200"),
        "SUMMARY:B",
        "SEQUENCE:5",
      ],
      ...extra,
    ]).replace("SUMMARY:Weekly", "SUMMARY:A");
  }

  interface Row {
    recurrenceId: string | null;
    start: string;
    end: string;
    summary: string | null;
    location: string | null;
  }

  /** Every occurrence list_events lists, with what a one-occurrence write may change. */
  function rows(text: string): Row[] {
    const { instances, skipped } = expandObject(
      text,
      { start: Date.parse("2026-09-01T00:00:00Z"), end: Date.parse("2027-12-31T00:00:00Z") },
      { url: "u", etag: null }
    );
    assert.equal(skipped, undefined, `the object could not be listed: ${skipped}`);
    return instances.map(({ recurrenceId, start, end, summary, location }) => ({ recurrenceId, start, end, summary, location }));
  }

  /** `before` with the row for `rid` replaced by `change` applied to it, or removed for null. */
  function onlyChanged(before: Row[], rid: string, change: Partial<Row> | null): Row[] {
    assert.ok(before.some((r) => r.recurrenceId === rid), `no occurrence ${rid} before the write`);
    return before.flatMap((r) => (r.recurrenceId !== rid ? [r] : change === null ? [] : [{ ...r, ...change }]));
  }

  for (const shape of [SHAPES[2], SHAPES[0], SHAPES[1]]) {
    describe(shape.name, () => {
      it("the fixture lists as intended: A at 09:00 before 2026-10-15, B at 11:00 from then on", () => {
        assert.deepEqual(
          rows(ranged(shape)).map((r) => [r.start, r.summary]),
          [
            [at(shape, "2026-10-01", 9), "A"],
            [at(shape, "2026-10-08", 9), "A"],
            [at(shape, "2026-10-15", 11), "B"],
            [at(shape, "2026-10-22", 11), "B"],
            [at(shape, "2026-10-29", 11), "B"],
            [at(shape, "2026-11-05", 11), "B"],
          ]
        );
      });

      it("(a) a new override for an occurrence the range governs is made from the occurrence as listed — B at 11:00 — and never copies RANGE", () => {
        const text = ranged(shape);
        const rid = shape.reported("2026-10-29");
        const out = updateOne(text, rid, { location: "Room 7" });
        assert.deepEqual(rows(out), onlyChanged(rows(text), rid, { location: "Room 7" }));
        const override = block(out, shape.line("RECURRENCE-ID", "20261029", "0900"));
        assert.doesNotMatch(override, /RANGE=/);
      });

      it("(b) deleting the occurrence the range starts at takes out that one occurrence; the later ones stay B at 11:00", () => {
        const text = ranged(shape);
        const rid = shape.reported("2026-10-15");
        assert.deepEqual(rows(deleteOne(text, rid)), onlyChanged(rows(text), rid, null));
      });

      it("(b) deleting an occurrence the range governs takes out that one occurrence", () => {
        const text = ranged(shape);
        const rid = shape.reported("2026-10-29");
        assert.deepEqual(rows(deleteOne(text, rid)), onlyChanged(rows(text), rid, null));
      });

      it("(c) moving the occurrence the range starts at moves that one occurrence; the later ones stay at 11:00", () => {
        const text = ranged(shape);
        const rid = shape.reported("2026-10-15");
        const found = occurrence(text, rid);
        const edit = applyOccurrencePatch(parseCalendar(text), UID, found, { start: "2026-10-15T13:00:00" }, CHANGED, NOW);
        assert.deepEqual(
          rows(edit.ics),
          onlyChanged(rows(text), rid, { start: at(shape, "2026-10-15", 13), end: at(shape, "2026-10-15", 14) })
        );
        // The read-back after the write knows it by the override it made.
        assert.ok(edit.mark !== null && writtenBy(edit.ics, edit.mark));
      });

      it("a text change of the occurrence the range starts at changes that one occurrence only", () => {
        const text = ranged(shape);
        const rid = shape.reported("2026-10-15");
        assert.deepEqual(rows(updateOne(text, rid, { location: "Room 7" })), onlyChanged(rows(text), rid, { location: "Room 7" }));
      });

      it("the range's own occurrence, when it is the series' last, is changed like any override", () => {
        const text = ranged(shape, 3);
        const rid = shape.reported("2026-10-15");
        assert.deepEqual(rows(updateOne(text, rid, { summary: "C" })), onlyChanged(rows(text), rid, { summary: "C" }));
        assert.deepEqual(rows(deleteOne(text, rid)), onlyChanged(rows(text), rid, null));
      });

      it("refuses to change or delete the range's own occurrence alone when the next one has an override of its own, and says how to do it instead", () => {
        const text = ranged(shape, 6, [
          [shape.line("RECURRENCE-ID", "20261022", "0900"), shape.line("DTSTART", "20261022", "1400"), shape.line("DTEND", "20261022", "1500"), "SUMMARY:Own"],
        ]);
        const rid = shape.reported("2026-10-15");
        assert.throws(
          () => updateOne(text, rid, { start: "2026-10-15T13:00:00" }),
          (err: unknown) => err instanceof ToolRefusal && /THISANDFUTURE/.test(err.message) && /calendar app/.test(err.message) && err.message.endsWith(CHANGED)
        );
        assert.throws(
          () => deleteOne(text, rid),
          (err: unknown) => err instanceof ToolRefusal && /THISANDFUTURE/.test(err.message) && err.message.endsWith(DELETED)
        );
      });
    });
  }
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

// ---------------------------------------------------------------------------
// A series' time (#207, spec §2.4)
// ---------------------------------------------------------------------------

/**
 * A series of `shape` starting 09:00–10:00 on `startYmd` (compact), with
 * `rrule`, extra master lines, and override VEVENTs given as their lines.
 * Every property an edit must keep is on the master.
 */
function series(shape: Shape, startYmd: string, rrule: string, extra: string[] = [], overrides: string[][] = []): string {
  return ics(
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Other Client//EN",
    ...(shape.vtimezone ? BERLIN_VTIMEZONE : []),
    "BEGIN:VEVENT",
    `UID:${UID}`,
    "DTSTAMP:20260901T080000Z",
    shape.line("DTSTART", startYmd, "0900"),
    shape.allDay ? shape.line("DTEND", dayAfter(startYmd), "") : shape.line("DTEND", startYmd, "1000"),
    `RRULE:${rrule}`,
    ...extra,
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
    ...overrides.flatMap((lines) => ["BEGIN:VEVENT", `UID:${UID}`, "DTSTAMP:20260901T080000Z", ...lines, "END:VEVENT"]),
    "END:VCALENDAR"
  );
}

/** {@link shiftSeries} on `text`, the times described for the occurrence `anchor` names, or for the first. */
function shifted(text: string, patch: EventPatch, anchor: string | null = null): string {
  const found = anchor === null ? null : occurrence(text, anchor);
  return shiftSeries(parseCalendar(text), UID, found, patch, CHANGED, NOW).ics;
}

/** Every occurrence's start as `list_events` reports it, within `from`–`to`. */
function starts(text: string, from = "2026-09-01T00:00:00Z", to = "2027-12-31T00:00:00Z"): string[] {
  const { instances, skipped } = expandObject(text, { start: Date.parse(from), end: Date.parse(to) }, { url: "u", etag: null });
  assert.equal(skipped, undefined, `the object could not be listed: ${skipped}`);
  return instances.map((e) => e.start);
}

/** Minutes between a reported start and end, a floating clock time read as UTC. */
function minutes(start: string, end: string): number {
  const at = (t: string): number => Date.parse(t.length === 19 ? `${t}Z` : t);
  return (at(end) - at(start)) / 60_000;
}

/** The Berlin clock time (HH:MM) of a reported instant. */
function berlinClock(reported: string): string {
  const w = instantToZonedWall(Date.parse(reported), "Europe/Berlin");
  return `${String(w.hour).padStart(2, "0")}:${String(w.minute).padStart(2, "0")}`;
}

function refusedWith(call: () => unknown, pattern: RegExp): void {
  assert.throws(call, (err: unknown) => err instanceof ToolRefusal && pattern.test(err.message) && err.message.endsWith(CHANGED));
}

const BERLIN_SHAPES = SHAPES.filter((s) => s.name.startsWith("TZID"));
const TIMED_SHAPES = SHAPES.filter((s) => !s.allDay);

describe("shiftSeries — a new clock time for every occurrence, each keeping its date (#207, spec §2.4)", () => {
  for (const shape of BERLIN_SHAPES) {
    it(`${shape.name}: a weekly 09:00 across 2026-10-25 moved to 15:00 is 15:00 local every time, never 14:00 or 16:00, and its EXDATE still takes out the same Thursday (Review Focus 1; the orphan case, 2 stays 2)`, () => {
      const text = series(shape, "20261015", "FREQ=WEEKLY;COUNT=3", [shape.line("EXDATE", "20261022", "0900")]);
      assert.deepEqual(starts(text), ["2026-10-15T07:00:00.000Z", "2026-10-29T08:00:00.000Z"]);
      const out = shifted(text, { start: "2026-10-15T15:00:00+02:00" });
      assert.deepEqual(starts(out), ["2026-10-15T13:00:00.000Z", "2026-10-29T14:00:00.000Z"]);
      assert.deepEqual(starts(out).map(berlinClock), ["15:00", "15:00"]);
      assert.match(unfold(out), /\r\nEXDATE;TZID=Europe\/Berlin:20261022T150000\r\n/);
      assert.match(unfold(out), /\r\nDTSTART;TZID=Europe\/Berlin:20261015T150000\r\n/);
      assert.match(unfold(out), /\r\nDTEND;TZID=Europe\/Berlin:20261015T160000\r\n/);
    });

    it(`${shape.name}: the same move described by an occurrence after the DST change, with its own offset, gives the same series`, () => {
      const text = series(shape, "20261015", "FREQ=WEEKLY;COUNT=3", [shape.line("EXDATE", "20261022", "0900")]);
      const out = shifted(text, { start: "2026-10-29T15:00:00+01:00" }, "2026-10-29T08:00:00.000Z");
      assert.deepEqual(starts(out).map(berlinClock), ["15:00", "15:00"]);
    });
  }

  for (const shape of TIMED_SHAPES) {
    it(`${shape.name}: an UNTIL equal to the last start, moved later, keeps the last occurrence (the UNTIL case, 4 stays 4)`, () => {
      const until = shape.name === "UTC" ? "20261105T090000Z" : shape.name === "floating" ? "20261105T090000" : "20261105T080000Z";
      const text = series(shape, "20261015", `FREQ=WEEKLY;UNTIL=${until}`);
      assert.equal(starts(text).length, 4);
      const out = shifted(text, { start: "2026-10-15T15:00:00" });
      assert.equal(starts(out).length, 4, unfold(out));
    });

    it(`${shape.name}: an RDATE is shifted with the series, so it keeps naming its occurrence`, () => {
      const text = series(shape, "20261015", "FREQ=WEEKLY;COUNT=2", [shape.line("RDATE", "20261103", "0900")]);
      const out = shifted(text, { start: "2026-10-15T15:00:00" });
      assert.match(unfold(out), new RegExp(`\\r\\n${escape(shape.line("RDATE", "20261103", "1500"))}\\r\\n`));
      assert.equal(starts(out).length, 3);
    });

    it(`${shape.name}: an override that changed only its summary moves with the series; one with its own time keeps it; both RECURRENCE-IDs are shifted`, () => {
      const text = series(shape, "20261001", "FREQ=WEEKLY;COUNT=4", [], [
        [shape.line("RECURRENCE-ID", "20261008", "0900"), shape.line("DTSTART", "20261008", "0900"), shape.line("DTEND", "20261008", "1000"), "SUMMARY:Text only"],
        [shape.line("RECURRENCE-ID", "20261015", "0900"), shape.line("DTSTART", "20261015", "1100"), shape.line("DTEND", "20261015", "1200"), "SUMMARY:Rescheduled"],
      ]);
      const out = unfold(shifted(text, { start: "2026-10-01T15:00:00" }));
      const textOnly = block(out, shape.line("RECURRENCE-ID", "20261008", "1500"));
      assert.match(textOnly, new RegExp(`\\r\\n${escape(shape.line("DTSTART", "20261008", "1500"))}\\r\\n`));
      assert.match(textOnly, new RegExp(`\\r\\n${escape(shape.line("DTEND", "20261008", "1600"))}\\r\\n`));
      const rescheduled = block(out, shape.line("RECURRENCE-ID", "20261015", "1500"));
      assert.match(rescheduled, new RegExp(`\\r\\n${escape(shape.line("DTSTART", "20261015", "1100"))}\\r\\n`));
      // Each is still matched to its occurrence: four instances, none doubled.
      assert.equal(starts(out).length, 4);
    });

    it(`${shape.name}: end alone changes the length of every occurrence`, () => {
      const text = series(shape, "20261015", "FREQ=WEEKLY;COUNT=3");
      const out = shifted(text, { end: "2026-10-15T10:30:00" });
      const { instances } = expandObject(out, { start: Date.parse("2026-09-01T00:00:00Z"), end: Date.parse("2027-01-01T00:00:00Z") }, { url: "u", etag: null });
      assert.deepEqual(instances.map((e) => minutes(e.start, e.end)), [90, 90, 90]);
    });
  }

  it("a new length reaches an override whose DTSTART is stored in another zone than the series' — read in its own zone, not the series' (fix-pass review of PR #229)", () => {
    // A Berlin 09:00–10:00 series; another client stored the second Thursday's
    // text-only override in UTC. 07:00Z is 09:00 Berlin: it still sits at its
    // occurrence, so it moves and lengthens with the series.
    const text = series(SHAPES[0], "20261001", "FREQ=WEEKLY;COUNT=3", [], [
      ["RECURRENCE-ID;TZID=Europe/Berlin:20261008T090000", "DTSTART:20261008T070000Z", "DTEND:20261008T080000Z", "SUMMARY:Text only, in UTC"],
    ]);
    const out = shifted(text, { start: "2026-10-01T15:00:00", end: "2026-10-01T16:30:00" });
    const { instances } = expandObject(out, { start: Date.parse("2026-09-01T00:00:00Z"), end: Date.parse("2027-01-01T00:00:00Z") }, { url: "u", etag: null });
    assert.deepEqual(
      instances.map((e) => [berlinClock(e.start), minutes(e.start, e.end)]),
      [["15:00", 90], ["15:00", 90], ["15:00", 90]]
    );
  });

  it("leaves a DATE UNTIL and a COUNT exactly as they were", () => {
    for (const rrule of ["FREQ=WEEKLY;UNTIL=20261105", "FREQ=WEEKLY;COUNT=4"]) {
      const out = unfold(shifted(series(SHAPES[0], "20261015", rrule), { start: "2026-10-15T15:00:00" }));
      assert.ok(out.includes(`\r\nRRULE:${rrule}\r\n`), `${rrule} became ${/\r\nRRULE:[^\r]*/.exec(out)?.[0]}`);
    }
  });

  it("keeps everything else the series holds: its VALARM, ATTENDEE parameters, X- properties, VTIMEZONE and other overrides", () => {
    const text = weekly(SHAPES[0]);
    const out = unfold(shifted(text, { start: "2026-10-01T10:00:00", summary: "Weekly later" }));
    const master = block(out, null);
    assert.match(master, /\r\nSUMMARY:Weekly later\r\n/);
    assert.match(master, /BEGIN:VALARM\r\nACTION:DISPLAY\r\nTRIGGER:-PT15M/);
    assert.match(master, /ATTENDEE;CN=Ben;PARTSTAT=ACCEPTED;ROLE=REQ-PARTICIPANT:mailto:ben@example.com/);
    assert.match(master, /\r\nX-KEEP-ME:yes\r\n/);
    assert.match(master, /\r\nSEQUENCE:4\r\n/);
    assert.deepEqual(vtimezones(out), vtimezones(text));
    assert.match(block(out, "RECURRENCE-ID;TZID=Europe/Berlin:20261015T100000"), /\r\nSUMMARY:Weekly \(moved\)\r\n/);
  });

  it("measures the change against the occurrence recurrence_id names: the third Thursday to 15:00 moves every Thursday to 15:00", () => {
    const text = weekly(SHAPES[2]);
    const out = unfold(shifted(text, { start: "2026-10-15T15:00:00Z" }, "2026-10-15T09:00:00.000Z"));
    assert.match(out, /\r\nDTSTART:20261001T150000Z\r\n/);
    assert.match(out, /\r\nRECURRENCE-ID:20261015T150000Z\r\n/);
    // Without it, the same start describes the first Thursday, and is on another day.
    refusedWith(() => shifted(text, { start: "2026-10-15T15:00:00Z" }), /day of a series cannot be changed/);
  });

  it("an all-day series takes a new length in days, and no new day", () => {
    const text = series(SHAPES[3], "20261015", "FREQ=WEEKLY;COUNT=3");
    const out = unfold(shifted(text, { end: "2026-10-17" }));
    assert.match(out, /\r\nDTSTART;VALUE=DATE:20261015\r\n/);
    assert.match(out, /\r\nDTEND;VALUE=DATE:20261017\r\n/);
    refusedWith(() => shifted(text, { start: "2026-10-16" }), /day of a series cannot be changed/);
  });
});

describe("shiftSeries — what it refuses, each with its own reason", () => {
  const berlin = SHAPES[0];

  it("a new date: Thursday to Friday", () => {
    refusedWith(() => shifted(series(berlin, "20261015", "FREQ=WEEKLY;COUNT=3"), { start: "2026-10-16T15:00:00" }), /day of a series cannot be changed; only its time/);
  });

  it("FREQ=HOURLY, whose times live in the rule", () => {
    refusedWith(() => shifted(series(berlin, "20261015", "FREQ=HOURLY;COUNT=3"), { start: "2026-10-15T15:00:00" }), /FREQ=HOURLY/);
  });

  it("BYHOUR=9, whose times live in the rule", () => {
    refusedWith(() => shifted(series(berlin, "20261015", "FREQ=WEEKLY;BYHOUR=9;COUNT=3"), { start: "2026-10-15T15:00:00" }), /BYHOUR/);
  });

  it("switching a series between all-day and timed", () => {
    refusedWith(
      () => shifted(series(berlin, "20261015", "FREQ=WEEKLY;COUNT=3"), { allDay: true, start: "2026-10-15", end: "2026-10-16" }),
      /all-day/
    );
  });

  it("an end at or before the start", () => {
    refusedWith(() => shifted(series(berlin, "20261015", "FREQ=WEEKLY;COUNT=3"), { end: "2026-10-15T08:00:00" }), /at or before it starts/);
  });

  it("an offset for a floating series", () => {
    assert.throws(
      () => shifted(series(SHAPES[4], "20261015", "FREQ=WEEKLY;COUNT=3"), { start: "2026-10-15T15:00:00+02:00" }),
      (err: unknown) => err instanceof ToolRefusal && /floating/.test(err.message)
    );
  });
});

describe("shiftSeries — a VTIMEZONE this connector generated still covers the series it moves", () => {
  /** An event create_event wrote on 2026-12-03 in Berlin, made a weekly series since by another client. */
  function createdSeries(rrule: string): string {
    const text = buildIcs(
      { uid: UID, summary: "Created here", start: "2026-12-03T10:00:00+01:00", end: "2026-12-03T11:00:00+01:00" },
      "Europe/Berlin",
      "Nothing was created.",
      NOW
    );
    return text.replace("SUMMARY:Created here", `RRULE:${rrule}\r\nSUMMARY:Created here`);
  }

  it("to its UNTIL, years past the span the block was made for", () => {
    const out = shifted(createdSeries("FREQ=WEEKLY;UNTIL=20291231T235959Z"), { start: "2026-12-03T15:00:00" });
    // A Thursday in July 2029, read by the block itself: 15:00 CEST is 13:00Z.
    assert.deepEqual(starts(out, "2029-07-05T00:00:00Z", "2029-07-06T00:00:00Z"), ["2029-07-05T13:00:00.000Z"]);
  });

  it("for ten years past its last stored time when the series has no UNTIL", () => {
    const out = shifted(createdSeries("FREQ=WEEKLY"), { start: "2026-12-03T15:00:00" });
    assert.deepEqual(starts(out, "2033-07-07T00:00:00Z", "2033-07-08T00:00:00Z"), ["2033-07-07T13:00:00.000Z"]);
  });
});
