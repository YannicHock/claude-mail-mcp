/**
 * CalDavClient against a real CalDAV server (Radicale, from
 * docker-compose.test.yml): the writes #152 and #153 add, and the status check
 * `create_event` was missing (spec 2026-09-28 §0, §4).
 *
 * What only a real server can show, and so what this file is for:
 *   - the caller's ETag really is sent as If-Match, and a stale one really
 *     comes back 412 — and nothing is written;
 *   - the UID lookup finds the event through a calendar-query, and the exact
 *     re-check beats the substring match RFC 4791 specifies;
 *   - an update preserves what another client stored, end to end, not just in
 *     the pure merge (that is test/unit/ical-edit.test.ts);
 *   - an update of a vanished event creates nothing.
 *
 * Skips cleanly without Docker, like every file here that needs a fixture.
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

import { AccountsStore } from "../../src/accounts.js";
import { CalDavClient } from "../../src/caldav-client.js";
import { ClientPool } from "../../src/client-pool.js";
import { registerCalendarTools } from "../../src/tools-calendar.js";
import { ToolRefusal } from "../../src/tool-errors.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { cleanupTmpDir, makeAccount, makeAccountsFile, makeTmpDir } from "../helpers/fixtures.js";
import { composeDown, composeUp, isDockerAvailable } from "../helpers/docker.js";
import {
  RADICALE_PASSWORD,
  RADICALE_URL,
  startCalDavProxy,
  deleteBehindTheBack,
  editBehindTheBack,
  getRawEvent,
  makeRadicaleCalendar,
  putRawEvent,
  serverExpands,
  serverFindsIn,
  waitForRadicaleReady,
  type CalDavProxy,
  type RadicaleCalendar,
} from "../helpers/radicale.js";

const DOCKER_AVAILABLE = isDockerAvailable();
const SKIP: { skip: string } | Record<string, never> = DOCKER_AVAILABLE
  ? {}
  : { skip: "Docker is not available — skipping integration tests against Radicale" };

const WINDOW = { start: "2026-09-01T00:00:00Z", end: "2026-12-31T00:00:00Z" };

function ics(...lines: string[]): string {
  return `${lines.join("\r\n")}\r\n`;
}

/** An event another client made: an alarm, an attendee, and an X- property. */
function richEvent(uid: string, summary = "Planning"): string {
  return ics(
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Other Client//EN",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    "DTSTAMP:20260901T080000Z",
    "DTSTART:20261001T090000Z",
    "DTEND:20261001T100000Z",
    `SUMMARY:${summary}`,
    "ATTENDEE;CN=Ben;PARTSTAT=ACCEPTED:mailto:ben@example.com",
    "X-KEEP-ME:yes",
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    "TRIGGER:-PT15M",
    "DESCRIPTION:Reminder",
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR"
  );
}

function seriesEvent(uid: string): string {
  return ics(
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Other Client//EN",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    "DTSTAMP:20260901T080000Z",
    "DTSTART:20261001T090000Z",
    "DTEND:20261001T093000Z",
    "RRULE:FREQ=WEEKLY;COUNT=5",
    "SUMMARY:Standup",
    "END:VEVENT",
    "END:VCALENDAR"
  );
}

/** Resolves to the refusal's message; fails the test if it resolved or threw something else. */
async function refusal(call: Promise<unknown>): Promise<string> {
  try {
    await call;
  } catch (err) {
    assert.ok(err instanceof ToolRefusal, `expected a ToolRefusal, got ${String(err)}`);
    return err.message;
  }
  assert.fail("the call was expected to be refused");
}

let cal: RadicaleCalendar;
let client: CalDavClient;

before(async () => {
  if (!DOCKER_AVAILABLE) return;
  composeUp();
  await waitForRadicaleReady();
  cal = await makeRadicaleCalendar();
  client = new CalDavClient({ url: RADICALE_URL, user: cal.user, pass: RADICALE_PASSWORD });
});

after(() => {
  if (DOCKER_AVAILABLE) composeDown();
});

async function etagOf(uid: string): Promise<string> {
  const { events } = await client.listEvents(cal.calendarUrl, WINDOW.start, WINDOW.end);
  const hit = events.find((e) => e.uid === uid);
  assert.ok(hit, `list_events does not show ${uid}`);
  assert.ok(hit.etag, `list_events gave ${uid} no etag`);
  return hit.etag;
}

describe("list_events", SKIP, () => {
  it("reports each event's etag", async () => {
    const created = await client.createEvent({
      calendarUrl: cal.calendarUrl,
      summary: "Etag check",
      start: "2026-10-02T09:00:00Z",
      end: "2026-10-02T10:00:00Z",
    });
    assert.match(await etagOf(created.uid), /^"?.+"?$/);
  });
});

/** A calendar of its own, so a shape that used to fail a whole calendar fails no other test. */
async function freshCalendar(): Promise<{ cal: RadicaleCalendar; client: CalDavClient }> {
  const own = await makeRadicaleCalendar();
  return { cal: own, client: new CalDavClient({ url: RADICALE_URL, user: own.user, pass: RADICALE_PASSWORD }) };
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

describe("list_events — the shapes the server's expansion failed on (spec 2026-09-29 §0.1)", SKIP, () => {
  it("R1: lists an all-day weekly series, each occurrence by its date, and the calendar around it", async () => {
    const { cal: own, client: mine } = await freshCalendar();
    await putRawEvent(own, "plain.ics", richEvent("r1-plain@example.com"));
    await putRawEvent(
      own,
      "allday-series.ics",
      ics(
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//Other Client//EN",
        "BEGIN:VEVENT",
        "UID:r1-allday@example.com",
        "DTSTAMP:20260901T080000Z",
        "DTSTART;VALUE=DATE:20261001",
        "DTEND;VALUE=DATE:20261002",
        "RRULE:FREQ=WEEKLY;COUNT=3",
        "SUMMARY:Bins out",
        "END:VEVENT",
        "END:VCALENDAR"
      )
    );
    const { events, skipped } = await mine.listEvents(own.calendarUrl, WINDOW.start, WINDOW.end);
    assert.deepEqual(skipped, []);
    assert.deepEqual(
      events.filter((e) => e.uid === "r1-allday@example.com").map((e) => [e.recurrenceId, e.start, e.allDay]),
      [
        ["2026-10-01", "2026-10-01", true],
        ["2026-10-08", "2026-10-08", true],
        ["2026-10-15", "2026-10-15", true],
      ]
    );
    assert.ok(events.some((e) => e.uid === "r1-plain@example.com"), "the rest of the calendar is missing");
  });

  it("R2: lists a floating weekly series as clock time with no offset", async () => {
    const { cal: own, client: mine } = await freshCalendar();
    await putRawEvent(
      own,
      "floating-series.ics",
      ics(
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//Other Client//EN",
        "BEGIN:VEVENT",
        "UID:r2-floating@example.com",
        "DTSTAMP:20260901T080000Z",
        "DTSTART:20261001T090000",
        "DTEND:20261001T100000",
        "RRULE:FREQ=WEEKLY;COUNT=2",
        "SUMMARY:Gym",
        "END:VEVENT",
        "END:VCALENDAR"
      )
    );
    const { events } = await mine.listEvents(own.calendarUrl, WINDOW.start, WINDOW.end);
    assert.deepEqual(
      events.map((e) => [e.start, e.end, e.timezone]),
      [
        ["2026-10-01T09:00:00", "2026-10-01T10:00:00", "floating"],
        ["2026-10-08T09:00:00", "2026-10-08T10:00:00", "floating"],
      ]
    );
  });

  it("R3: lists an override with no master as its one instance", async () => {
    const { cal: own, client: mine } = await freshCalendar();
    await putRawEvent(own, "override-only.ics", overrideOnly("r3-once@example.com"));
    const { events } = await mine.listEvents(own.calendarUrl, WINDOW.start, WINDOW.end);
    assert.deepEqual(
      events.map((e) => [e.uid, e.recurrenceId, e.start]),
      [["r3-once@example.com", "2026-10-08T09:00:00.000Z", "2026-10-08T10:00:00.000Z"]]
    );
  });

  it("R5, kept: a zoned series with EXDATE and an override expands as Radicale's own expansion did", async () => {
    // The values are what Radicale's <C:expand> answered for this object
    // before the expansion moved into the connector: UTC instants, the EXDATE
    // left out, the override used, and the change to CET on 2026-10-25 applied.
    const { cal: own, client: mine } = await freshCalendar();
    await putRawEvent(
      own,
      "berlin-series.ics",
      ics(
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//Other Client//EN",
        ...BERLIN_VTIMEZONE,
        "BEGIN:VEVENT",
        "UID:r5-berlin@example.com",
        "DTSTAMP:20260901T080000Z",
        "DTSTART;TZID=Europe/Berlin:20261015T090000",
        "DTEND;TZID=Europe/Berlin:20261015T100000",
        "RRULE:FREQ=WEEKLY;COUNT=4",
        "EXDATE;TZID=Europe/Berlin:20261022T090000",
        "SUMMARY:Weekly",
        "END:VEVENT",
        "BEGIN:VEVENT",
        "UID:r5-berlin@example.com",
        "DTSTAMP:20260901T080000Z",
        "RECURRENCE-ID;TZID=Europe/Berlin:20261029T090000",
        "DTSTART;TZID=Europe/Berlin:20261029T110000",
        "DTEND;TZID=Europe/Berlin:20261029T120000",
        "SUMMARY:Weekly (later)",
        "END:VEVENT",
        "END:VCALENDAR"
      )
    );
    const { events } = await mine.listEvents(own.calendarUrl, WINDOW.start, WINDOW.end);
    assert.deepEqual(
      events.map((e) => [e.recurrenceId, e.start, e.end, e.summary]),
      [
        ["2026-10-15T07:00:00.000Z", "2026-10-15T07:00:00.000Z", "2026-10-15T08:00:00.000Z", "Weekly"],
        ["2026-10-29T08:00:00.000Z", "2026-10-29T10:00:00.000Z", "2026-10-29T11:00:00.000Z", "Weekly (later)"],
        ["2026-11-05T08:00:00.000Z", "2026-11-05T08:00:00.000Z", "2026-11-05T09:00:00.000Z", "Weekly"],
      ]
    );
  });
});

/** One VEVENT with a RECURRENCE-ID and no master: an invitation to a single instance. */
function overrideOnly(uid: string): string {
  return ics(
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Other Client//EN",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    "DTSTAMP:20260901T080000Z",
    "RECURRENCE-ID:20261008T090000Z",
    "DTSTART:20261008T100000Z",
    "DTEND:20261008T110000Z",
    "SUMMARY:The one I was invited to",
    "END:VEVENT",
    "END:VCALENDAR"
  );
}

describe("lookup robustness (#211)", SKIP, () => {
  it("#211.1: lists an object whose href has no .ics, and updates it by UID", async () => {
    const { cal: own, client: mine } = await freshCalendar();
    const uid = "no-extension@example.com";
    const etag = await putRawEvent(own, "no-extension", richEvent(uid));
    const { events } = await mine.listEvents(own.calendarUrl, WINDOW.start, WINDOW.end);
    assert.deepEqual(
      events.map((e) => e.uid),
      [uid]
    );
    await mine.updateEvent({ calendarUrl: own.calendarUrl, uid, etag, summary: "Found it" });
    assert.match((await getRawEvent(own, "no-extension")) ?? "", /SUMMARY:Found it/);
  });

  it("#211.2: lists the other events past one it cannot read, and names that one in skipped", async () => {
    const own = await makeRadicaleCalendar();
    await putRawEvent(own, "a-bad.ics", richEvent("bad@example.com", "Unreadable"));
    await putRawEvent(own, "b-good.ics", richEvent("good@example.com", "Readable"));
    const proxy = await startCalDavProxy({ corruptObject: "a-bad.ics" });
    try {
      const viaProxy = new CalDavClient({ url: proxy.url, user: own.user, pass: RADICALE_PASSWORD });
      const calendarUrl = own.calendarUrl.replace(RADICALE_URL, proxy.url);
      const { events, skipped } = await viaProxy.listEvents(calendarUrl, WINDOW.start, WINDOW.end);
      assert.ok(proxy.corruptedReports() > 0, "the proxy never planted the corrupt object");
      assert.deepEqual(
        events.map((e) => e.summary),
        ["Readable"]
      );
      assert.equal(skipped.length, 1);
      assert.match(skipped[0].url, /\/a-bad\.ics$/);
      assert.match(skipped[0].reason, /could not be read/);
    } finally {
      await proxy.close();
    }
  });

  it("a recurrence rule ical.js never returns from costs only its own object, not the connector (review of #223)", { timeout: 60_000 }, async () => {
    const own = await makeRadicaleCalendar();
    await putRawEvent(own, "a-hangs.ics", richEvent("hangs@example.com", "Stand-in"));
    await putRawEvent(own, "b-good.ics", richEvent("good@example.com", "Readable"));
    // No day of ISO week 1 is in June, and impossibleRule does not know that:
    // only the worker's deadline stands between this and a frozen process.
    const hangs = ics(
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Other Client//EN",
      "BEGIN:VEVENT",
      "UID:hangs@example.com",
      "DTSTAMP:20200101T000000Z",
      "DTSTART:20200101T090000Z",
      "DURATION:PT1H",
      "RRULE:FREQ=DAILY;BYWEEKNO=1;BYMONTH=6",
      "END:VEVENT",
      "END:VCALENDAR"
    );
    const proxy = await startCalDavProxy({ corruptObject: "a-hangs.ics", corruptWith: hangs });
    try {
      const viaProxy = new CalDavClient({ url: proxy.url, user: own.user, pass: RADICALE_PASSWORD });
      const calendarUrl = own.calendarUrl.replace(RADICALE_URL, proxy.url);
      const { events, skipped } = await viaProxy.listEvents(calendarUrl, WINDOW.start, WINDOW.end);
      assert.ok(proxy.corruptedReports() > 0, "the proxy never planted the object");
      assert.deepEqual(
        events.map((e) => e.summary),
        ["Readable"]
      );
      assert.equal(skipped.length, 1);
      assert.match(skipped[0].url, /\/a-hangs\.ics$/);
      assert.match(skipped[0].reason, /did not finish expanding/);
    } finally {
      await proxy.close();
    }
  });

  it("#211.2: update_event finds the exact UID past an earlier object it cannot read", async () => {
    const own = await makeRadicaleCalendar();
    // Both match the UID query's substring text-match; the proxy puts the
    // unreadable one first.
    await putRawEvent(own, "a-bad.ics", richEvent("late@example.com-old", "Unreadable"));
    const etag = await putRawEvent(own, "z-exact.ics", richEvent("late@example.com", "Before"));
    const proxy = await startCalDavProxy({ corruptObject: "a-bad.ics" });
    try {
      const viaProxy = new CalDavClient({ url: proxy.url, user: own.user, pass: RADICALE_PASSWORD });
      const calendarUrl = own.calendarUrl.replace(RADICALE_URL, proxy.url);
      await viaProxy.updateEvent({ calendarUrl, uid: "late@example.com", etag, summary: "After" });
      assert.ok(proxy.corruptedReports() > 0, "the proxy never planted the corrupt object");
      assert.match((await getRawEvent(own, "z-exact.ics")) ?? "", /SUMMARY:After/);
    } finally {
      await proxy.close();
    }
  });

  it("#211.3: an override with no master is changed as the one occurrence it is, with or without its recurrence_id (spec §2.3)", async () => {
    const { cal: own, client: mine } = await freshCalendar();
    const uid = "invited-once@example.com";
    let etag: string | null = await putRawEvent(own, "invited-once.ics", overrideOnly(uid));
    for (const recurrenceId of [undefined, "2026-10-08T09:00:00.000Z"]) {
      const result = await mine.updateEvent({ calendarUrl: own.calendarUrl, uid, etag: etag ?? undefined, recurrenceId, summary: `Changed ${String(recurrenceId)}` });
      etag = result.etag;
      assert.match((await getRawEvent(own, "invited-once.ics")) ?? "", new RegExp(`SUMMARY:Changed ${String(recurrenceId)}`));
    }
    const { events } = await mine.listEvents(own.calendarUrl, WINDOW.start, WINDOW.end);
    assert.deepEqual(events.map((e) => [e.recurrenceId, e.summary]), [["2026-10-08T09:00:00.000Z", "Changed 2026-10-08T09:00:00.000Z"]]);

    // Its time too, but not "the series'": that series lives elsewhere.
    const series = await refusal(
      mine.updateEvent({ calendarUrl: own.calendarUrl, uid, etag: etag ?? undefined, applyToSeries: true, start: "2026-10-08T11:00:00Z" })
    );
    assert.match(series, /series whose other occurrences are not in this calendar/);
    assert.match(series, /Nothing was changed/);
  });

  it("#211.3: an override with no master is deleted whole, by its recurrence_id or with apply_to_series", async () => {
    const { cal: own, client: mine } = await freshCalendar();
    const uid = "invited-delete@example.com";
    const etag = await putRawEvent(own, "invited.ics", overrideOnly(uid));
    const deleting = await refusal(mine.deleteEvent({ calendarUrl: own.calendarUrl, uid, etag }));
    assert.match(deleting, /single occurrence of a series/);
    assert.doesNotMatch(deleting, /every occurrence/);
    assert.match(deleting, /Nothing was deleted/);
    await mine.deleteEvent({ calendarUrl: own.calendarUrl, uid, etag, recurrenceId: "2026-10-08T09:00:00.000Z" });
    assert.equal(await getRawEvent(own, "invited.ics"), null);

    const again = await putRawEvent(own, "invited.ics", overrideOnly(uid));
    await mine.deleteEvent({ calendarUrl: own.calendarUrl, uid, etag: again, applyToSeries: true });
    assert.equal(await getRawEvent(own, "invited.ics"), null);
  });
});

describe("update_event", SKIP, () => {
  it("renames an event and keeps what another client stored", async () => {
    const uid = "rich-update@example.com";
    await putRawEvent(cal, "rich-update.ics", richEvent(uid));
    const result = await client.updateEvent({
      calendarUrl: cal.calendarUrl,
      uid,
      etag: await etagOf(uid),
      summary: "Planning (renamed)",
    });
    assert.ok(result.etag, "the PUT answered with no new ETag");

    const stored = await getRawEvent(cal, "rich-update.ics");
    assert.ok(stored);
    assert.match(stored, /SUMMARY:Planning \(renamed\)/);
    assert.match(stored, /BEGIN:VALARM/);
    assert.match(stored, /PARTSTAT=ACCEPTED/);
    assert.match(stored, /X-KEEP-ME:yes/);
    assert.match(stored, /SEQUENCE:1/);
  });

  it("moves an event and keeps its length", async () => {
    const uid = "move@example.com";
    await putRawEvent(cal, "move.ics", richEvent(uid));
    await client.updateEvent({
      // Review Focus #4: a calendar URL without its trailing slash still
      // reaches the right collection.
      calendarUrl: cal.calendarUrl.replace(/\/$/, ""),
      uid,
      etag: await etagOf(uid),
      start: "2026-10-01T13:00:00Z",
    });
    const moved = (await client.listEvents(cal.calendarUrl, WINDOW.start, WINDOW.end)).events.find((e) => e.uid === uid);
    assert.equal(moved?.start, "2026-10-01T13:00:00.000Z");
    assert.equal(moved?.end, "2026-10-01T14:00:00.000Z");
  });

  it("reports a change made elsewhere since it was read, and writes nothing", async () => {
    const uid = "conflict@example.com";
    await putRawEvent(cal, "conflict.ics", richEvent(uid));
    const stale = await etagOf(uid);
    await editBehindTheBack(cal, "conflict.ics", richEvent(uid, "Changed on the phone"));

    const message = await refusal(
      client.updateEvent({ calendarUrl: cal.calendarUrl, uid, etag: stale, summary: "Claude's version" })
    );
    assert.match(message, /changed after you read it/);
    assert.match(message, /list_events/);
    assert.match((await getRawEvent(cal, "conflict.ics")) ?? "", /SUMMARY:Changed on the phone/);
  });

  it("refuses to write blind over an event that has an etag", async () => {
    const uid = "no-etag-given@example.com";
    await putRawEvent(cal, "no-etag-given.ics", richEvent(uid));
    const message = await refusal(client.updateEvent({ calendarUrl: cal.calendarUrl, uid, summary: "x" }));
    assert.match(message, /Pass the etag/);
  });

  it("reports a UID that does not exist, and creates nothing", async () => {
    const { events: before } = await client.listEvents(cal.calendarUrl, WINDOW.start, WINDOW.end);
    const message = await refusal(
      client.updateEvent({ calendarUrl: cal.calendarUrl, uid: "nobody@example.com", etag: '"x"', summary: "x" })
    );
    assert.match(message, /No event with UID "nobody@example.com"/);
    assert.match(message, /no event was created/);
    const { events: after } = await client.listEvents(cal.calendarUrl, WINDOW.start, WINDOW.end);
    assert.equal(after.length, before.length);
  });

  it("targets the exact UID, not every UID it is a substring of", async () => {
    await putRawEvent(cal, "sub-10.ics", richEvent("sub-10@example.com", "Ten"));
    const message = await refusal(
      client.updateEvent({ calendarUrl: cal.calendarUrl, uid: "sub-1", etag: '"x"', summary: "x" })
    );
    assert.match(message, /No event with UID "sub-1"/);
    assert.match((await getRawEvent(cal, "sub-10.ics")) ?? "", /SUMMARY:Ten/);
  });

  it("refuses a series without apply_to_series, and renames it with it", async () => {
    const uid = "series-update@example.com";
    await putRawEvent(cal, "series-update.ics", seriesEvent(uid));
    const etag = await etagOf(uid);

    assert.match(
      await refusal(client.updateEvent({ calendarUrl: cal.calendarUrl, uid, etag, summary: "x" })),
      /recurring series.*every occurrence/
    );
    assert.match(
      await refusal(client.updateEvent({ calendarUrl: cal.calendarUrl, uid, etag, start: "2026-10-01T10:00:00Z" })),
      /recurring series.*every occurrence/
    );
    await client.updateEvent({ calendarUrl: cal.calendarUrl, uid, etag, applyToSeries: true, summary: "Daily" });
    assert.match((await getRawEvent(cal, "series-update.ics")) ?? "", /SUMMARY:Daily[\s\S]*RRULE:FREQ=WEEKLY;COUNT=5|RRULE:FREQ=WEEKLY;COUNT=5[\s\S]*SUMMARY:Daily/);
  });

  it("refuses a recurrence_id that names no occurrence, and changes nothing", async () => {
    const uid = "series-between@example.com";
    await putRawEvent(cal, "series-between.ics", seriesEvent(uid));
    const etag = await etagOf(uid);
    const message = await refusal(
      client.updateEvent({ calendarUrl: cal.calendarUrl, uid, etag, recurrenceId: "2026-10-09T09:00:00.000Z", summary: "x" })
    );
    assert.match(message, /is not an occurrence of "series-between@example.com"/);
    assert.match(message, /Nothing was changed/);
    assert.equal(await etagOf(uid), etag, "the event was written");
  });

  it("refuses a recurrence_id on an event that does not recur", async () => {
    const uid = "single-with-rid@example.com";
    await putRawEvent(cal, "single-with-rid.ics", richEvent(uid));
    const message = await refusal(
      client.updateEvent({ calendarUrl: cal.calendarUrl, uid, etag: await etagOf(uid), recurrenceId: "2026-10-01T09:00:00.000Z", summary: "x" })
    );
    assert.match(message, /does not recur/);
    assert.match(message, /Nothing was changed/);
  });
});

/**
 * A Berlin series, 09:00–10:00 every Thursday from 2026-10-01, five times,
 * across the change to CET on 2026-10-25, with an alarm and an attendee.
 */
function berlinWeekly(uid: string, extra: string[] = []): string {
  return ics(
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Other Client//EN",
    ...BERLIN_VTIMEZONE,
    "BEGIN:VEVENT",
    `UID:${uid}`,
    "DTSTAMP:20260901T080000Z",
    "DTSTART;TZID=Europe/Berlin:20261001T090000",
    "DTEND;TZID=Europe/Berlin:20261001T100000",
    "RRULE:FREQ=WEEKLY;COUNT=5",
    ...extra,
    "SUMMARY:Weekly",
    "ATTENDEE;CN=Ben;PARTSTAT=ACCEPTED:mailto:ben@example.com",
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    "TRIGGER:-PT15M",
    "DESCRIPTION:Reminder",
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR"
  );
}

/**
 * A Berlin series at 09:00–10:00 every Thursday from 2026-10-01, UNTIL its
 * last start on 2026-10-29 (after the change to CET), with the 15th taken out
 * by an EXDATE, the 8th rescheduled to 11:00, and the 22nd changed only in
 * its summary: every shape a series' time change has to carry along (§2.4).
 */
function movableSeries(uid: string): string {
  return ics(
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Other Client//EN",
    ...BERLIN_VTIMEZONE,
    "BEGIN:VEVENT",
    `UID:${uid}`,
    "DTSTAMP:20260901T080000Z",
    "DTSTART;TZID=Europe/Berlin:20261001T090000",
    "DTEND;TZID=Europe/Berlin:20261001T100000",
    "RRULE:FREQ=WEEKLY;UNTIL=20261029T080000Z",
    "EXDATE;TZID=Europe/Berlin:20261015T090000",
    "SUMMARY:Weekly",
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    "TRIGGER:-PT15M",
    "DESCRIPTION:Reminder",
    "END:VALARM",
    "END:VEVENT",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    "DTSTAMP:20260901T080000Z",
    "RECURRENCE-ID;TZID=Europe/Berlin:20261008T090000",
    "DTSTART;TZID=Europe/Berlin:20261008T110000",
    "DTEND;TZID=Europe/Berlin:20261008T120000",
    "SUMMARY:Weekly (rescheduled)",
    "END:VEVENT",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    "DTSTAMP:20260901T080000Z",
    "RECURRENCE-ID;TZID=Europe/Berlin:20261022T090000",
    "DTSTART;TZID=Europe/Berlin:20261022T090000",
    "DTEND;TZID=Europe/Berlin:20261022T100000",
    "SUMMARY:Weekly (agenda)",
    "END:VEVENT",
    "END:VCALENDAR"
  );
}

describe("a series' time (#207)", SKIP, () => {
  it("moves a series with an EXDATE, an override and UNTIL to 15:00; list_events and Radicale's own expansion agree on every occurrence", async () => {
    const { cal: own, client: mine } = await freshCalendar();
    const uid = "movable@example.com";
    const etag = await putRawEvent(own, "movable.ics", movableSeries(uid));
    const result = await mine.updateEvent({ calendarUrl: own.calendarUrl, uid, etag, applyToSeries: true, start: "2026-10-01T15:00:00" });
    assert.ok(result.etag);

    const { events, skipped } = await mine.listEvents(own.calendarUrl, WINDOW.start, WINDOW.end);
    assert.deepEqual(skipped, []);
    assert.deepEqual(
      events.map((e) => [e.recurrenceId, e.start, e.summary]),
      [
        // 15:00 CEST; the rescheduled one keeps its 11:00; the 15th stays out;
        // the renamed one moves; the last, 15:00 CET, survives its UNTIL.
        ["2026-10-08T13:00:00.000Z", "2026-10-08T09:00:00.000Z", "Weekly (rescheduled)"],
        ["2026-10-01T13:00:00.000Z", "2026-10-01T13:00:00.000Z", "Weekly"],
        ["2026-10-22T13:00:00.000Z", "2026-10-22T13:00:00.000Z", "Weekly (agenda)"],
        ["2026-10-29T14:00:00.000Z", "2026-10-29T14:00:00.000Z", "Weekly"],
      ].sort((a, b) => String(a[1]).localeCompare(String(b[1])))
    );
    assert.deepEqual(
      await serverExpands(own, WINDOW.start, WINDOW.end),
      events.map((e) => [e.recurrenceId, e.start])
    );
    assert.match((await getRawEvent(own, "movable.ics")) ?? "", /BEGIN:VALARM/);
  });

  it("measures the change against the occurrence recurrence_id names, after the DST change as before it", async () => {
    const { cal: own, client: mine } = await freshCalendar();
    const uid = "anchored@example.com";
    const etag = await putRawEvent(own, "anchored.ics", berlinWeekly(uid));
    await mine.updateEvent({
      calendarUrl: own.calendarUrl,
      uid,
      etag,
      applyToSeries: true,
      recurrenceId: "2026-10-29T08:00:00.000Z",
      start: "2026-10-29T16:00:00+01:00",
      end: "2026-10-29T16:30:00+01:00",
    });
    const { events } = await mine.listEvents(own.calendarUrl, WINDOW.start, WINDOW.end);
    assert.deepEqual(
      events.map((e) => [e.start, e.end]),
      [
        ["2026-10-01T14:00:00.000Z", "2026-10-01T14:30:00.000Z"],
        ["2026-10-08T14:00:00.000Z", "2026-10-08T14:30:00.000Z"],
        ["2026-10-15T14:00:00.000Z", "2026-10-15T14:30:00.000Z"],
        ["2026-10-22T14:00:00.000Z", "2026-10-22T14:30:00.000Z"],
        ["2026-10-29T15:00:00.000Z", "2026-10-29T15:30:00.000Z"],
      ]
    );
    assert.deepEqual((await serverExpands(own, WINDOW.start, WINDOW.end)).map(([, s]) => s), events.map((e) => e.start));
  });

  it("refuses a new day for the series, and writes nothing", async () => {
    const { cal: own, client: mine } = await freshCalendar();
    const uid = "same-day@example.com";
    const etag = await putRawEvent(own, "same-day.ics", berlinWeekly(uid));
    const message = await refusal(
      mine.updateEvent({ calendarUrl: own.calendarUrl, uid, etag, applyToSeries: true, start: "2026-10-02T09:00:00" })
    );
    assert.match(message, /day of a series cannot be changed/);
    assert.match(message, /Nothing was changed/);
    assert.match((await getRawEvent(own, "same-day.ics")) ?? "", /DTSTART;TZID=Europe\/Berlin:20261001T090000/);
  });
});

describe("one occurrence of a series (#206)", SKIP, () => {
  it("moves one Thursday and cancels another in a Berlin weekly series; list_events shows the rest unchanged", async () => {
    const { cal: own, client: mine } = await freshCalendar();
    const uid = "one-thursday@example.com";
    await putRawEvent(own, "weekly.ics", berlinWeekly(uid));
    const before = (await mine.listEvents(own.calendarUrl, WINDOW.start, WINDOW.end)).events;
    assert.equal(before.length, 5);

    // The second Thursday, from 09:00 to 14:00 Berlin time.
    const moved = await mine.updateEvent({
      calendarUrl: own.calendarUrl,
      uid,
      etag: before[1].etag ?? undefined,
      recurrenceId: before[1].recurrenceId ?? undefined,
      start: "2026-10-08T14:00:00",
      summary: "Weekly (later)",
    });
    assert.ok(moved.etag, "the update handed back no etag");
    // The fourth, with the etag the update handed back.
    const cancelled = await mine.deleteEvent({
      calendarUrl: own.calendarUrl,
      uid,
      etag: moved.etag,
      recurrenceId: before[3].recurrenceId ?? undefined,
    });
    assert.equal(cancelled.url, moved.url);

    const after = (await mine.listEvents(own.calendarUrl, WINDOW.start, WINDOW.end)).events;
    assert.deepEqual(
      after.map((e) => [e.recurrenceId, e.start, e.end, e.summary]),
      [
        ["2026-10-01T07:00:00.000Z", "2026-10-01T07:00:00.000Z", "2026-10-01T08:00:00.000Z", "Weekly"],
        ["2026-10-08T07:00:00.000Z", "2026-10-08T12:00:00.000Z", "2026-10-08T13:00:00.000Z", "Weekly (later)"],
        ["2026-10-15T07:00:00.000Z", "2026-10-15T07:00:00.000Z", "2026-10-15T08:00:00.000Z", "Weekly"],
        ["2026-10-29T08:00:00.000Z", "2026-10-29T08:00:00.000Z", "2026-10-29T09:00:00.000Z", "Weekly"],
      ]
    );
    const stored = (await getRawEvent(own, "weekly.ics")) ?? "";
    assert.match(stored, /RECURRENCE-ID;TZID=Europe\/Berlin:20261008T090000/);
    assert.match(stored, /EXDATE;TZID=Europe\/Berlin:20261022T090000/);
    // Radicale's own reading of what was stored agrees: nothing at 07:00Z on the 22nd, the moved one at 12:00Z.
    assert.deepEqual(await serverFindsIn(own, "2026-10-22T06:00:00Z", "2026-10-22T09:00:00Z"), []);
    assert.deepEqual(await serverFindsIn(own, "2026-10-08T12:00:00Z", "2026-10-08T12:30:00Z"), ["weekly.ics"]);
  });

  it("does the same for an all-day series, whose recurrence_id is a date", async () => {
    const { cal: own, client: mine } = await freshCalendar();
    const uid = "one-day@example.com";
    const etag = await putRawEvent(
      own,
      "bins.ics",
      ics(
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//Other Client//EN",
        "BEGIN:VEVENT",
        `UID:${uid}`,
        "DTSTAMP:20260901T080000Z",
        "DTSTART;VALUE=DATE:20261001",
        "DTEND;VALUE=DATE:20261002",
        "RRULE:FREQ=WEEKLY;COUNT=4",
        "SUMMARY:Bins out",
        "END:VEVENT",
        "END:VCALENDAR"
      )
    );
    const moved = await mine.updateEvent({ calendarUrl: own.calendarUrl, uid, etag, recurrenceId: "2026-10-08", start: "2026-10-09" });
    assert.ok(moved.etag);
    await mine.deleteEvent({ calendarUrl: own.calendarUrl, uid, etag: moved.etag, recurrenceId: "2026-10-15" });
    const { events, skipped } = await mine.listEvents(own.calendarUrl, WINDOW.start, WINDOW.end);
    assert.deepEqual(skipped, []);
    assert.deepEqual(
      events.map((e) => [e.recurrenceId, e.start, e.end]),
      [
        ["2026-10-01", "2026-10-01", "2026-10-02"],
        ["2026-10-08", "2026-10-09", "2026-10-10"],
        ["2026-10-22", "2026-10-22", "2026-10-23"],
      ]
    );
    const stored = (await getRawEvent(own, "bins.ics")) ?? "";
    assert.match(stored, /RECURRENCE-ID;VALUE=DATE:20261008/);
    assert.match(stored, /EXDATE;VALUE=DATE:20261015/);
  });

  it("says so when the occurrence deleted was the series' last, and keeps the event", async () => {
    const { cal: own, client: mine } = await freshCalendar();
    const uid = "last-one@example.com";
    const etag = await putRawEvent(own, "last.ics", seriesEvent(uid).replace("COUNT=5", "COUNT=1"));
    const result = await mine.deleteEvent({ calendarUrl: own.calendarUrl, uid, etag, recurrenceId: "2026-10-01T09:00:00.000Z" });
    assert.match(result.note ?? "", /no occurrences left/);
    assert.notEqual(await getRawEvent(own, "last.ics"), null);
  });

  it("hands back the etag of an occurrence update on a server that answers the PUT without one (the read-back finds its override)", async () => {
    const own = await makeRadicaleCalendar();
    const uid = "etagless-occurrence@example.com";
    const etag = await putRawEvent(own, "weekly.ics", berlinWeekly(uid));
    const proxy = await startCalDavProxy({ etaglessPuts: true });
    try {
      const viaProxy = new CalDavClient({ url: proxy.url, user: own.user, pass: RADICALE_PASSWORD });
      const calendarUrl = own.calendarUrl.replace(RADICALE_URL, proxy.url);
      const first = await viaProxy.updateEvent({ calendarUrl, uid, etag, recurrenceId: "2026-10-08T07:00:00.000Z", summary: "One" });
      assert.equal(proxy.strippedPuts(), 1, "the proxy never took the ETag away");
      assert.ok(first.etag, "the read-back did not recognise its own override");
      await viaProxy.updateEvent({ calendarUrl, uid, etag: first.etag, recurrenceId: "2026-10-08T07:00:00.000Z", summary: "Two" });
      assert.match((await getRawEvent(own, "weekly.ics")) ?? "", /SUMMARY:Two/);
    } finally {
      await proxy.close();
    }
  });
});

/** A single Berlin event on 2026-10-22, 09:00–10:00 CEST, with or without its VTIMEZONE. */
function berlinEvent(uid: string, withVtimezone: boolean): string {
  return ics(
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Other Client//EN",
    ...(withVtimezone ? BERLIN_VTIMEZONE : []),
    "BEGIN:VEVENT",
    `UID:${uid}`,
    "DTSTAMP:20260901T080000Z",
    "DTSTART;TZID=Europe/Berlin:20261022T090000",
    "DTEND;TZID=Europe/Berlin:20261022T100000",
    "SUMMARY:Planning",
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    "TRIGGER:-PT15M",
    "DESCRIPTION:Reminder",
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR"
  );
}

describe("zones on write (#208, #209)", SKIP, () => {
  for (const withVtimezone of [true, false]) {
    it(`a Berlin event ${withVtimezone ? "with" : "without"} a VTIMEZONE, moved by update_event across the DST change, stays Berlin and expands on Radicale to the right instants`, async () => {
      const { cal: own, client: mine } = await freshCalendar();
      const uid = `berlin-move-${String(withVtimezone)}@example.com`;
      const etag = await putRawEvent(own, "berlin.ics", berlinEvent(uid, withVtimezone));
      // 09:00 on the 29th, after the clocks went back: 08:00Z, not 07:00Z.
      await mine.updateEvent({ calendarUrl: own.calendarUrl, uid, etag, start: "2026-10-29T09:00:00+01:00" });

      const stored = (await getRawEvent(own, "berlin.ics")) ?? "";
      assert.match(stored, /DTSTART;TZID=Europe\/Berlin:20261029T090000/);
      assert.match(stored, /DTEND;TZID=Europe\/Berlin:20261029T100000/);
      // Radicale normalises what it stores (R16) and gives an object with an
      // IANA TZID a VTIMEZONE of its own, so on this server both cases are
      // stored with one; that the connector adds none is the unit test's.
      assert.match(stored, /BEGIN:VTIMEZONE/);
      assert.match(stored, /BEGIN:VALARM/);

      // Radicale places it at 08:00Z itself; at CEST it would be 07:00Z.
      assert.deepEqual(await serverFindsIn(own, "2026-10-29T08:00:00Z", "2026-10-29T08:30:00Z"), ["berlin.ics"]);
      assert.deepEqual(await serverFindsIn(own, "2026-10-29T06:30:00Z", "2026-10-29T08:00:00Z"), []);
      const { events } = await mine.listEvents(own.calendarUrl, WINDOW.start, WINDOW.end);
      assert.deepEqual(
        events.map((e) => [e.start, e.end, e.timezone]),
        [["2026-10-29T08:00:00.000Z", "2026-10-29T09:00:00.000Z", "Europe/Berlin"]]
      );
    });
  }

  it("a floating event moved by update_event stays floating", async () => {
    const { cal: own, client: mine } = await freshCalendar();
    const uid = "floating-move@example.com";
    const etag = await putRawEvent(
      own,
      "floating.ics",
      berlinEvent(uid, false).replaceAll(";TZID=Europe/Berlin", "")
    );
    await mine.updateEvent({ calendarUrl: own.calendarUrl, uid, etag, start: "2026-10-29T15:00:00" });
    const stored = (await getRawEvent(own, "floating.ics")) ?? "";
    assert.match(stored, /DTSTART:20261029T150000\r?\n/);
    assert.match(stored, /DTEND:20261029T160000\r?\n/);
    const { events } = await mine.listEvents(own.calendarUrl, WINDOW.start, WINDOW.end);
    assert.deepEqual(
      events.map((e) => [e.start, e.timezone]),
      [["2026-10-29T15:00:00", "floating"]]
    );
  });

  it("create_event on a calendar with no zone of its own writes UTC, as before, and says so", async () => {
    const { cal: own, client: mine } = await freshCalendar();
    // What tsdav hands back for Radicale, which sets no calendar-timezone (R13).
    assert.deepEqual(
      (await mine.listCalendars()).map((c) => c.timezone),
      [""]
    );
    const created = await mine.createEvent({
      calendarUrl: own.calendarUrl,
      summary: "No zone",
      start: "2026-10-01T09:00:00+02:00",
      end: "2026-10-01T10:00:00+02:00",
    });
    assert.equal(created.timezone, "UTC");
    const stored = (await getRawEvent(own, `${created.uid}.ics`)) ?? "";
    assert.match(stored, /DTSTART:20261001T070000Z/);
    assert.doesNotMatch(stored, /VTIMEZONE/);
  });

  it("create_event with a timezone writes it with a VTIMEZONE Radicale reads to the right instant", async () => {
    const { cal: own, client: mine } = await freshCalendar();
    const created = await mine.createEvent({
      calendarUrl: own.calendarUrl,
      summary: "In Jerusalem",
      // Jerusalem is at +03:00 from Friday 2026-03-27: 10:00 on the 28th is 07:00Z.
      start: "2026-03-28T10:00:00",
      end: "2026-03-28T11:00:00",
      timezone: "Asia/Jerusalem",
    });
    assert.equal(created.timezone, "Asia/Jerusalem");
    const stored = (await getRawEvent(own, `${created.uid}.ics`)) ?? "";
    assert.match(stored, /DTSTART;TZID=Asia\/Jerusalem:20260328T100000/);
    assert.match(stored, /BEGIN:VTIMEZONE/);
    const file = `${created.uid}.ics`;
    assert.deepEqual(await serverFindsIn(own, "2026-03-28T07:00:00Z", "2026-03-28T07:30:00Z"), [file]);
    // At the winter +02:00 it would be 08:00–09:00Z.
    assert.deepEqual(await serverFindsIn(own, "2026-03-28T08:00:00Z", "2026-03-28T09:00:00Z"), []);
  });

  it("an event create_event wrote, moved years away and back again, stays Berlin time with a VTIMEZONE that covers it (review of #224)", async () => {
    const { cal: own, client: mine } = await freshCalendar();
    const created = await mine.createEvent({
      calendarUrl: own.calendarUrl,
      summary: "Created here",
      start: "2026-12-01T10:00:00",
      end: "2026-12-01T11:00:00",
      timezone: "Europe/Berlin",
    });
    const file = `${created.uid}.ics`;
    const listed = (await mine.listEvents(own.calendarUrl, WINDOW.start, WINDOW.end)).events.find((e) => e.uid === created.uid);
    assert.ok(listed?.etag, "list_events gave no etag for the created event");

    // Summer 2029, past the span the VTIMEZONE was generated for: 07:00Z.
    const first = await mine.updateEvent({ calendarUrl: own.calendarUrl, uid: created.uid, etag: listed.etag, start: "2029-07-02T09:00:00+02:00" });
    assert.match((await getRawEvent(own, file)) ?? "", /DTSTART;TZID=Europe\/Berlin:20290702T090000/);
    assert.deepEqual(await serverFindsIn(own, "2029-07-02T07:00:00Z", "2029-07-02T07:30:00Z"), [file]);
    assert.deepEqual(await serverFindsIn(own, "2029-07-02T05:30:00Z", "2029-07-02T07:00:00Z"), []);

    // Again, from what Radicale stored: the block is still known as this
    // connector's, so it follows the event a second time.
    assert.ok(first.etag, "the first update gave no etag");
    await mine.updateEvent({ calendarUrl: own.calendarUrl, uid: created.uid, etag: first.etag, start: "2031-07-01T09:00:00+02:00" });
    assert.match((await getRawEvent(own, file)) ?? "", /DTSTART;TZID=Europe\/Berlin:20310701T090000/);
    assert.deepEqual(await serverFindsIn(own, "2031-07-01T07:00:00Z", "2031-07-01T07:30:00Z"), [file]);
  });
});

describe("update_event on a server that answers a PUT without an ETag", SKIP, () => {
  // The v0.7.2 acceptance run on Nextcloud: update_event answered etag: null,
  // so a second change needed a list_events in between. The connector now
  // reads the new ETag back itself when the PUT did not carry one.
  it("returns the new etag anyway, and it carries a second update straight away", async () => {
    const proxy = await startCalDavProxy({ etaglessPuts: true });
    try {
      const viaProxy = new CalDavClient({ url: proxy.url, user: cal.user, pass: RADICALE_PASSWORD });
      const calendarUrl = cal.calendarUrl.replace(RADICALE_URL, proxy.url);
      const uid = "etagless@example.com";
      await putRawEvent(cal, "etagless.ics", richEvent(uid));

      const first = await viaProxy.updateEvent({ calendarUrl, uid, etag: await etagOf(uid), summary: "One" });
      assert.ok(first.etag, "update_event still answers etag: null");
      assert.equal(first.etag, await etagOf(uid), "the etag handed back is not the stored one");

      const second = await viaProxy.updateEvent({ calendarUrl, uid, etag: first.etag, summary: "Two" });
      assert.ok(second.etag);
      assert.match((await getRawEvent(cal, "etagless.ics")) ?? "", /SUMMARY:Two/);
      assert.equal(proxy.strippedPuts(), 2, "the proxy never took an ETag away, so the fallback was not exercised");
    } finally {
      await proxy.close();
    }
  });
});

describe("a change that lands between the lookup and the write (#214)", SKIP, () => {
  /** A client whose every request goes through `proxy`, for the calendar `own`. */
  function through(proxy: CalDavProxy, own: RadicaleCalendar): { client: CalDavClient; calendarUrl: string } {
    return {
      client: new CalDavClient({ url: proxy.url, user: own.user, pass: RADICALE_PASSWORD }),
      calendarUrl: own.calendarUrl.replace(RADICALE_URL, proxy.url),
    };
  }

  it("refuses a delete whose event went away after the lookup as not found (refuseLostRace's 404)", async () => {
    // Radicale answers a DELETE with If-Match on a missing object 404, and a
    // PUT with If-Match on one 412, so the 404 branch is reached by a delete.
    const own = await makeRadicaleCalendar();
    const uid = "vanishes-before-delete@example.com";
    const etag = await putRawEvent(own, "vanishes.ics", richEvent(uid));
    const proxy = await startCalDavProxy({
      before: async ({ method }) => {
        if (method === "DELETE") await deleteBehindTheBack(own, "vanishes.ics");
      },
    });
    try {
      const { client: viaProxy, calendarUrl } = through(proxy, own);
      const message = await refusal(viaProxy.deleteEvent({ calendarUrl, uid, etag }));
      assert.match(message, /No event with UID "vanishes-before-delete@example.com"/);
      assert.match(message, /Nothing was deleted/);
    } finally {
      await proxy.close();
    }
  });

  it("refuses an update whose event went away after the lookup, and creates nothing", async () => {
    const own = await makeRadicaleCalendar();
    const uid = "vanishes-before-put@example.com";
    const etag = await putRawEvent(own, "vanishes.ics", richEvent(uid));
    const proxy = await startCalDavProxy({
      before: async ({ method }) => {
        if (method === "PUT") await deleteBehindTheBack(own, "vanishes.ics");
      },
    });
    try {
      const { client: viaProxy, calendarUrl } = through(proxy, own);
      const message = await refusal(viaProxy.updateEvent({ calendarUrl, uid, etag, summary: "x" }));
      assert.match(message, /Nothing was changed, and no event was created/);
      assert.equal(await getRawEvent(own, "vanishes.ics"), null);
    } finally {
      await proxy.close();
    }
  });

  it("hands back no etag when another version landed between the PUT and the read-back", async () => {
    // The PUT answers with no ETag (Nextcloud), so the connector reads it back
    // — and by then a phone has written SEQUENCE:7 over it. That etag is the
    // phone's version; handing it back would let the next update overwrite it.
    const own = await makeRadicaleCalendar();
    const uid = "overtaken@example.com";
    const etag = await putRawEvent(own, "overtaken.ics", richEvent(uid));
    const proxy = await startCalDavProxy({
      etaglessPuts: true,
      after: async ({ method }, status) => {
        if (method === "PUT" && status < 300) {
          await editBehindTheBack(own, "overtaken.ics", richEvent(uid, "Phone").replace("SUMMARY:", "SEQUENCE:7\r\nSUMMARY:"));
        }
      },
    });
    try {
      const { client: viaProxy, calendarUrl } = through(proxy, own);
      const result = await viaProxy.updateEvent({ calendarUrl, uid, etag, summary: "Claude" });
      assert.equal(proxy.strippedPuts(), 1, "the PUT still carried an ETag, so no read-back happened");
      assert.equal(result.etag, null);
      assert.match((await getRawEvent(own, "overtaken.ics")) ?? "", /SUMMARY:Phone/);
    } finally {
      await proxy.close();
    }
  });
});

describe("ETags the server hands out oddly (#210, spec §2.8)", SKIP, () => {
  /** A client, and the calendar's URL, with every request going through `proxy`. */
  function via(proxy: CalDavProxy, own: RadicaleCalendar): { client: CalDavClient; calendarUrl: string } {
    return {
      client: new CalDavClient({ url: proxy.url, user: own.user, pass: RADICALE_PASSWORD }),
      calendarUrl: own.calendarUrl.replace(RADICALE_URL, proxy.url),
    };
  }

  /** The etag list_events hands out for `uid` through `client`, which may be null. */
  async function listedEtag(mine: CalDavClient, calendarUrl: string, uid: string): Promise<string | null> {
    const hit = (await mine.listEvents(calendarUrl, WINDOW.start, WINDOW.end)).events.find((e) => e.uid === uid);
    assert.ok(hit, `list_events does not show ${uid}`);
    return hit.etag;
  }

  const puts = (proxy: CalDavProxy) => proxy.requests().filter((r) => r.method === "PUT");

  it("weak ETags: an update with the etag list_events gave succeeds, written with no If-Match", async () => {
    const own = await makeRadicaleCalendar();
    const uid = "weak@example.com";
    await putRawEvent(own, "weak.ics", richEvent(uid));
    const proxy = await startCalDavProxy({ weakEtags: true });
    try {
      const { client: mine, calendarUrl } = via(proxy, own);
      const etag = await listedEtag(mine, calendarUrl, uid);
      assert.match(etag ?? "", /^W\//, "the proxy did not make the ETag weak");
      await mine.updateEvent({ calendarUrl, uid, etag: etag ?? undefined, summary: "Through gzip" });
      assert.match((await getRawEvent(own, "weak.ics")) ?? "", /SUMMARY:Through gzip/);
      assert.deepEqual(puts(proxy).map((r) => r.ifMatch), [null]);
    } finally {
      await proxy.close();
    }
  });

  it("weak ETags: an update with a stale one is refused before any PUT", async () => {
    const own = await makeRadicaleCalendar();
    const uid = "weak-stale@example.com";
    await putRawEvent(own, "weak-stale.ics", richEvent(uid));
    const proxy = await startCalDavProxy({ weakEtags: true });
    try {
      const { client: mine, calendarUrl } = via(proxy, own);
      const stale = await listedEtag(mine, calendarUrl, uid);
      await editBehindTheBack(own, "weak-stale.ics", richEvent(uid, "Changed on the phone"));
      const message = await refusal(mine.updateEvent({ calendarUrl, uid, etag: stale ?? undefined, summary: "x" }));
      assert.match(message, /changed after you read it/);
      assert.match(message, /Nothing was changed/);
      assert.equal(puts(proxy).length, 0, "a PUT was sent");
      assert.match((await getRawEvent(own, "weak-stale.ics")) ?? "", /SUMMARY:Changed on the phone/);
    } finally {
      await proxy.close();
    }
  });

  it("no ETags: an update of an event deleted between the lookup and the PUT is refused as not found, and creates nothing", async () => {
    const own = await makeRadicaleCalendar();
    const uid = "no-etags-gone@example.com";
    await putRawEvent(own, "gone.ics", richEvent(uid));
    let deleted = false;
    const proxy = await startCalDavProxy({
      noEtags: true,
      before: async ({ method }) => {
        if (method === "PUT" && !deleted) {
          deleted = true;
          await deleteBehindTheBack(own, "gone.ics");
        }
      },
    });
    try {
      const { client: mine, calendarUrl } = via(proxy, own);
      assert.equal(await listedEtag(mine, calendarUrl, uid), null, "the proxy let an ETag through");
      const message = await refusal(mine.updateEvent({ calendarUrl, uid, summary: "x" }));
      assert.match(message, /No event with UID "no-etags-gone@example.com"/);
      assert.match(message, /no event was created/);
      assert.equal(await getRawEvent(own, "gone.ics"), null, "the update recreated the event");
    } finally {
      await proxy.close();
    }
  });

  it("If-Match: * mishandled: an update of an existing event succeeds after the retry", async () => {
    const own = await makeRadicaleCalendar();
    const uid = "star-broken@example.com";
    await putRawEvent(own, "star.ics", richEvent(uid));
    const proxy = await startCalDavProxy({ noEtags: true, starIfMatchBroken: true });
    try {
      const { client: mine, calendarUrl } = via(proxy, own);
      await mine.updateEvent({ calendarUrl, uid, summary: "After the retry" });
      assert.equal(proxy.starRefusals(), 1, "If-Match: * was never sent, so the retry never ran");
      assert.deepEqual(puts(proxy).map((r) => r.ifMatch), ["*", null]);
      assert.match((await getRawEvent(own, "star.ics")) ?? "", /SUMMARY:After the retry/);
    } finally {
      await proxy.close();
    }
  });

  it("If-Match: * mishandled on a server that answers 201 to a replacement: the update succeeds and the event is kept (review of #224)", async () => {
    // The retry replaces an event the second lookup has just found. Read as
    // "created", the 201 made the connector delete the user's own event and
    // answer that it did not exist.
    const own = await makeRadicaleCalendar();
    const uid = "star-201@example.com";
    await putRawEvent(own, "star-201.ics", richEvent(uid));
    const proxy = await startCalDavProxy({ noEtags: true, starIfMatchBroken: true, createdOnOverwrite: true });
    try {
      const { client: mine, calendarUrl } = via(proxy, own);
      await mine.updateEvent({ calendarUrl, uid, summary: "Still here" });
      assert.equal(proxy.starRefusals(), 1, "If-Match: * was never sent, so the retry never ran");
      assert.deepEqual(proxy.requests().filter((r) => r.method === "DELETE"), [], "the update sent a DELETE");
      assert.match((await getRawEvent(own, "star-201.ics")) ?? "", /SUMMARY:Still here/);
    } finally {
      await proxy.close();
    }
  });

  it("If-Match: * mishandled, and the event gone by the retry: no 201 is taken as proof, so nothing is deleted (review of #224)", async () => {
    // The second lookup found the event, and a 201 cannot tell "created" from
    // "replaced" (above). Deleting on it would risk the user's own event to
    // undo a race of a few milliseconds, so the retry's write stands.
    const own = await makeRadicaleCalendar();
    const uid = "star-gone@example.com";
    await putRawEvent(own, "star-gone.ics", richEvent(uid));
    const proxy = await startCalDavProxy({
      noEtags: true,
      starIfMatchBroken: true,
      before: async ({ method, ifMatch }) => {
        if (method === "PUT" && ifMatch === null) await deleteBehindTheBack(own, "star-gone.ics");
      },
    });
    try {
      const { client: mine, calendarUrl } = via(proxy, own);
      await mine.updateEvent({ calendarUrl, uid, summary: "Written by the retry" });
      assert.deepEqual(proxy.requests().filter((r) => r.method === "DELETE"), [], "the update sent a DELETE");
      assert.match((await getRawEvent(own, "star-gone.ics")) ?? "", /SUMMARY:Written by the retry/);
    } finally {
      await proxy.close();
    }
  });

  it("no ETags: a delete goes with If-Match: *, and removes the event", async () => {
    const own = await makeRadicaleCalendar();
    const uid = "no-etags-delete@example.com";
    await putRawEvent(own, "delete.ics", richEvent(uid));
    const proxy = await startCalDavProxy({ noEtags: true });
    try {
      const { client: mine, calendarUrl } = via(proxy, own);
      await mine.deleteEvent({ calendarUrl, uid });
      assert.deepEqual(
        proxy.requests().filter((r) => r.method === "DELETE").map((r) => r.ifMatch),
        ["*"]
      );
      assert.equal(await getRawEvent(own, "delete.ics"), null);
    } finally {
      await proxy.close();
    }
  });
});

describe("delete_event", SKIP, () => {
  it("removes an event", async () => {
    const uid = "delete-me@example.com";
    await putRawEvent(cal, "delete-me.ics", richEvent(uid));
    await client.deleteEvent({ calendarUrl: cal.calendarUrl, uid, etag: await etagOf(uid) });
    assert.equal(await getRawEvent(cal, "delete-me.ics"), null);
  });

  it("reports a change made elsewhere, and deletes nothing", async () => {
    const uid = "delete-conflict@example.com";
    await putRawEvent(cal, "delete-conflict.ics", richEvent(uid));
    const stale = await etagOf(uid);
    await editBehindTheBack(cal, "delete-conflict.ics", richEvent(uid, "Changed on the phone"));
    assert.match(
      await refusal(client.deleteEvent({ calendarUrl: cal.calendarUrl, uid, etag: stale })),
      /changed after you read it/
    );
    assert.notEqual(await getRawEvent(cal, "delete-conflict.ics"), null);
  });

  it("reports a UID that does not exist rather than succeeding", async () => {
    assert.match(
      await refusal(client.deleteEvent({ calendarUrl: cal.calendarUrl, uid: "gone@example.com", etag: '"x"' })),
      /No event with UID "gone@example.com".*Nothing was deleted/
    );
  });

  it("refuses a series without apply_to_series, and deletes it whole with it", async () => {
    const uid = "series-delete@example.com";
    await putRawEvent(cal, "series-delete.ics", seriesEvent(uid));
    const etag = await etagOf(uid);
    assert.match(
      await refusal(client.deleteEvent({ calendarUrl: cal.calendarUrl, uid, etag })),
      /recurring series/
    );
    await client.deleteEvent({ calendarUrl: cal.calendarUrl, uid, etag, applyToSeries: true });
    assert.equal(await getRawEvent(cal, "series-delete.ics"), null);
  });

  it("refuses a recurrence_id that names no occurrence, and deletes nothing", async () => {
    const uid = "delete-between@example.com";
    await putRawEvent(cal, "delete-between.ics", seriesEvent(uid));
    const etag = await etagOf(uid);
    const message = await refusal(
      client.deleteEvent({ calendarUrl: cal.calendarUrl, uid, etag, recurrenceId: "2026-10-08T10:00:00.000Z" })
    );
    assert.match(message, /is not an occurrence/);
    assert.match(message, /Nothing was deleted/);
    assert.equal(await etagOf(uid), etag);
  });
});

describe("ORGANIZER and attendees (#204, #205, spec 2026-09-29 §2.1)", SKIP, () => {
  // Radicale has no schedule outbox (R13): it mails no one, so these show what
  // is stored, never whether anyone would be mailed. That is acceptance A1/A2,
  // on Nextcloud.
  const MAILBOX = "me@mail.example";

  /** A client for the shared calendar that knows the mailbox's address, as ClientPool builds it. */
  function withAddress(): CalDavClient {
    return new CalDavClient({ url: RADICALE_URL, user: cal.user, pass: RADICALE_PASSWORD }, { address: MAILBOX });
  }

  /** The stored object, unfolded. */
  async function storedAs(filename: string): Promise<string> {
    const text = await getRawEvent(cal, filename);
    assert.ok(text, `${filename} is not stored`);
    return text.replaceAll("\r\n ", "");
  }

  it("R13: ownAddresses on Radicale is the mailbox's defaultFrom alone, passed in by ClientPool, and asked for once", async () => {
    const dir = await makeTmpDir();
    try {
      const file = await makeAccountsFile(dir, [
        makeAccount({
          id: "work",
          default: true,
          mail: { defaultFrom: MAILBOX, draftsFolder: "Drafts", sentFolder: "Sent" },
          caldav: { url: RADICALE_URL, user: cal.user, pass: RADICALE_PASSWORD },
        }),
      ]);
      const store = new AccountsStore(file);
      await store.reload();
      const caldav = new ClientPool(store).for("work").caldav;
      assert.ok(caldav);
      const first = await caldav.ownAddresses();
      assert.deepEqual(first, [`mailto:${MAILBOX}`]);
      assert.equal(await caldav.ownAddresses(), first, "the addresses were looked up again");
    } finally {
      await cleanupTmpDir(dir);
    }
  });

  it("create_event with attendees stores ORGANIZER as the account and, with notify_attendees: false, SCHEDULE-AGENT=CLIENT on each", async () => {
    const created = await withAddress().createEvent({
      calendarUrl: cal.calendarUrl,
      summary: "Invite nobody yet",
      start: "2026-10-05T09:00:00Z",
      end: "2026-10-05T10:00:00Z",
      attendees: ["ben@example.com"],
      notifyAttendees: false,
    });
    const stored = await storedAs(created.url.slice(cal.calendarUrl.length));
    assert.match(stored, /\r\nORGANIZER:mailto:me@mail\.example\r\n/);
    assert.match(stored, /\r\nATTENDEE;SCHEDULE-AGENT=CLIENT:mailto:ben@example\.com\r\n/);
  });

  it("add and remove on an event with an attendee and no ORGANIZER: it gets one, the other attendee keeps PARTSTAT, the alarm survives", async () => {
    const uid = "attendees-add@example.com";
    await putRawEvent(cal, "attendees-add.ics", richEvent(uid));
    const client = withAddress();
    await client.updateEvent({
      calendarUrl: cal.calendarUrl,
      uid,
      etag: await etagOf(uid),
      addAttendees: ["dan@example.com"],
      notifyAttendees: false,
    });
    let stored = await storedAs("attendees-add.ics");
    assert.match(stored, /\r\nORGANIZER:mailto:me@mail\.example\r\n/);
    assert.match(stored, /\r\nATTENDEE;CN=Ben;PARTSTAT=ACCEPTED;SCHEDULE-AGENT=CLIENT:mailto:ben@example\.com\r\n/);
    assert.match(stored, /\r\nATTENDEE;SCHEDULE-AGENT=CLIENT:mailto:dan@example\.com\r\n/);
    assert.match(stored, /BEGIN:VALARM/);
    assert.match(stored, /X-KEEP-ME:yes/);

    // Removal with false is refused until acceptance A2 is in (spec §2.1),
    // even for an attendee carrying SCHEDULE-AGENT=CLIENT; nothing is written.
    const etag = await etagOf(uid);
    const message = await refusal(
      client.updateEvent({ calendarUrl: cal.calendarUrl, uid, etag, removeAttendees: ["DAN@example.com"], notifyAttendees: false })
    );
    assert.match(message, /Leave them listed/);
    assert.ok(message.endsWith("Nothing was changed, and no event was created."), message);
    assert.equal(await etagOf(uid), etag);

    const removed = await client.updateEvent({
      calendarUrl: cal.calendarUrl,
      uid,
      etag,
      removeAttendees: ["DAN@example.com"],
      notifyAttendees: true,
    });
    // Ben is marked CLIENT, and Dan was: no one left for the server to mail, and Dan was never scheduled.
    assert.deepEqual(removed.mayNotify, []);
    stored = await storedAs("attendees-add.ics");
    assert.doesNotMatch(stored, /dan@example\.com/);
    assert.match(stored, /PARTSTAT=ACCEPTED/);
  });

  it("a failed lookup of the account's addresses is not taken for 'none': the attendee call is refused with nothing written, and the next one asks again (review of PR #230)", async () => {
    // Two 503s, then Radicale's own 207. tsdav answers a 503 with the same
    // error as a principal listing no address; taken for that, the mailbox's
    // address was cached for the client's lifetime, and on Nextcloud an
    // ORGANIZER the server does not recognise makes the meeting someone else's.
    const proxy = await startCalDavProxy({ failAddressLookups: 2 });
    try {
      const viaProxy = new CalDavClient({ url: proxy.url, user: cal.user, pass: RADICALE_PASSWORD }, { address: MAILBOX });
      const calendarUrl = cal.calendarUrl.replace(RADICALE_URL, proxy.url);
      const invite = {
        calendarUrl,
        summary: "Lookup failed",
        start: "2026-10-06T09:00:00Z",
        end: "2026-10-06T10:00:00Z",
        attendees: ["ben@example.com"],
        notifyAttendees: false,
      };
      const notCreated = await refusal(viaProxy.createEvent(invite));
      assert.match(notCreated, /could not be looked up/);
      assert.ok(notCreated.endsWith("Nothing was created."), notCreated);
      assert.ok(!proxy.requests().some((r) => r.method === "PUT"), "something was written");

      // #8: the same for update_event, whose refusal ends in its own sentence.
      const uid = "attendees-lookup@example.com";
      await putRawEvent(cal, "attendees-lookup.ics", richEvent(uid));
      const etag = await etagOf(uid);
      const notChanged = await refusal(
        viaProxy.updateEvent({ calendarUrl, uid, etag, addAttendees: ["dan@example.com"], notifyAttendees: false })
      );
      assert.match(notChanged, /could not be looked up/);
      assert.ok(notChanged.endsWith("Nothing was changed, and no event was created."), notChanged);
      assert.equal(await etagOf(uid), etag);

      // The server answers now: asked again, not remembered as failed.
      const created = await viaProxy.createEvent(invite);
      const stored = await storedAs(created.url.slice(calendarUrl.length));
      assert.match(stored, /\r\nORGANIZER:mailto:me@mail\.example\r\n/);
    } finally {
      await proxy.close();
    }
  });

  it("create_event and update_event answer may_notify: everyone the calendar server may now email, the attendees an ORGANIZER added makes schedulable too (review of PR #230)", async () => {
    const dir = await makeTmpDir();
    try {
      const file = await makeAccountsFile(dir, [
        makeAccount({
          id: "work",
          default: true,
          mail: { defaultFrom: MAILBOX, draftsFolder: "Drafts", sentFolder: "Sent" },
          caldav: { url: RADICALE_URL, user: cal.user, pass: RADICALE_PASSWORD },
        }),
      ]);
      const store = new AccountsStore(file);
      await store.reload();
      type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
      const handlers = new Map<string, Handler>();
      const server = {
        registerTool: (name: string, _config: unknown, handler: Handler) => handlers.set(name, handler),
      } as unknown as McpServer;
      registerCalendarTools(server, new ClientPool(store));
      const call = async (tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
        const handler = handlers.get(tool);
        assert.ok(handler, `no ${tool}`);
        return JSON.parse((await handler(args)).content[0].text) as Record<string, unknown>;
      };

      const created = await call("create_event", {
        calendar_url: cal.calendarUrl,
        summary: "Told",
        start: "2026-10-07T09:00:00Z",
        end: "2026-10-07T10:00:00Z",
        attendees: ["ben@example.com"],
        notify_attendees: true,
      });
      assert.deepEqual(created.may_notify, ["ben@example.com"]);

      // Ben is on it plainly and it has no ORGANIZER: adding Dan with true
      // makes the account organizer, and the server may now mail Ben too.
      const uid = "attendees-may-notify@example.com";
      await putRawEvent(cal, "attendees-may-notify.ics", richEvent(uid));
      const updated = await call("update_event", {
        calendar_url: cal.calendarUrl,
        uid,
        etag: await etagOf(uid),
        add_attendees: ["dan@example.com"],
        notify_attendees: true,
      });
      assert.deepEqual(updated.may_notify, ["ben@example.com", "dan@example.com"]);

      const renamed = await call("update_event", { calendar_url: cal.calendarUrl, uid, etag: updated.etag, summary: "Renamed" });
      assert.equal("may_notify" in renamed, false, "a change that leaves the guest list alone says nothing about it");
    } finally {
      await cleanupTmpDir(dir);
    }
  });

  it("someone else's meeting: a change to its guest list is refused with nothing written, a new title is written", async () => {
    const uid = "attendees-theirs@example.com";
    await putRawEvent(
      cal,
      "attendees-theirs.ics",
      richEvent(uid).replace("SUMMARY:Planning\r\n", "SUMMARY:Planning\r\nORGANIZER;CN=Anna:mailto:anna@example.com\r\n")
    );
    const client = withAddress();
    const etag = await etagOf(uid);
    const message = await refusal(
      client.updateEvent({ calendarUrl: cal.calendarUrl, uid, etag, addAttendees: ["dan@example.com"], notifyAttendees: false })
    );
    assert.match(message, /anna@example\.com/);
    assert.match(message, /Nothing was changed/);
    assert.equal(await etagOf(uid), etag);

    await client.updateEvent({ calendarUrl: cal.calendarUrl, uid, etag, summary: "Planning (my note)" });
    const stored = await storedAs("attendees-theirs.ics");
    assert.match(stored, /SUMMARY:Planning \(my note\)/);
    assert.doesNotMatch(stored, /dan@example\.com/);
  });

  it("adding an attendee who already is one is refused, and nothing is written", async () => {
    const uid = "attendees-twice@example.com";
    await putRawEvent(cal, "attendees-twice.ics", richEvent(uid));
    const etag = await etagOf(uid);
    const message = await refusal(
      withAddress().updateEvent({ calendarUrl: cal.calendarUrl, uid, etag, addAttendees: ["Ben@Example.com"], notifyAttendees: true })
    );
    assert.match(message, /already an attendee/);
    assert.equal(await etagOf(uid), etag);
  });
});
