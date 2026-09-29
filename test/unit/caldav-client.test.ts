/**
 * The parts of src/caldav-client.ts that need no CalDAV server: the object
 * `create_event` writes (spec 2026-09-29 §2.5), and the guards a write's ETag
 * goes through (§2.8, #210). What only a server can show — If-Match really
 * sent, a 412 really answered — is test/integration/caldav-calendar.test.ts.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import ICAL from "ical.js";

import { CalDavClient, requireEtag } from "../../src/caldav-client.js";
import { buildIcs, builtZoneName } from "../../src/ical-build.js";
import { utcOffsetMs } from "../../src/ical-zones.js";
import { ToolRefusal } from "../../src/tool-refusal.js";

const NOW = new Date("2026-09-28T12:00:00Z");

/** {@link buildIcs} with the refusal ending `create_event` passes. */
function built(input: Parameters<typeof buildIcs>[0], zone: string, now: Date): string {
  return buildIcs(input, zone, "Nothing was created.", now);
}

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
    const text = built(
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
    const text = built({ ...BASE, start: "2026-10-01T09:00:00", end: "2026-10-01T10:00:00" }, "Europe/Berlin", NOW);
    assert.match(text, /\r\nDTSTART;TZID=Europe\/Berlin:20261001T090000\r\n/);
    assert.match(text, /\r\nDTEND;TZID=Europe\/Berlin:20261001T100000\r\n/);
  });

  it("writes UTC, and no VTIMEZONE, when the zone is UTC — as every event was written before v0.7.4", () => {
    const text = built({ ...BASE, start: "2026-10-01T09:00:00+02:00", end: "2026-10-01T10:00:00+02:00" }, "UTC", NOW);
    assert.match(text, /\r\nDTSTART:20261001T070000Z\r\n/);
    assert.match(text, /\r\nDTEND:20261001T080000Z\r\n/);
    assert.doesNotMatch(text, /VTIMEZONE/);
  });

  it("writes an all-day event as dates, whatever the zone", () => {
    const text = built({ ...BASE, start: "2026-10-01", end: "2026-10-02", allDay: true }, "Asia/Jerusalem", NOW);
    assert.match(text, /\r\nDTSTART;VALUE=DATE:20261001\r\n/);
    assert.doesNotMatch(text, /VTIMEZONE|TZID/);
  });

  it("writes an end on the second pass through the overlap in UTC, not as a wall time before the start's (review of #224)", () => {
    // 02:45 CEST is 00:45Z and 02:15 CET is 01:15Z: half an hour, but as
    // Berlin wall times the end would come first.
    const text = built(
      { ...BASE, start: "2026-10-25T02:45:00+02:00", end: "2026-10-25T02:15:00+01:00" },
      "Europe/Berlin",
      NOW
    );
    assert.match(text, /\r\nDTSTART;TZID=Europe\/Berlin:20261025T024500\r\n/);
    assert.match(text, /\r\nDTEND:20261025T011500Z\r\n/);
  });

  it("refuses an end at or before the start, timed or all-day, and creates nothing (review of #224)", () => {
    for (const [input, zone] of [
      [{ start: "2026-10-01T10:00:00+02:00", end: "2026-10-01T09:00:00+02:00" }, "Europe/Berlin"],
      [{ start: "2026-10-01T10:00:00+02:00", end: "2026-10-01T08:00:00Z" }, "UTC"],
      [{ start: "2026-10-01", end: "2026-10-01", allDay: true }, "Europe/Berlin"],
      [{ start: "2026-10-02", end: "2026-10-01", allDay: true }, "UTC"],
    ] as const) {
      assert.throws(
        () => built({ ...BASE, ...input }, zone, NOW),
        (err: unknown) =>
          err instanceof ToolRefusal && /at or before it starts|on or before it starts/.test(err.message) && /Nothing was created/.test(err.message),
        JSON.stringify(input)
      );
    }
  });
});

describe("builtZoneName — the timezone create_event answers with, read off what it built (code-health review of PR 3)", () => {
  it("is the zone list_events will report: the IANA name, UTC, or floating for an all-day event", () => {
    const timed = { ...BASE, start: "2026-10-01T09:00:00", end: "2026-10-01T10:00:00" };
    assert.equal(builtZoneName(built(timed, "Europe/Berlin", NOW)), "Europe/Berlin");
    assert.equal(builtZoneName(built(timed, "Etc/UTC", NOW)), "UTC");
    assert.equal(builtZoneName(built({ ...BASE, start: "2026-10-01", end: "2026-10-02", allDay: true }, "Europe/Berlin", NOW)), "floating");
  });

  it("says UTC for a start on the second pass through the overlap, which is written in UTC", () => {
    const text = built({ ...BASE, start: "2026-10-25T02:30:00+01:00", end: "2026-10-25T04:00:00+01:00" }, "Europe/Berlin", NOW);
    assert.match(text, /\r\nDTSTART:20261025T013000Z\r\n/);
    assert.equal(builtZoneName(text), "UTC");
  });
});

describe("requireEtag — ETags the server hands out oddly (spec §2.8, #210)", () => {
  const target = { calendarUrl: "https://dav.example/cal/", uid: "e@x" };

  it("#210.2: a value passed without its quotes is sent in the stored form", () => {
    assert.equal(requireEtag({ ...target, etag: "abc" }, { etag: '"abc"' }), '"abc"');
  });

  it("#210.3: a weak stored ETag that matches is a match, and the write goes with no If-Match", () => {
    for (const passed of ['"abc"', 'W/"abc"', "abc"]) {
      assert.equal(requireEtag({ ...target, etag: passed }, { etag: 'W/"abc"' }), undefined, passed);
    }
  });

  it("#210.3: a weak stored ETag that does not match is refused as a change made since, before any write", () => {
    assert.throws(
      () => requireEtag({ ...target, etag: 'W/"old"' }, { etag: 'W/"new"' }, "Nothing was changed."),
      (err: unknown) =>
        err instanceof ToolRefusal &&
        /changed after you read it/.test(err.message) &&
        /Nothing was changed/.test(err.message)
    );
  });

  it("a strong value that does not match is sent as it is, for the server to refuse", () => {
    assert.equal(requireEtag({ ...target, etag: '"old"' }, { etag: '"new"' }), '"old"');
  });
});

describe("CalDavClient — a failed ETag read-back (#210.4)", () => {
  it("logs exactly one info line with the account and the reason, and no credential", async () => {
    const lines: Array<{ level: string; message: string; extra?: Record<string, unknown> }> = [];
    const client = new CalDavClient(
      { url: "https://dav.example/", user: "alice", pass: "s3cret-app-password" },
      { accountId: "work", log: (level, message, extra) => lines.push({ level, message, extra }) }
    );
    // The lookup the read-back runs, failing the way a flaky server does —
    // with the credentials on the error object, as connection errors carry them.
    const internals = client as unknown as {
      findStoredEvent: () => Promise<never>;
      etagAfterWrite: (calendar: unknown, uid: string, url: string, sequence: number | null) => Promise<string | null>;
    };
    internals.findStoredEvent = async () => {
      throw Object.assign(new Error("socket hang up"), { options: { user: "alice", pass: "s3cret-app-password" } });
    };
    const etag = await internals.etagAfterWrite({ url: "https://dav.example/cal/" }, "e@x", "https://dav.example/cal/e.ics", 3);
    assert.equal(etag, null);
    assert.equal(lines.length, 1, JSON.stringify(lines));
    assert.equal(lines[0].level, "info");
    assert.equal(lines[0].extra?.account, "work");
    assert.match(String(lines[0].extra?.reason), /socket hang up/);
    assert.doesNotMatch(JSON.stringify(lines), /s3cret-app-password/);
  });
});

describe("CalDavClient — recurrence_id together with apply_to_series (spec 2026-09-29 §2.3, §2.4)", () => {
  // Port 1 on loopback refuses every connection: a call that reached the
  // server would fail with a connection error, not a refusal.
  const client = new CalDavClient({ url: "http://127.0.0.1:1/", user: "alice", pass: "pw" });
  const target = {
    calendarUrl: "http://127.0.0.1:1/cal/",
    uid: "weekly@example.com",
    etag: '"e"',
    recurrenceId: "2026-10-08T07:00:00.000Z",
    applyToSeries: true,
  };

  it("refuses a delete as contradictory, before the server is contacted", async () => {
    await assert.rejects(
      client.deleteEvent(target),
      (err: unknown) =>
        err instanceof ToolRefusal &&
        /contradict/.test(err.message) &&
        /recurrence_id/.test(err.message) &&
        err.message.endsWith("Nothing was deleted.")
    );
  });

  it("refuses a change that touches no time as contradictory: recurrence_id only anchors a series' new time", async () => {
    await assert.rejects(
      client.updateEvent({ ...target, summary: "Renamed" }),
      (err: unknown) =>
        err instanceof ToolRefusal &&
        /contradict/.test(err.message) &&
        /start or end/.test(err.message) &&
        /Nothing was changed/.test(err.message)
    );
  });
});

describe("CalDavClient.moveEvent — what is refused before the server is contacted (#212, spec 2026-09-29 §2.6)", () => {
  // Port 1 on loopback refuses every connection: a call that reached the
  // server would fail with a connection error, not a refusal.
  const client = new CalDavClient({ url: "http://127.0.0.1:1/", user: "alice", pass: "pw" });
  const move = {
    calendarUrl: "http://127.0.0.1:1/alice/cal/",
    targetCalendarUrl: "http://127.0.0.1:1/alice/work/",
    uid: "weekly@example.com",
    etag: '"e"',
  };

  it("refuses any recurrence_id: one occurrence cannot live in another calendar", async () => {
    for (const applyToSeries of [undefined, true]) {
      await assert.rejects(
        client.moveEvent({ ...move, recurrenceId: "2026-10-08T07:00:00.000Z", applyToSeries }),
        (err: unknown) =>
          err instanceof ToolRefusal &&
          /one occurrence/i.test(err.message) &&
          /apply_to_series/.test(err.message) &&
          err.message.endsWith("Nothing was moved.")
      );
    }
  });

  it("refuses the same calendar as source and target as nothing to do, with or without its trailing slash", async () => {
    for (const targetCalendarUrl of [move.calendarUrl, move.calendarUrl.replace(/\/$/, "")]) {
      await assert.rejects(
        client.moveEvent({ ...move, targetCalendarUrl }),
        (err: unknown) =>
          err instanceof ToolRefusal && /already in that calendar/.test(err.message) && err.message.endsWith("Nothing was moved.")
      );
    }
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
