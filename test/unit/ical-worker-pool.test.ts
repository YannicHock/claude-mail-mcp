/**
 * src/ical-worker-pool.ts — expansion off the main thread, under a deadline
 * (review of #223, finding 1).
 *
 * ical.js's `RecurIterator.next` never returns for a DAILY rule whose BY-parts
 * can never match, and expansion used to run on the connector's one thread:
 * one such object froze every tool call, every account and the health check.
 * The rule used here, `FREQ=DAILY;BYWEEKNO=1;BYMONTH=6` (week 1 never reaches
 * June), is one `impossibleRule` does not catch, on purpose: the deadline is
 * the guarantee, and the pre-check only the fast path.
 */

import { after, describe, it } from "node:test";
import assert from "node:assert/strict";

import { ExpansionPool } from "../../src/ical-worker-pool.js";

function ics(...lines: string[]): string {
  return `${lines.join("\r\n")}\r\n`;
}

function event(uid: string, ...lines: string[]): string {
  return ics(
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Other Client//EN",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    "DTSTAMP:20260901T080000Z",
    ...lines,
    "END:VEVENT",
    "END:VCALENDAR"
  );
}

const OCTOBER = { start: Date.parse("2026-10-01T00:00:00Z"), end: Date.parse("2026-11-01T00:00:00Z") };

const GOOD = event("good@example.com", "DTSTART:20261002T090000Z", "DTEND:20261002T100000Z", "SUMMARY:Dentist");
const WEEKLY = event(
  "weekly@example.com",
  "DTSTART:20261001T090000Z",
  "DTEND:20261001T093000Z",
  "RRULE:FREQ=WEEKLY;COUNT=3",
  "SUMMARY:Standup"
);
/** Never returns from ical.js: no day of ISO week 1 is in June. */
const HANGS = event(
  "hangs@example.com",
  "DTSTART:20200101T090000Z",
  "DURATION:PT1H",
  "RRULE:FREQ=DAILY;BYWEEKNO=1;BYMONTH=6",
  "SUMMARY:Never ends"
);

const pools: ExpansionPool[] = [];
function pool(options: { size?: number; deadlineMs?: number }): ExpansionPool {
  const p = new ExpansionPool(options);
  pools.push(p);
  return p;
}

after(async () => {
  await Promise.all(pools.map((p) => p.close()));
});

describe("ExpansionPool", () => {
  it("expands in a worker to exactly what expandObject answers in-process", { timeout: 20_000 }, async () => {
    const [good, weekly] = await pool({}).expand(
      [
        { url: "https://dav.example/cal/good.ics", etag: '"g"', data: GOOD },
        { url: "https://dav.example/cal/weekly.ics", etag: null, data: WEEKLY },
      ],
      OCTOBER
    );
    assert.equal(good.skipped, undefined);
    assert.deepEqual(
      good.instances.map((e) => [e.url, e.etag, e.summary, e.start]),
      [["https://dav.example/cal/good.ics", '"g"', "Dentist", "2026-10-02T09:00:00.000Z"]]
    );
    assert.deepEqual(
      weekly.instances.map((e) => e.recurrenceId),
      ["2026-10-01T09:00:00.000Z", "2026-10-08T09:00:00.000Z", "2026-10-15T09:00:00.000Z"]
    );
  });

  it("skips an object whose rule never returns once the deadline passes, and lists the ones around it", { timeout: 20_000 }, async () => {
    // One worker, so the object after the hang has to wait for its replacement.
    const p = pool({ size: 1, deadlineMs: 750 });
    await p.expand([{ url: "warm", etag: null, data: GOOD }], OCTOBER);
    const started = Date.now();
    const results = await p.expand(
      [
        { url: "https://dav.example/cal/good.ics", etag: null, data: GOOD },
        { url: "https://dav.example/cal/hangs.ics", etag: null, data: HANGS },
        { url: "https://dav.example/cal/weekly.ics", etag: null, data: WEEKLY },
      ],
      OCTOBER
    );
    const elapsed = Date.now() - started;
    assert.deepEqual(
      results.map((r) => r.instances.length),
      [1, 0, 3]
    );
    assert.equal(results[0].skipped, undefined);
    assert.match(results[1].skipped ?? "", /did not finish expanding within 0\.75 s/);
    assert.equal(results[2].skipped, undefined);
    assert.ok(elapsed < 10_000, `took ${elapsed} ms`);
  });

  it("keeps the event loop free while a worker is stuck", { timeout: 20_000 }, async () => {
    const p = pool({ size: 1, deadlineMs: 1000 });
    let ticks = 0;
    const timer = setInterval(() => ticks++, 50);
    try {
      const [hangs] = await p.expand([{ url: "hangs", etag: null, data: HANGS }], OCTOBER);
      assert.match(hangs.skipped ?? "", /did not finish/);
    } finally {
      clearInterval(timer);
    }
    assert.ok(ticks >= 10, `the main thread ticked only ${ticks} times in a one-second deadline`);
  });

  it("answers again after a timeout, with a fresh worker", { timeout: 20_000 }, async () => {
    const p = pool({ size: 1, deadlineMs: 500 });
    await p.expand([{ url: "hangs", etag: null, data: HANGS }], OCTOBER);
    const [good] = await p.expand([{ url: "good", etag: null, data: GOOD }], OCTOBER);
    assert.equal(good.instances.length, 1);
  });
});
