/**
 * A series' time (#207, spec 2026-09-29 §2.4): src/ical-series-shift.ts's
 * `shiftSeries`, which gives every occurrence a new clock time or length,
 * each keeping its date. The fixtures, and why each case runs on every shape
 * of DTSTART, are in test/helpers/ical-series-fixtures.ts.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildIcs } from "../../src/ical-build.js";
import type { EventPatch } from "../../src/ical-edit.js";
import { expandObject } from "../../src/ical-expand.js";
import { parseCalendar } from "../../src/ical-parse.js";
import { shiftSeries } from "../../src/ical-series-shift.js";
import { ToolRefusal } from "../../src/tool-refusal.js";
import {
  berlinClock,
  block,
  CHANGED,
  escape,
  minutes,
  NOW,
  occurrence,
  series,
  SHAPES,
  starts,
  UID,
  unfold,
  vtimezones,
  weekly,
} from "../helpers/ical-series-fixtures.js";


/** {@link shiftSeries} on `text`, the times described for the occurrence `anchor` names, or for the first. */
function shifted(text: string, patch: EventPatch, anchor: string | null = null): string {
  const found = anchor === null ? null : occurrence(text, anchor);
  return shiftSeries(parseCalendar(text), UID, found, patch, CHANGED, NOW).ics;
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
