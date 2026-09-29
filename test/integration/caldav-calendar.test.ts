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

import { CalDavClient } from "../../src/caldav-client.js";
import { ToolRefusal } from "../../src/tool-errors.js";
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

  it("#211.3: an override with no master is refused as the one occurrence it is, not as a series", async () => {
    const { cal: own, client: mine } = await freshCalendar();
    const uid = "invited-once@example.com";
    const etag = await putRawEvent(own, "invited-once.ics", overrideOnly(uid));
    for (const applyToSeries of [undefined, true]) {
      const message = await refusal(
        mine.updateEvent({ calendarUrl: own.calendarUrl, uid, etag, summary: "x", applyToSeries })
      );
      assert.match(message, /single occurrence of a series/, `apply_to_series: ${String(applyToSeries)}`);
      assert.match(message, /Nothing was changed/);
      assert.doesNotMatch(message, /pass apply_to_series/);
    }
    assert.match((await getRawEvent(own, "invited-once.ics")) ?? "", /SUMMARY:The one I was invited to/);

    const deleting = await refusal(mine.deleteEvent({ calendarUrl: own.calendarUrl, uid, etag }));
    assert.match(deleting, /single occurrence of a series/);
    assert.doesNotMatch(deleting, /every occurrence/);
    assert.match(deleting, /Nothing was deleted/);
    await mine.deleteEvent({ calendarUrl: own.calendarUrl, uid, etag, applyToSeries: true });
    assert.equal(await getRawEvent(own, "invited-once.ics"), null);
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

  it("refuses a series without apply_to_series, and its time even with it", async () => {
    const uid = "series-update@example.com";
    await putRawEvent(cal, "series-update.ics", seriesEvent(uid));
    const etag = await etagOf(uid);

    assert.match(
      await refusal(client.updateEvent({ calendarUrl: cal.calendarUrl, uid, etag, summary: "x" })),
      /recurring series.*every occurrence/
    );
    assert.match(
      await refusal(
        client.updateEvent({
          calendarUrl: cal.calendarUrl,
          uid,
          etag,
          applyToSeries: true,
          start: "2026-10-01T10:00:00Z",
        })
      ),
      /time of a whole series is not supported/
    );
    await client.updateEvent({ calendarUrl: cal.calendarUrl, uid, etag, applyToSeries: true, summary: "Daily" });
    assert.match((await getRawEvent(cal, "series-update.ics")) ?? "", /SUMMARY:Daily[\s\S]*RRULE:FREQ=WEEKLY;COUNT=5|RRULE:FREQ=WEEKLY;COUNT=5[\s\S]*SUMMARY:Daily/);
  });

  it("refuses a single occurrence, naming the limitation", async () => {
    const message = await refusal(
      client.updateEvent({
        calendarUrl: cal.calendarUrl,
        uid: "series-update@example.com",
        recurrenceId: "2026-10-08T09:00:00.000Z",
        summary: "x",
      })
    );
    assert.match(message, /single occurrence.*not supported yet/);
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

  it("If-Match: * mishandled, and the event gone by the retry: what the retry created is taken back", async () => {
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
      const message = await refusal(mine.updateEvent({ calendarUrl, uid, summary: "x" }));
      assert.match(message, /No event with UID "star-gone@example.com"/);
      assert.match(message, /no event was created/);
      assert.equal(await getRawEvent(own, "star-gone.ics"), null, "the retry left a created event behind");
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

  it("refuses a single occurrence, naming EXDATE", async () => {
    assert.match(
      await refusal(
        client.deleteEvent({
          calendarUrl: cal.calendarUrl,
          uid: "whatever@example.com",
          recurrenceId: "2026-10-08T09:00:00.000Z",
        })
      ),
      /EXDATE/
    );
  });
});
