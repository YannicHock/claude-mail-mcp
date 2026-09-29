/**
 * src/free-slots.ts — busy time in, free slots out (#213, R14, spec
 * 2026-09-29 §2.7). Pure arithmetic over epoch milliseconds: which events
 * count as busy is src/ical-busy.ts's question, and the CalDAV round trip is
 * test/integration/caldav-calendar.test.ts's.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { freeSlots, MAX_FREE_SLOT_RANGE_DAYS, MAX_FREE_SLOTS, workingZone, type BusyInterval } from "../../src/free-slots.js";

const at = (iso: string): number => Date.parse(iso);
const span = (start: string, end: string): BusyInterval => ({ start: at(start), end: at(end) });
const NINE_TO_FIVE = { startHour: 9, endHour: 17 };

describe("freeSlots — working hours on every day (R14)", () => {
  it("R14: an empty calendar, Monday to Wednesday, 9–17, gives three slots, one per day", () => {
    const slots = freeSlots([], span("2026-10-05T00:00:00Z", "2026-10-08T00:00:00Z"), 60, {
      workingHours: NINE_TO_FIVE,
      timezone: "UTC",
    });
    assert.deepEqual(slots, [
      { start: "2026-10-05T09:00:00Z", end: "2026-10-05T17:00:00Z" },
      { start: "2026-10-06T09:00:00Z", end: "2026-10-06T17:00:00Z" },
      { start: "2026-10-07T09:00:00Z", end: "2026-10-07T17:00:00Z" },
    ]);
  });

  it("a gap that runs over midnight is cut into each day's working hours, not clipped to the day it starts on", () => {
    const busy = [span("2026-10-05T09:00:00Z", "2026-10-05T15:00:00Z"), span("2026-10-06T11:00:00Z", "2026-10-06T12:00:00Z")];
    const slots = freeSlots(busy, span("2026-10-05T00:00:00Z", "2026-10-07T00:00:00Z"), 60, {
      workingHours: NINE_TO_FIVE,
      timezone: "UTC",
    });
    assert.deepEqual(slots, [
      { start: "2026-10-05T15:00:00Z", end: "2026-10-05T17:00:00Z" },
      { start: "2026-10-06T09:00:00Z", end: "2026-10-06T11:00:00Z" },
      { start: "2026-10-06T12:00:00Z", end: "2026-10-06T17:00:00Z" },
    ]);
  });

  it("the range's own ends clip the first and last day, and a piece shorter than the duration is left out", () => {
    const slots = freeSlots([], span("2026-10-05T16:30:00Z", "2026-10-06T10:00:00Z"), 45, {
      workingHours: NINE_TO_FIVE,
      timezone: "UTC",
    });
    assert.deepEqual(slots, [{ start: "2026-10-06T09:00:00Z", end: "2026-10-06T10:00:00Z" }]);
  });

  it("end_hour 24 runs to midnight", () => {
    const slots = freeSlots([], span("2026-10-05T00:00:00Z", "2026-10-06T00:00:00Z"), 60, {
      workingHours: { startHour: 20, endHour: 24 },
      timezone: "UTC",
    });
    assert.deepEqual(slots, [{ start: "2026-10-05T20:00:00Z", end: "2026-10-06T00:00:00Z" }]);
  });

  it("merges overlapping busy time, and ignores busy time outside the range", () => {
    const busy = [
      span("2026-10-05T07:00:00Z", "2026-10-05T08:00:00Z"),
      span("2026-10-05T10:00:00Z", "2026-10-05T11:30:00Z"),
      span("2026-10-05T11:00:00Z", "2026-10-05T12:00:00Z"),
      span("2026-10-05T19:00:00Z", "2026-10-05T20:00:00Z"),
    ];
    const slots = freeSlots(busy, span("2026-10-05T09:00:00Z", "2026-10-05T17:00:00Z"), 30, { timezone: "UTC" });
    assert.deepEqual(slots, [
      { start: "2026-10-05T09:00:00Z", end: "2026-10-05T10:00:00Z" },
      { start: "2026-10-05T12:00:00Z", end: "2026-10-05T17:00:00Z" },
    ]);
  });

  it("without working hours, the whole range is searched, midnight included", () => {
    const busy = [span("2026-10-05T12:00:00Z", "2026-10-06T08:00:00Z")];
    const slots = freeSlots(busy, span("2026-10-05T10:00:00Z", "2026-10-06T10:00:00Z"), 60, { timezone: "UTC" });
    assert.deepEqual(slots, [
      { start: "2026-10-05T10:00:00Z", end: "2026-10-05T12:00:00Z" },
      { start: "2026-10-06T08:00:00Z", end: "2026-10-06T10:00:00Z" },
    ]);
  });
});

describe("freeSlots — the review of PR #232", () => {
  it("working hours 0–24 are one window through midnight: a free 23:00–00:30 fits 90 minutes", () => {
    const busy = [span("2026-10-05T00:00:00Z", "2026-10-05T23:00:00Z"), span("2026-10-06T00:30:00Z", "2026-10-07T00:00:00Z")];
    const slots = freeSlots(busy, span("2026-10-05T00:00:00Z", "2026-10-07T00:00:00Z"), 90, {
      workingHours: { startHour: 0, endHour: 24 },
      timezone: "Europe/Berlin",
    });
    assert.deepEqual(slots, [{ start: "2026-10-06T01:00:00+02:00", end: "2026-10-06T02:30:00+02:00" }]);
  });

  it("never reports a slot that starts before range_start, when range_start has milliseconds", () => {
    const slots = freeSlots([], span("2026-10-05T09:00:00.500Z", "2026-10-05T10:00:00Z"), 30, { timezone: "UTC" });
    assert.deepEqual(slots, [{ start: "2026-10-05T09:00:01Z", end: "2026-10-05T10:00:00Z" }]);
    for (const s of slots) assert.ok(Date.parse(s.start) >= Date.parse("2026-10-05T09:00:00.500Z"), s.start);
  });

  it("stops at `limit` slots, the earliest, without walking the rest of the range", () => {
    const started = performance.now();
    const slots = freeSlots([], span("2026-01-01T00:00:00Z", "9999-01-01T00:00:00Z"), 60, {
      workingHours: NINE_TO_FIVE,
      timezone: "Europe/Berlin",
      limit: 3,
    });
    const elapsed = performance.now() - started;
    assert.equal(slots.length, 3);
    assert.equal(slots[0].start, "2026-01-01T09:00:00+01:00");
    assert.ok(elapsed < 1000, `took ${elapsed.toFixed(0)} ms`);
  });

  it("names its caps: a range of at most 366 days, at most 200 slots", () => {
    assert.equal(MAX_FREE_SLOT_RANGE_DAYS, 366);
    assert.equal(MAX_FREE_SLOTS, 200);
  });
});

describe("freeSlots — the working-hours zone, DST-correct (spec §2.7)", () => {
  it("Berlin 9–17 on 2026-10-23 (CEST) and 2026-10-26 (CET) is 07:00–15:00Z and 08:00–16:00Z, reported with +02:00 and +01:00", () => {
    const slots = freeSlots([], span("2026-10-23T00:00:00Z", "2026-10-27T00:00:00Z"), 60, {
      workingHours: NINE_TO_FIVE,
      timezone: "Europe/Berlin",
    });
    assert.deepEqual(slots, [
      { start: "2026-10-23T09:00:00+02:00", end: "2026-10-23T17:00:00+02:00" },
      { start: "2026-10-24T09:00:00+02:00", end: "2026-10-24T17:00:00+02:00" },
      // Sunday the 25th is the change to winter time, at 03:00.
      { start: "2026-10-25T09:00:00+01:00", end: "2026-10-25T17:00:00+01:00" },
      { start: "2026-10-26T09:00:00+01:00", end: "2026-10-26T17:00:00+01:00" },
    ]);
    const utc = slots.map((s) => [new Date(s.start).toISOString(), new Date(s.end).toISOString()]);
    assert.deepEqual(utc[0], ["2026-10-23T07:00:00.000Z", "2026-10-23T15:00:00.000Z"]);
    assert.deepEqual(utc[3], ["2026-10-26T08:00:00.000Z", "2026-10-26T16:00:00.000Z"]);
  });

  it("the local day, not the UTC one: Sydney's Monday 9–17 starts on Sunday in UTC", () => {
    const slots = freeSlots([], span("2026-10-04T13:00:00Z", "2026-10-05T13:00:00Z"), 60, {
      workingHours: NINE_TO_FIVE,
      timezone: "Australia/Sydney",
    });
    // Sydney is on summer time (+11:00) from 2026-10-04.
    assert.deepEqual(slots, [{ start: "2026-10-05T09:00:00+11:00", end: "2026-10-05T17:00:00+11:00" }]);
  });

  it("busy time cuts a slot where it falls in the zone's day", () => {
    const busy = [span("2026-10-26T10:00:00Z", "2026-10-26T11:00:00Z")];
    const slots = freeSlots(busy, span("2026-10-26T00:00:00Z", "2026-10-27T00:00:00Z"), 30, {
      workingHours: NINE_TO_FIVE,
      timezone: "Europe/Berlin",
    });
    assert.deepEqual(slots, [
      { start: "2026-10-26T09:00:00+01:00", end: "2026-10-26T11:00:00+01:00" },
      { start: "2026-10-26T12:00:00+01:00", end: "2026-10-26T17:00:00+01:00" },
    ]);
  });
});

describe("workingZone — the default when no timezone is given (spec §2.7)", () => {
  it("is the calendars' zone when all of them name the same one, in either form a server sends", () => {
    const vcalendar = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VTIMEZONE",
      "TZID:Europe/Berlin",
      "END:VTIMEZONE",
      "END:VCALENDAR",
    ].join("\r\n");
    assert.equal(workingZone(["Europe/Berlin"]), "Europe/Berlin");
    assert.equal(workingZone(["Europe/Berlin", vcalendar, "europe/berlin"]), "Europe/Berlin");
  });

  it("is UTC when they disagree, when one names none, and when none does", () => {
    assert.equal(workingZone(["Europe/Berlin", "America/New_York"]), "UTC");
    assert.equal(workingZone(["Europe/Berlin", ""]), "UTC");
    assert.equal(workingZone(["Europe/Berlin", null]), "UTC");
    assert.equal(workingZone(["", ""]), "UTC");
    assert.equal(workingZone([]), "UTC");
  });
});
