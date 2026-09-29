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

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import ICAL from "ical.js";

import {
  instantToZonedWall,
  resolveUnknownTzid,
  utcOffsetMs,
  withResolvedZones,
  zonedWallToInstant,
  zoneOf,
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
