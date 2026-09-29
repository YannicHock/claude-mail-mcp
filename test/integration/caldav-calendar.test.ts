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
  startEtaglessPutProxy,
  editBehindTheBack,
  getRawEvent,
  makeRadicaleCalendar,
  putRawEvent,
  waitForRadicaleReady,
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
  const events = await client.listEvents(cal.calendarUrl, WINDOW.start, WINDOW.end);
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
    const moved = (await client.listEvents(cal.calendarUrl, WINDOW.start, WINDOW.end)).find((e) => e.uid === uid);
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
    const before = await client.listEvents(cal.calendarUrl, WINDOW.start, WINDOW.end);
    const message = await refusal(
      client.updateEvent({ calendarUrl: cal.calendarUrl, uid: "nobody@example.com", etag: '"x"', summary: "x" })
    );
    assert.match(message, /No event with UID "nobody@example.com"/);
    assert.match(message, /no event was created/);
    const after = await client.listEvents(cal.calendarUrl, WINDOW.start, WINDOW.end);
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

describe("update_event on a server that answers a PUT without an ETag", SKIP, () => {
  // The v0.7.2 acceptance run on Nextcloud: update_event answered etag: null,
  // so a second change needed a list_events in between. The connector now
  // reads the new ETag back itself when the PUT did not carry one.
  it("returns the new etag anyway, and it carries a second update straight away", async () => {
    const proxy = await startEtaglessPutProxy();
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
