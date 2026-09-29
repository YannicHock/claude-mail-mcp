/**
 * Fixtures for the unit tests of the series writers: one occurrence changed
 * or deleted (test/unit/ical-occurrences.test.ts, src/ical-occurrence-edit.ts)
 * and a series moved (test/unit/ical-series-shift.test.ts,
 * src/ical-series-shift.ts). Split out of one test file with the modules in
 * the code-health review of PR #229.
 *
 * Every case runs against a fixture for each shape a series' DTSTART can
 * have — TZID with its VTIMEZONE, TZID without one, UTC, DATE, and floating —
 * and is checked twice: by the lines written, and by `expandObject`, the
 * reader `list_events` uses, so a write that reads back differently from what
 * it claims fails there and not on a user's calendar.
 *
 * The fixtures carry what an in-place edit must keep (VALARM, ATTENDEE with
 * its parameters, an X- property, the VTIMEZONE, another override), because
 * a test that only edits a bare VEVENT cannot tell an edit from a rebuild.
 */

import assert from "node:assert/strict";

import { expandObject, findOccurrence, type FoundOccurrence } from "../../src/ical-expand.js";
import { instantToZonedWall } from "../../src/ical-zones.js";

export const NOW = new Date("2026-09-28T12:00:00Z");
export const CHANGED = "Nothing was changed.";
export const DELETED = "Nothing was deleted.";
export const UID = "weekly@example.com";

export function ics(...lines: string[]): string {
  return `${lines.join("\r\n")}\r\n`;
}

export const BERLIN_VTIMEZONE = [
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

export type ShapeName = "TZID with VTIMEZONE" | "TZID without VTIMEZONE" | "UTC" | "DATE" | "floating";

export interface Shape {
  name: ShapeName;
  vtimezone: boolean;
  allDay: boolean;
  /** A property holding the time `hhmm` (ignored for DATE) on `ymd`, as the shape stores it. */
  line(prop: string, ymd: string, hhmm: string): string;
  /** What list_events reports as the recurrenceId of the 09:00 occurrence on `ymd` (YYYY-MM-DD). */
  reported(ymd: string): string;
}

/** Berlin is +02:00 until 2026-10-25 and +01:00 after. */
export function berlinUtc(ymd: string, hour: number): string {
  const offset = ymd < "2026-10-25" ? 2 : 1;
  return `${ymd}T${String(hour - offset).padStart(2, "0")}:00:00.000Z`;
}

export const SHAPES: Shape[] = [
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

/** The day after `ymd` (compact form, `20261008`), for an all-day DTEND. */
export function dayAfter(ymd: string): string {
  const d = new Date(`${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10).replaceAll("-", "");
}

/**
 * A weekly series of five Thursdays from 2026-10-01, 09:00–09:30 (a day long
 * for DATE), with everything an edit must keep, and one override: the third
 * Thursday, 2026-10-15, moved to 11:00 (to the Friday for DATE).
 */
export function weekly(shape: Shape, rrule = "FREQ=WEEKLY;COUNT=5", masterExtra: string[] = []): string {
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
export function unfold(text: string): string {
  return text.replaceAll("\r\n ", "");
}

/** The VEVENT blocks of an object, as serialised, unfolded. */
export function vevents(text: string): string[] {
  return [...unfold(text).matchAll(/BEGIN:VEVENT\r\n[\s\S]*?END:VEVENT\r\n/g)].map((m) => m[0]);
}

/** The VEVENT block whose RECURRENCE-ID line is `rid`, or the master for null. */
export function block(text: string, rid: string | null): string {
  const found = vevents(text).find((b) => (rid === null ? !/\r\nRECURRENCE-ID[;:]/.test(b) : b.includes(`\r\n${rid}\r\n`)));
  assert.ok(found, `no VEVENT ${rid ?? "(master)"} in:\n${text}`);
  return found;
}

export function vtimezones(text: string): string[] {
  return [...text.matchAll(/BEGIN:VTIMEZONE\r\n[\s\S]*?END:VTIMEZONE\r\n/g)].map((m) => m[0]);
}

/** What list_events would list for the object: [recurrenceId, start, summary] per instance. */
export function listed(text: string): Array<[string | null, string, string | null]> {
  const { instances, skipped } = expandObject(
    text,
    { start: Date.parse("2026-09-01T00:00:00Z"), end: Date.parse("2027-12-31T00:00:00Z") },
    { url: "https://dav.example/cal/weekly.ics", etag: null }
  );
  assert.equal(skipped, undefined, `the object could not be listed: ${skipped}`);
  return instances.map((e) => [e.recurrenceId, e.start, e.summary]);
}

/** `findOccurrence`, which must find it. */
export function occurrence(text: string, rid: string | null, uid = UID): FoundOccurrence {
  const found = findOccurrence(text, uid, rid);
  assert.ok(found.found, `not found: ${found.found ? "" : found.reason}`);
  return found;
}

/** A RegExp source for `text` taken literally. */
export function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/**
 * A series of `shape` starting 09:00–10:00 on `startYmd` (compact), with
 * `rrule`, extra master lines, and override VEVENTs given as their lines.
 * Every property an edit must keep is on the master.
 */
export function series(shape: Shape, startYmd: string, rrule: string, extra: string[] = [], overrides: string[][] = []): string {
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

/** Every occurrence's start as `list_events` reports it, within `from`–`to`. */
export function starts(text: string, from = "2026-09-01T00:00:00Z", to = "2027-12-31T00:00:00Z"): string[] {
  const { instances, skipped } = expandObject(text, { start: Date.parse(from), end: Date.parse(to) }, { url: "u", etag: null });
  assert.equal(skipped, undefined, `the object could not be listed: ${skipped}`);
  return instances.map((e) => e.start);
}

/** Minutes between a reported start and end, a floating clock time read as UTC. */
export function minutes(start: string, end: string): number {
  const at = (t: string): number => Date.parse(t.length === 19 ? `${t}Z` : t);
  return (at(end) - at(start)) / 60_000;
}

/** The Berlin clock time (HH:MM) of a reported instant. */
export function berlinClock(reported: string): string {
  const w = instantToZonedWall(Date.parse(reported), "Europe/Berlin");
  return `${String(w.hour).padStart(2, "0")}:${String(w.minute).padStart(2, "0")}`;
}
