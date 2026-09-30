/**
 * One occurrence of a series (#206, spec 2026-09-29 §2.3): src/ical-expand.ts's
 * `findOccurrence`, the worker operation that matches a caller's
 * `recurrence_id` against the expanded series, and the writes of
 * src/ical-occurrence-edit.ts that apply what it found. The fixtures, and why
 * each case runs on every shape of DTSTART, are in
 * test/helpers/ical-series-fixtures.ts.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { writtenBy, type EventPatch } from "../../src/ical-edit.js";
import { expandObject, findOccurrence } from "../../src/ical-expand.js";
import { applyOccurrencePatch, excludeOccurrence } from "../../src/ical-occurrence-edit.js";
import { parseCalendar } from "../../src/ical-parse.js";
import { OP_ACTIONS, WORKER_OPS } from "../../src/ical-worker-ops.js";
import { ToolRefusal } from "../../src/tool-refusal.js";
import {
  berlinUtc,
  block,
  CHANGED,
  DELETED,
  escape,
  ics,
  listed,
  NOW,
  occurrence,
  series,
  SHAPES,
  UID,
  vevents,
  vtimezones,
  weekly,
  type Shape,
} from "../helpers/ical-series-fixtures.js";

function updateOne(text: string, rid: string | null, patch: EventPatch, uid = UID): string {
  return applyOccurrencePatch(parseCalendar(text), uid, occurrence(text, rid, uid), patch, { nothingDone: CHANGED, now: NOW, own: [] }).ics;
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
 * A series of DTSTART and two RDATEs, with no RRULE (#226): ical.js's iterator
 * leaves the DTSTART instance out of such a series, so `list_events` lost it
 * and no write could name it. RFC 5545 §3.8.5.2 makes it the first instance.
 */
function rdateOnly(shape: Shape): string {
  const text = series(shape, "20261001", "NONE", [shape.line("RDATE", "20261008", "0900"), shape.line("RDATE", "20261015", "0900")]);
  return text.replace("RRULE:NONE\r\n", "");
}

describe("an RDATE series' DTSTART occurrence is one like any other (#226)", () => {
  for (const shape of SHAPES) {
    it(`${shape.name}: is listed, found by its recurrence_id, changed alone, and deleted by an EXDATE`, () => {
      const text = rdateOnly(shape);
      const first = shape.reported("2026-10-01");
      assert.deepEqual(
        listed(text).map(([r]) => r),
        [first, shape.reported("2026-10-08"), shape.reported("2026-10-15")]
      );
      const found = occurrence(text, first);
      assert.equal(found.recurrenceId, first);
      assert.equal(found.others, true);
      assert.deepEqual(found.next, { wall: occurrence(text, shape.reported("2026-10-08")).wall, overridden: false });

      const changed = updateOne(text, first, { summary: "Opening" });
      assert.deepEqual(
        listed(changed).map(([r, , summary]) => [r, summary]),
        [
          [first, "Opening"],
          [shape.reported("2026-10-08"), "Weekly"],
          [shape.reported("2026-10-15"), "Weekly"],
        ]
      );

      const deleted = deleteOne(text, first);
      assert.match(block(deleted, null), new RegExp(`\\r\\n${escape(shape.line("EXDATE", "20261001", "0900"))}\\r\\n`));
      assert.deepEqual(
        listed(deleted).map(([r]) => r),
        [shape.reported("2026-10-08"), shape.reported("2026-10-15")]
      );
    });
  }
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
        const edit = applyOccurrencePatch(parseCalendar(text), UID, found, { start: "2026-10-15T13:00:00" }, { nothingDone: CHANGED, now: NOW, own: [] });
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
