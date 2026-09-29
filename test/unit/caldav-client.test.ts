/**
 * The parts of src/caldav-client.ts that need no CalDAV server: the object
 * `create_event` writes (spec 2026-09-29 §2.5), and the guards a write's ETag
 * goes through (§2.8, #210). What only a server can show — If-Match really
 * sent, a 412 really answered — is test/integration/caldav-calendar.test.ts.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import ICAL from "ical.js";

import { CalDavClient, buildIcs } from "../../src/caldav-client.js";
import { utcOffsetMs } from "../../src/ical-zones.js";
import { ToolRefusal } from "../../src/tool-refusal.js";

const NOW = new Date("2026-09-28T12:00:00Z");

function parsed(text: string): { vcal: ICAL.Component; vevent: ICAL.Component } {
  const vcal = new ICAL.Component(ICAL.parse(text));
  const vevent = vcal.getFirstSubcomponent("vevent");
  assert.ok(vevent, "no VEVENT");
  return { vcal, vevent };
}

const BASE = { calendarUrl: "https://dav.example/cal/", summary: "Meeting", uid: "new@claude-mail-mcp" };

describe("buildIcs — the zone create_event writes (spec §2.5)", () => {
  it("writes an event in Asia/Jerusalem with a VTIMEZONE whose offsets match Intl at its start and end", () => {
    // Jerusalem moves to summer time on Friday 2026-03-27, between the two:
    // the start is at +02:00 and the end at +03:00.
    const text = buildIcs(
      { ...BASE, start: "2026-03-26T10:00:00+02:00", end: "2026-03-28T10:00:00+03:00" },
      "Asia/Jerusalem",
      NOW
    );
    assert.match(text, /\r\nDTSTART;TZID=Asia\/Jerusalem:20260326T100000\r\n/);
    assert.match(text, /\r\nDTEND;TZID=Asia\/Jerusalem:20260328T100000\r\n/);

    const { vcal, vevent } = parsed(text);
    const component = vcal.getFirstSubcomponent("vtimezone");
    assert.ok(component, "no VTIMEZONE was written");
    assert.equal(component.getFirstPropertyValue("tzid"), "Asia/Jerusalem");
    const zone = new ICAL.Timezone(component);
    for (const [name, instant] of [
      ["dtstart", "2026-03-26T08:00:00Z"],
      ["dtend", "2026-03-28T07:00:00Z"],
    ] as const) {
      const local = (vevent.getFirstPropertyValue(name) as ICAL.Time).clone();
      local.zone = zone;
      assert.equal(zone.utcOffset(local) * 1000, utcOffsetMs(Date.parse(instant), "Asia/Jerusalem"), name);
      assert.equal(local.toUnixTime() * 1000, Date.parse(instant), name);
    }
  });

  it("reads a time with no offset as clock time in the event's zone", () => {
    const text = buildIcs({ ...BASE, start: "2026-10-01T09:00:00", end: "2026-10-01T10:00:00" }, "Europe/Berlin", NOW);
    assert.match(text, /\r\nDTSTART;TZID=Europe\/Berlin:20261001T090000\r\n/);
    assert.match(text, /\r\nDTEND;TZID=Europe\/Berlin:20261001T100000\r\n/);
  });

  it("writes UTC, and no VTIMEZONE, when the zone is UTC — as every event was written before v0.7.4", () => {
    const text = buildIcs({ ...BASE, start: "2026-10-01T09:00:00+02:00", end: "2026-10-01T10:00:00+02:00" }, "UTC", NOW);
    assert.match(text, /\r\nDTSTART:20261001T070000Z\r\n/);
    assert.match(text, /\r\nDTEND:20261001T080000Z\r\n/);
    assert.doesNotMatch(text, /VTIMEZONE/);
  });

  it("writes an all-day event as dates, whatever the zone", () => {
    const text = buildIcs({ ...BASE, start: "2026-10-01", end: "2026-10-02", allDay: true }, "Asia/Jerusalem", NOW);
    assert.match(text, /\r\nDTSTART;VALUE=DATE:20261001\r\n/);
    assert.doesNotMatch(text, /VTIMEZONE|TZID/);
  });
});

describe("CalDavClient.createEvent — the timezone it is given", () => {
  it("refuses a name that is no IANA zone before it contacts the server", async () => {
    // Port 1 on loopback refuses every connection: reaching it would fail differently.
    const client = new CalDavClient({ url: "http://127.0.0.1:1/", user: "alice", pass: "pw" });
    await assert.rejects(
      client.createEvent({
        calendarUrl: "http://127.0.0.1:1/cal/",
        summary: "x",
        start: "2026-10-01T09:00:00Z",
        end: "2026-10-01T10:00:00Z",
        timezone: "W. Europe Standard Time",
      }),
      (err: unknown) =>
        err instanceof ToolRefusal &&
        /"W. Europe Standard Time" is not an IANA time zone/.test(err.message) &&
        /Nothing was created/.test(err.message)
    );
  });
});
