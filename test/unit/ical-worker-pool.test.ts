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

import { ExpansionPool, reasonOf, startExpansionWorker, type ExpansionPoolOptions } from "../../src/ical-worker-pool.js";

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
function pool(options: ExpansionPoolOptions): ExpansionPool {
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

  it("lists a series of DTSTART and RDATE with no RRULE from its DTSTART, and finds that occurrence by its recurrence_id (#226)", { timeout: 20_000 }, async () => {
    const data = event(
      "rdate@example.com",
      "DTSTART:20261001T090000Z",
      "DTEND:20261001T100000Z",
      "RDATE:20261008T090000Z",
      "RDATE:20261015T090000Z",
      "SUMMARY:Talks"
    );
    const object = { url: "https://dav.example/cal/rdate.ics", etag: null, data };
    const p = pool({});
    const [listed] = await p.expand([object], OCTOBER);
    assert.equal(listed.skipped, undefined);
    assert.deepEqual(
      listed.instances.map((e) => e.recurrenceId),
      ["2026-10-01T09:00:00.000Z", "2026-10-08T09:00:00.000Z", "2026-10-15T09:00:00.000Z"]
    );
    const found = await p.runOn(object, "findOccurrence", data, "rdate@example.com", "2026-10-01T09:00:00.000Z");
    assert.equal(found.found, true);
    assert.equal(found.found && found.recurrenceId, "2026-10-01T09:00:00.000Z");
  });
});

describe("ExpansionPool — one slow calendar does not stall the others (review of #225)", () => {
  it("serves a second request between the first one's objects, not after all of them", { timeout: 30_000 }, async () => {
    // Account A's calendar holds six objects that never finish; account B
    // asks for one ordinary event while A's are being tried. In one FIFO,
    // B waited for all six: three deadlines with two workers (9 s measured
    // at the real 3 s). Taken in turn, B waits for at most one.
    const deadlineMs = 1000;
    const p = pool({ size: 2, deadlineMs });
    await p.expand([{ url: "warm-1", etag: null, data: GOOD }, { url: "warm-2", etag: null, data: GOOD }], OCTOBER);
    const hanging = Array.from({ length: 6 }, (_, i) => ({
      url: `https://a.example/cal/hangs-${i}.ics`,
      etag: `"h${i}"`,
      data: HANGS,
    }));
    const slow = p.expand(hanging, OCTOBER);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const started = Date.now();
    const [good] = await p.expand([{ url: "https://b.example/cal/good.ics", etag: '"g"', data: GOOD }], OCTOBER);
    const waited = Date.now() - started;
    assert.equal(good.instances.length, 1);
    assert.ok(waited < 2 * deadlineMs, `B waited ${waited} ms behind A's hanging objects`);
    const results = await slow;
    assert.ok(results.every((r) => /did not finish expanding/.test(r.skipped ?? "")));
  });

  it("runOnEach is one request too: a second one is served between its objects, and its hanging object rejects alone (#213)", { timeout: 30_000 }, async () => {
    // find_free_slot reads every object of every calendar asked about; one
    // runOn per object would be one request each, and another account's
    // single object would queue behind all of them. Five hanging objects on
    // two workers are three deadlines in one line, more than the two B may
    // wait; shorter deadlines than the test above keep two cores from
    // spinning long enough to slow the suite's timed tests.
    const deadlineMs = 600;
    const p = pool({ size: 2, deadlineMs });
    await p.expand([{ url: "warm-1", etag: null, data: GOOD }, { url: "warm-2", etag: null, data: GOOD }], OCTOBER);
    const objects = [
      ...Array.from({ length: 5 }, (_, i) => ({ url: `https://a.example/cal/hangs-${i}.ics`, etag: `"h${i}"`, data: HANGS })),
      { url: "https://a.example/cal/good.ics", etag: '"g"', data: GOOD },
    ];
    const slow = p.runOnEach(objects, "busyTimes", (o) => [o.data, OCTOBER, [], "UTC"]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const started = Date.now();
    const [good] = await p.expand([{ url: "https://b.example/cal/good.ics", etag: '"g"', data: GOOD }], OCTOBER);
    const waited = Date.now() - started;
    assert.equal(good.instances.length, 1);
    assert.ok(waited < 2 * deadlineMs, `B waited ${waited} ms behind A's hanging objects`);
    const results = await slow;
    assert.deepEqual(
      results.map((r) => r.status),
      ["rejected", "rejected", "rejected", "rejected", "rejected", "fulfilled"]
    );
    const first = results[0];
    assert.match(first.status === "rejected" ? reasonOf(first.reason) : "", /did not finish reading its busy times/);
  });

  it("skips an object that timed out before at once, with the same reason, until its ETag changes", { timeout: 30_000 }, async () => {
    const p = pool({ size: 1, deadlineMs: 750 });
    const object = { url: "https://a.example/cal/hangs.ics", etag: '"v1"', data: HANGS };
    const [first] = await p.expand([object], OCTOBER);
    assert.match(first.skipped ?? "", /did not finish expanding within 0\.75 s/);

    const started = Date.now();
    const [again] = await p.expand([object, { url: "good", etag: '"g"', data: GOOD }], OCTOBER);
    const waited = Date.now() - started;
    assert.equal(again.skipped, first.skipped);
    assert.ok(waited < 500, `the second call waited ${waited} ms for an object already known to hang`);

    // A new ETag is a new object, and gets its own try.
    const changed = Date.now();
    const [edited] = await p.expand([{ ...object, etag: '"v2"' }], OCTOBER);
    assert.match(edited.skipped ?? "", /did not finish/);
    assert.ok(Date.now() - changed >= 700, "an edited object was skipped without being tried");
  });
});

describe("ExpansionPool — a worker that cannot start never takes the process down (review of #225)", () => {
  it("fails the waiting objects, not the connector, when a replacement worker cannot be created", { timeout: 20_000 }, async () => {
    // The replacement for a timed-out worker is created from the deadline's
    // timer. `new Worker` throws synchronously there on EMFILE or
    // ERR_WORKER_INIT_FAILED, and a throw in a timer is an uncaught exception.
    let created = 0;
    const p = pool({
      size: 1,
      deadlineMs: 500,
      startWorker: () => {
        created++;
        if (created === 2) throw Object.assign(new Error("EMFILE: too many open files"), { code: "EMFILE" });
        return startExpansionWorker();
      },
    });
    const results = await p.expand(
      [
        { url: "hangs", etag: null, data: HANGS },
        { url: "good", etag: null, data: GOOD },
      ],
      OCTOBER
    );
    assert.match(results[0].skipped ?? "", /did not finish/);
    assert.equal(results[1].instances.length, 0);
    assert.match(results[1].skipped ?? "", /could not start.*EMFILE/);

    // Once workers can be created again, the pool answers again.
    const [good] = await p.expand([{ url: "good", etag: null, data: GOOD }], OCTOBER);
    assert.equal(good.instances.length, 1);
  });
});
