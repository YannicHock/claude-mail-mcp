/**
 * src/ical-busy.ts — which of a stored object's occurrences block time, as
 * epoch milliseconds (#213, spec 2026-09-29 §2.7). The worker operation
 * `find_free_slot` reads every object through, called in-process here; the
 * last case runs it through a real worker, as the connector does.
 *
 * The rules: `TRANSP:TRANSPARENT`, `STATUS:CANCELLED` and the account's own
 * `PARTSTAT=DECLINED` are free; `TENTATIVE`, `NEEDS-ACTION`, someone else's
 * `DECLINED` and everything else are busy. Each occurrence is judged by the
 * VEVENT it comes from, so an override the account declined frees that
 * occurrence alone.
 */

import { after, describe, it } from "node:test";
import assert from "node:assert/strict";

import { busyTimes } from "../../src/ical-busy.js";
import { ExpansionPool } from "../../src/ical-worker-pool.js";

function ics(...lines: string[]): string {
  return `${lines.join("\r\n")}\r\n`;
}

function event(...lines: string[]): string {
  return ics(
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Other Client//EN",
    "BEGIN:VEVENT",
    "UID:busy@example.com",
    "DTSTAMP:20260901T080000Z",
    "DTSTART:20261006T100000Z",
    "DTEND:20261006T110000Z",
    ...lines,
    "END:VEVENT",
    "END:VCALENDAR"
  );
}

const OCTOBER = { start: Date.parse("2026-10-01T00:00:00Z"), end: Date.parse("2026-11-01T00:00:00Z") };
const OWN = ["mailto:me@mail.example", "mailto:alias@mail.example"];
const TEN_TO_ELEVEN = [{ start: Date.parse("2026-10-06T10:00:00Z"), end: Date.parse("2026-10-06T11:00:00Z") }];

/** The busy intervals, as ISO strings, for reading a failure. */
function iso(result: ReturnType<typeof busyTimes>): string[][] {
  return result.busy.map((b) => [new Date(b.start).toISOString(), new Date(b.end).toISOString()]);
}

describe("busyTimes — what blocks time (#213)", () => {
  it("an ordinary event blocks its time", () => {
    const result = busyTimes(event("SUMMARY:Plain"), OCTOBER, OWN, "UTC");
    assert.deepEqual(result, { busy: TEN_TO_ELEVEN });
  });

  it("TRANSP:TRANSPARENT does not", () => {
    assert.deepEqual(busyTimes(event("TRANSP:TRANSPARENT"), OCTOBER, OWN, "UTC").busy, []);
  });

  it("STATUS:CANCELLED does not", () => {
    assert.deepEqual(busyTimes(event("STATUS:CANCELLED"), OCTOBER, OWN, "UTC").busy, []);
  });

  it("the account's own PARTSTAT=DECLINED does not, however the address is written", () => {
    const declined = event("ORGANIZER:mailto:anna@example.com", "ATTENDEE;PARTSTAT=DECLINED:MAILTO:Alias@Mail.Example");
    assert.deepEqual(busyTimes(declined, OCTOBER, OWN, "UTC").busy, []);
  });

  it("STATUS:TENTATIVE does, and so do the account's own TENTATIVE and NEEDS-ACTION", () => {
    for (const line of [
      "STATUS:TENTATIVE",
      "ATTENDEE;PARTSTAT=TENTATIVE:mailto:me@mail.example",
      "ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:me@mail.example",
      "ATTENDEE:mailto:me@mail.example",
    ]) {
      assert.deepEqual(busyTimes(event(line), OCTOBER, OWN, "UTC").busy, TEN_TO_ELEVEN, line);
    }
  });

  it("someone else's DECLINED does", () => {
    const theirs = event("ATTENDEE;PARTSTAT=DECLINED:mailto:ben@example.com", "ATTENDEE;PARTSTAT=ACCEPTED:mailto:me@mail.example");
    assert.deepEqual(busyTimes(theirs, OCTOBER, OWN, "UTC").busy, TEN_TO_ELEVEN);
  });

  it("the account declined under one of its addresses and accepted under another: busy, never free on a guess", () => {
    const both = event("ATTENDEE;PARTSTAT=DECLINED:mailto:me@mail.example", "ATTENDEE;PARTSTAT=ACCEPTED:mailto:alias@mail.example");
    assert.deepEqual(busyTimes(both, OCTOBER, OWN, "UTC").busy, TEN_TO_ELEVEN);
  });

  it("with no own address known, a DECLINED blocks time as anyone else's does", () => {
    const declined = event("ATTENDEE;PARTSTAT=DECLINED:mailto:me@mail.example");
    assert.deepEqual(busyTimes(declined, OCTOBER, [], "UTC").busy, TEN_TO_ELEVEN);
  });

  it("a series whose one occurrence the account declined frees only that occurrence", () => {
    const series = ics(
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Other Client//EN",
      "BEGIN:VEVENT",
      "UID:weekly@example.com",
      "DTSTAMP:20260901T080000Z",
      "DTSTART:20261006T100000Z",
      "DTEND:20261006T110000Z",
      "RRULE:FREQ=WEEKLY;COUNT=3",
      "ORGANIZER:mailto:anna@example.com",
      "ATTENDEE;PARTSTAT=ACCEPTED:mailto:me@mail.example",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:weekly@example.com",
      "DTSTAMP:20260901T080000Z",
      "RECURRENCE-ID:20261013T100000Z",
      "DTSTART:20261013T100000Z",
      "DTEND:20261013T110000Z",
      "ORGANIZER:mailto:anna@example.com",
      "ATTENDEE;PARTSTAT=DECLINED:mailto:me@mail.example",
      "END:VEVENT",
      "END:VCALENDAR"
    );
    assert.deepEqual(iso(busyTimes(series, OCTOBER, OWN, "UTC")), [
      ["2026-10-06T10:00:00.000Z", "2026-10-06T11:00:00.000Z"],
      ["2026-10-20T10:00:00.000Z", "2026-10-20T11:00:00.000Z"],
    ]);
  });

  it("a cancelled override frees its occurrence, and a transparent series frees them all", () => {
    const series = (masterExtra: string[], overrideExtra: string[]): string =>
      ics(
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//Other Client//EN",
        "BEGIN:VEVENT",
        "UID:weekly@example.com",
        "DTSTAMP:20260901T080000Z",
        "DTSTART:20261006T100000Z",
        "DTEND:20261006T110000Z",
        "RRULE:FREQ=WEEKLY;COUNT=2",
        ...masterExtra,
        "END:VEVENT",
        "BEGIN:VEVENT",
        "UID:weekly@example.com",
        "DTSTAMP:20260901T080000Z",
        "RECURRENCE-ID:20261013T100000Z",
        "DTSTART:20261013T100000Z",
        "DTEND:20261013T110000Z",
        ...overrideExtra,
        "END:VEVENT",
        "END:VCALENDAR"
      );
    assert.deepEqual(iso(busyTimes(series([], ["STATUS:CANCELLED"]), OCTOBER, OWN, "UTC")), [
      ["2026-10-06T10:00:00.000Z", "2026-10-06T11:00:00.000Z"],
    ]);
    assert.deepEqual(busyTimes(series(["TRANSP:TRANSPARENT"], ["TRANSP:TRANSPARENT"]), OCTOBER, OWN, "UTC").busy, []);
  });
});

describe("busyTimes — times with no zone are placed in the working-hours zone", () => {
  it("a floating event is clock time in the zone asked for", () => {
    const floating = ics(
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Other Client//EN",
      "BEGIN:VEVENT",
      "UID:floating@example.com",
      "DTSTAMP:20260901T080000Z",
      "DTSTART:20261006T090000",
      "DTEND:20261006T100000",
      "END:VEVENT",
      "END:VCALENDAR"
    );
    assert.deepEqual(iso(busyTimes(floating, OCTOBER, OWN, "Europe/Berlin")), [["2026-10-06T07:00:00.000Z", "2026-10-06T08:00:00.000Z"]]);
    assert.deepEqual(iso(busyTimes(floating, OCTOBER, OWN, "UTC")), [["2026-10-06T09:00:00.000Z", "2026-10-06T10:00:00.000Z"]]);
  });

  it("an all-day event is the whole local day", () => {
    const allDay = ics(
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Other Client//EN",
      "BEGIN:VEVENT",
      "UID:allday@example.com",
      "DTSTAMP:20260901T080000Z",
      "DTSTART;VALUE=DATE:20261006",
      "DTEND;VALUE=DATE:20261007",
      "END:VEVENT",
      "END:VCALENDAR"
    );
    assert.deepEqual(iso(busyTimes(allDay, OCTOBER, OWN, "Europe/Berlin")), [["2026-10-05T22:00:00.000Z", "2026-10-06T22:00:00.000Z"]]);
  });

  it("a zoned event keeps its own instant whatever zone is asked for", () => {
    const zoned = event().replace("DTSTART:20261006T100000Z", "DTSTART;TZID=America/New_York:20261006T060000");
    assert.deepEqual(busyTimes(zoned, OCTOBER, OWN, "Europe/Berlin").busy, TEN_TO_ELEVEN);
  });
});

describe("busyTimes — what it cannot read is said, never counted free", () => {
  it("an object ical.js cannot parse has no busy time and a reason", () => {
    const result = busyTimes("BEGIN:VCALENDAR\r\nX-FOO;BAR:val\r\nEND:VCALENDAR\r\n", OCTOBER, OWN, "UTC");
    assert.deepEqual(result.busy, []);
    assert.match(result.skipped ?? "", /could not be read/);
  });

  it("a zone nothing can place is a reason, not an event read as floating", () => {
    const unplaced = event().replace("DTSTART:20261006T100000Z", "DTSTART;TZID=Nowhere/Special:20261006T100000");
    const result = busyTimes(unplaced, OCTOBER, OWN, "UTC");
    assert.deepEqual(result.busy, []);
    assert.match(result.skipped ?? "", /Nowhere\/Special/);
  });
});

describe("busyTimes in a worker", () => {
  const pool = new ExpansionPool({});
  after(() => pool.close());

  it("crosses the worker boundary as plain numbers, the same as in-process", { timeout: 20_000 }, async () => {
    const data = event("ATTENDEE;PARTSTAT=DECLINED:mailto:ben@example.com");
    const stored = { url: "https://dav.example/cal/busy.ics", etag: '"b"', data };
    const [result] = await pool.runOnEach([stored], "busyTimes", (o) => [o.data, OCTOBER, OWN, "UTC"]);
    assert.equal(result.status, "fulfilled");
    assert.deepEqual(result.status === "fulfilled" ? result.value : null, busyTimes(data, OCTOBER, OWN, "UTC"));
  });
});
