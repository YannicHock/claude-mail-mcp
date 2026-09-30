/**
 * src/ical-zones.ts, the reading half: which zone a stored time is in, and
 * the wall-clock arithmetic `Intl` does for an IANA zone the object carries no
 * VTIMEZONE for (spec 2026-09-29 §2.5, #209).
 *
 * The two edges RFC 5545 §3.3.5 rules on are pinned here, because the first
 * conversion written while drafting the spec got one of them wrong: in the
 * autumn overlap a naive two-step `Intl` conversion returned the *second*
 * 02:30 in Berlin (01:30Z), and the RFC says the first (00:30Z).
 *
 * The zones are the ones §0.1 measured. Berlin, New York and Sydney are
 * ordinary rule-based zones in both hemispheres; Jerusalem and Casablanca are
 * the two a published VTIMEZONE package got wrong, on 14 and 1,627 days of
 * 2026–2030 respectively.
 */

import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import ICAL from "ical.js";

import {
  addToWall,
  calendarZone,
  canonicalZone,
  instantAt,
  instantToZonedWall,
  readDateTime,
  storedInstant,
  UTC_ZONE,
  vtimezoneFromIntl,
  resolveUnknownTzid,
  utcOffsetMs,
  withResolvedZones,
  zonedWallToInstant,
  zoneOf,
  zonedWriteZone,
  IntlTimezone,
} from "../../src/ical-zones.js";

const ZONES = ["Europe/Berlin", "America/New_York", "Australia/Sydney", "Asia/Jerusalem", "Africa/Casablanca"];

function ics(...lines: string[]): string {
  return `${lines.join("\r\n")}\r\n`;
}

function at(iso: string): number {
  return Date.parse(iso);
}

describe("zonedWallToInstant — RFC 5545 §3.3.5 at the two edges", () => {
  it("reads a time in the spring gap with the offset from before the gap", () => {
    // Berlin skips 02:00–03:00 on 2026-03-29. 02:30 at the old +01:00 is 01:30Z.
    assert.equal(zonedWallToInstant(2026, 3, 29, 2, 30, "Europe/Berlin"), at("2026-03-29T01:30:00Z"));
    // New York skips 02:00–03:00 on 2026-03-08. 02:30 at the old -05:00.
    assert.equal(zonedWallToInstant(2026, 3, 8, 2, 30, "America/New_York"), at("2026-03-08T07:30:00Z"));
    // Sydney skips 02:00–03:00 on 2026-10-04. 02:30 at the old +10:00.
    assert.equal(zonedWallToInstant(2026, 10, 4, 2, 30, "Australia/Sydney"), at("2026-10-03T16:30:00Z"));
  });

  it("reads a time in the autumn overlap as its first occurrence", () => {
    // Berlin has 02:00–03:00 twice on 2026-10-25: first at +02:00, then +01:00.
    // The naive two-step conversion answered 01:30Z here, the second one.
    assert.equal(zonedWallToInstant(2026, 10, 25, 2, 30, "Europe/Berlin"), at("2026-10-25T00:30:00Z"));
    // New York has 01:00–02:00 twice on 2026-11-01: first at -04:00.
    assert.equal(zonedWallToInstant(2026, 11, 1, 1, 30, "America/New_York"), at("2026-11-01T05:30:00Z"));
    // Sydney has 02:00–03:00 twice on 2026-04-05: first at +11:00.
    assert.equal(zonedWallToInstant(2026, 4, 5, 2, 30, "Australia/Sydney"), at("2026-04-04T15:30:00Z"));
  });

  it("reads an ordinary time with the one offset it has", () => {
    assert.equal(zonedWallToInstant(2026, 10, 1, 9, 0, "Europe/Berlin"), at("2026-10-01T07:00:00Z"));
    assert.equal(zonedWallToInstant(2026, 12, 1, 9, 0, "Europe/Berlin"), at("2026-12-01T08:00:00Z"));
    assert.equal(zonedWallToInstant(2026, 1, 15, 9, 0, "Australia/Sydney"), at("2026-01-14T22:00:00Z"));
  });
});

describe("Intl round trips, 2026–2030", () => {
  for (const tz of ZONES) {
    it(`${tz}: every instant's wall time converts back to an instant with that wall time`, () => {
      // Every five hours: coprime with 24, so over five years every hour of
      // the day is visited on hundreds of days, the transition hours included.
      const step = 5 * 3600_000;
      for (let ms = at("2026-01-01T00:00:00Z"); ms < at("2031-01-01T00:00:00Z"); ms += step) {
        const wall = instantToZonedWall(ms, tz);
        const back = zonedWallToInstant(wall.year, wall.month, wall.day, wall.hour, wall.minute, tz);
        assert.deepEqual(instantToZonedWall(back, tz), wall, `${tz} ${new Date(ms).toISOString()}`);
        // Equal, or the first of two instants showing the same wall time.
        assert.ok(back <= ms, `${tz} ${new Date(ms).toISOString()} came back later, as ${new Date(back).toISOString()}`);
        assert.equal(utcOffsetMs(ms, tz), Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second) - ms);
      }
    });
  }

  it("agrees with the offsets the zones are known to have", () => {
    assert.equal(utcOffsetMs(at("2026-07-01T12:00:00Z"), "Europe/Berlin"), 2 * 3600_000);
    assert.equal(utcOffsetMs(at("2026-07-01T12:00:00Z"), "America/New_York"), -4 * 3600_000);
    assert.equal(utcOffsetMs(at("2026-07-01T12:00:00Z"), "Australia/Sydney"), 10 * 3600_000);
    assert.equal(utcOffsetMs(at("2026-01-01T12:00:00Z"), "Australia/Sydney"), 11 * 3600_000);
  });
});

describe("utcOffsetMs — remembered per zone and year, still Intl's answer (review of #223)", () => {
  /** Intl's own answer, asked every time: what utcOffsetMs said before it remembered. */
  function asked(ms: number, tz: string): number {
    const w = instantToZonedWall(ms, tz);
    return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - Math.floor(ms / 1000) * 1000;
  }

  // Lord Howe moves by 30 minutes; Kathmandu is +05:45 and changed once, in
  // 1986; Casablanca suspends DST for Ramadan; 1916 is Berlin's first DST.
  const cases: Array<[string, number[]]> = [
    ["Europe/Berlin", [1916, 1990, 2026]],
    ["Australia/Lord_Howe", [2026]],
    ["Asia/Kathmandu", [1986]],
    ["Africa/Casablanca", [2026]],
    ["America/Sao_Paulo", [2018]],
  ];
  for (const [tz, years] of cases) {
    it(`${tz} in ${years.join(", ")}: the same offset as asking Intl, every 37 minutes of the year`, () => {
      for (const year of years) {
        for (let ms = Date.UTC(year, 0, 1); ms < Date.UTC(year + 1, 0, 1); ms += 37 * 60_000) {
          assert.equal(utcOffsetMs(ms, tz), asked(ms, tz), `${tz} ${new Date(ms).toISOString()}`);
        }
      }
    });
  }

  it("changes on the exact second of a transition", () => {
    const change = at("2026-03-29T01:00:00Z");
    assert.equal(utcOffsetMs(change - 1000, "Europe/Berlin"), 3600_000);
    assert.equal(utcOffsetMs(change, "Europe/Berlin"), 7200_000);
    const lordHowe = at("2026-04-04T15:00:00Z");
    assert.equal(utcOffsetMs(lordHowe - 1000, "Australia/Lord_Howe"), 11 * 3600_000);
    assert.equal(utcOffsetMs(lordHowe, "Australia/Lord_Howe"), 10.5 * 3600_000);
  });

  // Review of #225: a year asked only a few times — a yearly series walked
  // from long ago — is answered by asking Intl directly rather than scanning
  // the whole year, and that answer must be the same one to the second.
  it("answers a year asked only a few times exactly as Intl does: year edges, before 1970, local mean time", () => {
    const probes: Array<[string, string]> = [
      ["America/New_York", "0100-01-01T14:00:00Z"],
      ["America/New_York", "1883-11-18T16:59:59Z"],
      ["America/New_York", "1883-11-18T17:00:00Z"],
      ["America/New_York", "1969-12-31T23:59:59Z"],
      ["America/New_York", "1970-01-01T00:00:00Z"],
      ["Pacific/Kiritimati", "1994-12-31T09:59:59Z"],
      ["Pacific/Kiritimati", "1995-01-01T10:00:00Z"],
      ["Pacific/Auckland", "1975-12-31T23:59:59Z"],
      ["Pacific/Auckland", "1976-01-01T00:00:00Z"],
      ["Asia/Kolkata", "1941-10-01T00:00:00Z"],
    ];
    for (const [tz, iso] of probes) {
      const ms = at(iso);
      assert.equal(utcOffsetMs(ms, tz), asked(ms, tz), `${tz} ${iso}`);
    }
  });

  it("reads the gap and the overlap of a year it has not scanned by RFC 5545's rule", () => {
    // Berlin's first DST after 1949: no 02:30 on 1980-04-06, two on 1980-09-28.
    assert.equal(zonedWallToInstant(1980, 4, 6, 2, 30, "Europe/Berlin"), at("1980-04-06T01:30:00Z"));
    assert.equal(zonedWallToInstant(1980, 9, 28, 2, 30, "Europe/Berlin"), at("1980-09-28T00:30:00Z"));
    // And the same in a year then asked often enough to be scanned.
    for (let ms = at("1980-01-01T00:00:00Z"); ms < at("1981-01-01T00:00:00Z"); ms += 3 * 3600_000) {
      assert.equal(utcOffsetMs(ms, "Europe/Berlin"), asked(ms, "Europe/Berlin"), new Date(ms).toISOString());
    }
    assert.equal(zonedWallToInstant(1980, 4, 6, 2, 30, "Europe/Berlin"), at("1980-04-06T01:30:00Z"));
    assert.equal(zonedWallToInstant(1980, 9, 28, 2, 30, "Europe/Berlin"), at("1980-09-28T00:30:00Z"));
  });
});

describe("resolveUnknownTzid", () => {
  it("accepts an IANA name as it is", () => {
    assert.equal(resolveUnknownTzid("Europe/Berlin"), "Europe/Berlin");
    assert.equal(resolveUnknownTzid("America/Argentina/Buenos_Aires"), "America/Argentina/Buenos_Aires");
  });

  it("takes the IANA tail of a path-like TZID", () => {
    assert.equal(resolveUnknownTzid("/mozilla.org/20050126_1/Europe/Berlin"), "Europe/Berlin");
    assert.equal(
      resolveUnknownTzid("/citadel.org/20190914_1/America/Argentina/Buenos_Aires"),
      "America/Argentina/Buenos_Aires"
    );
  });

  it("gives up on a Windows zone name, and on anything else it cannot place", () => {
    assert.equal(resolveUnknownTzid("W. Europe Standard Time"), null);
    assert.equal(resolveUnknownTzid("My Custom Zone"), null);
    assert.equal(resolveUnknownTzid("+01:00"), null);
    assert.equal(resolveUnknownTzid(""), null);
  });
});

/** Every VEVENT's DTSTART, as ical.js now reads it. */
function dtstart(vcal: ICAL.Component): ICAL.Property {
  const prop = vcal.getFirstSubcomponent("vevent")?.getFirstProperty("dtstart");
  assert.ok(prop);
  return prop;
}

describe("withResolvedZones and zoneOf", () => {
  const BERLIN_NO_VTIMEZONE = ics(
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Other Client//EN",
    "BEGIN:VEVENT",
    "UID:nozone@example.com",
    "DTSTAMP:20260901T080000Z",
    "DTSTART;TZID=/mozilla.org/20050126_1/Europe/Berlin:20261025T023000",
    "DTEND;TZID=/mozilla.org/20050126_1/Europe/Berlin:20261025T033000",
    "SUMMARY:In the overlap",
    "END:VEVENT",
    "END:VCALENDAR"
  );

  it("places a TZID with no VTIMEZONE through Intl, overlap rule included (R6)", () => {
    const vcal = new ICAL.Component(ICAL.parse(BERLIN_NO_VTIMEZONE));
    assert.deepEqual(withResolvedZones(vcal), { unresolved: [] });
    const start = dtstart(vcal).getFirstValue() as ICAL.Time;
    assert.equal(start.toJSDate().toISOString(), "2026-10-25T00:30:00.000Z");
    assert.deepEqual(zoneOf(dtstart(vcal)), { kind: "iana", tzid: "Europe/Berlin" });
  });

  it("changes nothing that would be written back: no VTIMEZONE is added, the TZID stays as stored", () => {
    const vcal = new ICAL.Component(ICAL.parse(BERLIN_NO_VTIMEZONE));
    const before = vcal.toString();
    withResolvedZones(vcal);
    // Read a value, so any lazily decorated property has been through it.
    (dtstart(vcal).getFirstValue() as ICAL.Time).toJSDate();
    assert.equal(vcal.toString(), before);
    assert.equal(vcal.getAllSubcomponents("vtimezone").length, 0);
  });

  it("names a TZID it cannot resolve, and leaves the object alone", () => {
    const vcal = new ICAL.Component(
      ICAL.parse(BERLIN_NO_VTIMEZONE.replaceAll("/mozilla.org/20050126_1/Europe/Berlin", "W. Europe Standard Time"))
    );
    assert.deepEqual(withResolvedZones(vcal), { unresolved: ["W. Europe Standard Time"] });
    assert.deepEqual(zoneOf(dtstart(vcal)), { kind: "unresolved", tzid: "W. Europe Standard Time" });
  });

  it("uses the object's own VTIMEZONE when it has one, even for an IANA TZID", () => {
    const withVtimezone = ics(
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Other Client//EN",
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
      "BEGIN:VEVENT",
      "UID:zoned@example.com",
      "DTSTAMP:20260901T080000Z",
      "DTSTART;TZID=Europe/Berlin:20261001T090000",
      "SUMMARY:Zoned",
      "END:VEVENT",
      "END:VCALENDAR"
    );
    const vcal = new ICAL.Component(ICAL.parse(withVtimezone));
    assert.deepEqual(withResolvedZones(vcal), { unresolved: [] });
    assert.deepEqual(zoneOf(dtstart(vcal)), { kind: "vtimezone", tzid: "Europe/Berlin" });
    assert.equal((dtstart(vcal).getFirstValue() as ICAL.Time).toJSDate().toISOString(), "2026-10-01T07:00:00.000Z");
  });

  it("tells UTC from floating", () => {
    const vcal = new ICAL.Component(
      ICAL.parse(
        ics(
          "BEGIN:VCALENDAR",
          "VERSION:2.0",
          "PRODID:-//Other Client//EN",
          "BEGIN:VEVENT",
          "UID:a@example.com",
          "DTSTAMP:20260901T080000Z",
          "DTSTART:20261001T090000Z",
          "DTEND:20261001T100000",
          "END:VEVENT",
          "END:VCALENDAR"
        )
      )
    );
    withResolvedZones(vcal);
    const ve = vcal.getFirstSubcomponent("vevent");
    assert.ok(ve);
    assert.deepEqual(zoneOf(ve.getFirstProperty("dtstart")!), { kind: "utc" });
    assert.deepEqual(zoneOf(ve.getFirstProperty("dtend")!), { kind: "floating" });
  });
});

/** An ical.js zone read from the VTIMEZONE text `vtimezoneFromIntl` wrote. */
function zoneFrom(vtimezone: string): ICAL.Timezone {
  const vcal = new ICAL.Component(ICAL.parse(`BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${vtimezone}END:VCALENDAR\r\n`));
  const component = vcal.getFirstSubcomponent("vtimezone");
  assert.ok(component, "no VTIMEZONE in the text");
  return new ICAL.Timezone(component);
}

describe("vtimezoneFromIntl — the VTIMEZONE create_event writes (spec §2.5 A)", () => {
  // Jerusalem and Casablanca are the two zones the rejected package got
  // wrong; Kolkata has no transitions at all; Sydney changes in the other
  // hemisphere.
  for (const tz of ZONES.concat("Asia/Kolkata")) {
    it(`${tz}: ical.js reading it agrees with Intl at every hour it can name`, () => {
      const from = at("2026-01-01T00:00:00Z");
      const to = at("2028-01-01T00:00:00Z");
      const zone = zoneFrom(vtimezoneFromIntl(tz, from, to));
      assert.equal(zone.tzid, tz);
      let checked = 0;
      for (let ms = from; ms < to; ms += 5 * 3600_000) {
        const w = instantToZonedWall(ms, tz);
        // A wall time in an autumn overlap names two instants. RFC 5545 says
        // the first; ical.js reading a VTIMEZONE takes the second, whoever
        // wrote the block. That is ical.js's reading, not this block, so
        // those hours are left out and every other one is checked.
        const ambiguous = [1800_000, 3600_000, 7200_000].some(
          (d) =>
            JSON.stringify(instantToZonedWall(ms - d, tz)) === JSON.stringify(w) ||
            JSON.stringify(instantToZonedWall(ms + d, tz)) === JSON.stringify(w)
        );
        if (ambiguous) continue;
        const t = ICAL.Time.fromData({ ...w, isDate: false }, zone);
        assert.equal(t.toUnixTime() * 1000, ms, `${tz} ${new Date(ms).toISOString()}`);
        checked += 1;
      }
      assert.ok(checked > 3000, `only ${checked} instants checked`);
    });
  }

  it("emits one observance per transition, STANDARD or DAYLIGHT, and one alone for a zone with none", () => {
    const from = at("2026-01-01T00:00:00Z");
    const to = at("2027-01-01T00:00:00Z");
    const berlin = vtimezoneFromIntl("Europe/Berlin", from, to);
    // The one in effect at the start, then March and October.
    assert.equal((berlin.match(/BEGIN:(STANDARD|DAYLIGHT)/g) ?? []).length, 3);
    assert.match(berlin, /BEGIN:DAYLIGHT\r\nDTSTART:20260329T020000\r\nTZOFFSETFROM:\+0100\r\nTZOFFSETTO:\+0200\r\n/);
    assert.match(berlin, /BEGIN:STANDARD\r\nDTSTART:20261025T030000\r\nTZOFFSETFROM:\+0200\r\nTZOFFSETTO:\+0100\r\n/);
    const kolkata = vtimezoneFromIntl("Asia/Kolkata", from, to);
    assert.equal((kolkata.match(/BEGIN:(STANDARD|DAYLIGHT)/g) ?? []).length, 1);
    assert.match(kolkata, /TZOFFSETTO:\+0530/);
  });
});

describe("the zone a new event is written in", () => {
  it("canonicalZone takes an IANA name in its canonical spelling, and nothing else", () => {
    assert.equal(canonicalZone("Asia/Jerusalem"), "Asia/Jerusalem");
    assert.equal(canonicalZone("europe/berlin"), "Europe/Berlin");
    assert.equal(canonicalZone("UTC"), "UTC");
    assert.equal(canonicalZone("W. Europe Standard Time"), null);
    assert.equal(canonicalZone("+02:00"), null);
    assert.equal(canonicalZone(""), null);
  });

  it("calendarZone reads a calendar's calendar-timezone as VTIMEZONE text or as a bare id", () => {
    const text = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Nextcloud//EN",
      "BEGIN:VTIMEZONE",
      "TZID:Europe/Berlin",
      "BEGIN:STANDARD",
      "DTSTART:19701025T030000",
      "TZOFFSETFROM:+0200",
      "TZOFFSETTO:+0100",
      "END:STANDARD",
      "END:VTIMEZONE",
      "END:VCALENDAR",
      "",
    ].join("\r\n");
    assert.equal(calendarZone(text), "Europe/Berlin");
    assert.equal(calendarZone(text.replace("TZID:Europe/Berlin", "TZID:/mozilla.org/20050126_1/Europe/Berlin")), "Europe/Berlin");
    assert.equal(calendarZone("Europe/Berlin"), "Europe/Berlin");
    assert.equal(calendarZone("  Asia/Jerusalem\n"), "Asia/Jerusalem");
  });

  it("calendarZone gives up — so the event is written in UTC — on no zone, or one it cannot place", () => {
    // Radicale sets no calendar-timezone (R13), and tsdav then reports "".
    for (const value of ["", undefined, null, 42, { _cdata: "Europe/Berlin" }, "W. Europe Standard Time", "BEGIN:VCALENDAR\r\nnonsense"]) {
      assert.equal(calendarZone(value), null, JSON.stringify(value));
    }
  });

  it("zonedWriteZone is UTC for a name that means UTC, and TZID local time through Intl otherwise (code-health review of PR 3)", () => {
    assert.deepEqual(zonedWriteZone("UTC"), { kind: "utc" });
    assert.deepEqual(zonedWriteZone("Etc/UTC"), { kind: "utc" });
    const berlin = zonedWriteZone("Europe/Berlin");
    assert.ok(berlin.kind === "zoned" && berlin.tzid === "Europe/Berlin", JSON.stringify(berlin.kind));
    assert.ok(berlin.zone instanceof IntlTimezone && berlin.zone.iana === "Europe/Berlin");
  });
});

/**
 * `Date.UTC` reads a year 0–99 as 1900–1999, so every wall time built with it
 * in those years landed 1900 years late (found in the fix pass of PR #232).
 * iCalendar has such years — a yearly series since the year 50 is valid —
 * and `Date.parse` of an ISO string reads them right, so it is the reference.
 */
describe("wall times in the years 0–99 are those years, not 1900–1999", () => {
  const wall = { year: 50, month: 1, day: 1, hour: 9, minute: 0, second: 30 };
  const utc = at("0050-01-01T09:00:30Z");

  it("instantAt reads a UTC, a floating and a zoned wall time in the year 50", () => {
    assert.equal(instantAt(wall, UTC_ZONE), utc);
    assert.equal(instantAt(wall, { kind: "floating" }), utc);
    const ms = instantAt(wall, zonedWriteZone("Europe/Berlin"));
    assert.deepEqual(instantToZonedWall(ms, "Europe/Berlin"), wall);
  });

  it("zonedWallToInstant and IntlTimezone place the year 50 by the offset Intl gives then", () => {
    const ms = zonedWallToInstant(50, 1, 1, 9, 0, "Europe/Berlin");
    assert.deepEqual(instantToZonedWall(ms, "Europe/Berlin"), { ...wall, second: 0 });
    const tz = new IntlTimezone("Europe/Berlin", "Europe/Berlin");
    const time = ICAL.Time.fromData({ year: 50, month: 1, day: 1, hour: 9, minute: 0, second: 0, isDate: false }, undefined);
    assert.equal(tz.utcOffset(time) * 1000, utcOffsetMs(ms, "Europe/Berlin"));
  });

  it("readDateTime takes a clock time in the year 50 instead of refusing it as no date", () => {
    assert.equal(readDateTime("0050-01-01T09:00:30", UTC_ZONE), utc);
    assert.equal(readDateTime("0050-01-01T09:00:30", { kind: "floating" }), utc);
  });

  it("storedInstant reads a floating time in the year 50, and addToWall steps it on its own clock", () => {
    const floating = ICAL.Time.fromData({ year: 50, month: 1, day: 1, hour: 9, minute: 0, second: 30, isDate: false }, undefined);
    assert.equal(storedInstant(floating, { kind: "floating" }), utc);
    assert.deepEqual(addToWall(wall, 86_400), { ...wall, day: 2 });
    assert.deepEqual(addToWall({ ...wall, year: 99, month: 12, day: 31 }, 86_400), { ...wall, year: 100 });
  });
});

/**
 * A VTIMEZONE whose observance rule never matches a date (milestone review
 * of v0.7.4, finding 1). `list_events` reads it in a worker, under a
 * deadline; the writers read it on the connector's own thread, where
 * ical.js's `_ensureCoverage` walked the rule with nothing to stop it —
 * `update_event` with a new `start` never returned, and nothing else did
 * either.
 *
 * A synchronous loop cannot be stopped by a node:test timeout in the same
 * process, so each case runs in a child process with a deadline of its own:
 * a hang is a failure here, not a test run that never ends.
 */
describe("a VTIMEZONE whose observance rule never matches is refused, not walked for ever (milestone review of v0.7.4)", () => {
  const HOSTILE_ZONE = [
    "BEGIN:VTIMEZONE",
    "TZID:Hostile Standard Time",
    "BEGIN:STANDARD",
    "DTSTART:19701025T030000",
    "TZOFFSETFROM:+0200",
    "TZOFFSETTO:+0100",
    "RRULE:FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30",
    "END:STANDARD",
    "END:VTIMEZONE",
  ];

  function hostile(uid: string, ...extra: string[]): string {
    return ics(
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Other Client//EN",
      ...HOSTILE_ZONE,
      "BEGIN:VEVENT",
      `UID:${uid}`,
      "DTSTAMP:20260901T080000Z",
      "DTSTART;TZID=Hostile Standard Time:20261001T090000",
      "DTEND;TZID=Hostile Standard Time:20261001T100000",
      ...extra,
      "SUMMARY:Planning",
      "END:VEVENT",
      "END:VCALENDAR"
    );
  }

  /**
   * Run `call` — an expression over `parsed`, the parse of `text`, and `ctx`
   * — in a child process, and answer what it printed: the error's class and
   * message, or "WROTE". A child still running after `deadlineMs` is killed,
   * and the answer says it hung.
   */
  function inChild(text: string, call: string, deadlineMs = 20_000): string {
    const src = (name: string): string =>
      JSON.stringify(pathToFileURL(fileURLToPath(new URL(`../../src/${name}`, import.meta.url))).href);
    const script = [
      `const { parseCalendar } = await import(${src("ical-parse.ts")});`,
      `const { applyEventPatch } = await import(${src("ical-edit.ts")});`,
      `const { shiftSeries } = await import(${src("ical-series-shift.ts")});`,
      `const parsed = parseCalendar(${JSON.stringify(text)});`,
      `const ctx = { nothingDone: "Nothing was changed.", now: new Date("2026-09-30T12:00:00Z"), own: [] };`,
      "try {",
      `  ${call};`,
      `  console.log("WROTE");`,
      "} catch (err) {",
      "  console.log(`${err.constructor.name}: ${err.message}`);",
      "}",
    ].join("\n");
    const run = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      encoding: "utf8",
      timeout: deadlineMs,
    });
    if (run.error !== undefined || run.signal !== null) return `HUNG (${run.signal ?? String(run.error)})`;
    return `${run.stdout}${run.stderr}`.trim();
  }

  it("update_event's move of one event (applyEventPatch) is refused, with nothing written", { timeout: 60_000 }, () => {
    const answer = inChild(
      hostile("hostile-once@example.com"),
      `applyEventPatch(parsed, "hostile-once@example.com", { start: "2026-10-01T11:00:00" }, ctx)`
    );
    assert.match(answer, /^ToolRefusal: /);
    assert.match(answer, /time zone definition could not be read/);
    assert.match(answer, /Nothing was changed\.$/);
  });

  it("a series' new time (shiftSeries) is refused the same way", { timeout: 60_000 }, () => {
    const answer = inChild(
      hostile("hostile-series@example.com", "RRULE:FREQ=WEEKLY;COUNT=3"),
      `shiftSeries(parsed, "hostile-series@example.com", null, { start: "2026-10-01T11:00:00" }, ctx)`
    );
    assert.match(answer, /^ToolRefusal: /);
    assert.match(answer, /time zone definition could not be read/);
    assert.match(answer, /Nothing was changed\.$/);
  });
});
