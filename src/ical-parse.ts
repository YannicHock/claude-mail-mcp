/**
 * The one way a stored iCalendar object is read, and the one way its VEVENTs
 * are grouped into series. Every module that looks inside an object —
 * src/ical-expand.ts for `list_events`, src/ical-edit.ts for the writes —
 * starts here, so the two cannot read the same object two ways.
 *
 * They did (the health review of #223): the reader resolved a TZID with no
 * VTIMEZONE through `Intl` and listed the event as `Europe/Berlin`, while the
 * writer parsed the same text without that step and treated the same time as
 * floating. And the "main VEVENT plus its overrides for one UID" split was
 * written out three times. Both live here now.
 */

import ICAL from "ical.js";
import { withResolvedZones } from "./ical-zones.js";

/** A parsed object, with its zones resolved; see {@link parseCalendar}. */
export interface ParsedCalendar {
  vcal: ICAL.Component;
  /**
   * TZIDs with no VTIMEZONE in the object that are no IANA name either. Their
   * times read as floating; a reader skips the object and a writer refuses
   * anything that needs such a time as an instant.
   */
  unresolved: string[];
}

/**
 * Parse `ics` and give every TZID it carries no VTIMEZONE for the `Intl` zone
 * it names (src/ical-zones.ts, spec 2026-09-29 §2.5), before anything has read
 * a time: ical.js caches an instant once computed. Nothing that would be
 * written back changes.
 *
 * Throws for text that is not iCalendar at all; each caller decides what that
 * means for it (a `skipped` entry, a candidate passed over).
 */
export function parseCalendar(ics: string): ParsedCalendar {
  const vcal = new ICAL.Component(ICAL.parse(ics));
  const { unresolved } = withResolvedZones(vcal);
  return { vcal, unresolved };
}

/**
 * One UID's VEVENTs: the main one, with no RECURRENCE-ID, and the overrides
 * that each replace one of its occurrences. `master` is absent for an object
 * that holds only overrides — an invitation to one instance of someone else's
 * series (R3, #211.3).
 */
export interface Series {
  master?: ICAL.Component;
  overrides: ICAL.Component[];
}

/** Every UID in `vcal` with its {@link Series}, in the order the UIDs first appear. */
export function seriesIn(vcal: ICAL.Component): Map<string, Series> {
  const byUid = new Map<string, Series>();
  for (const ve of vcal.getAllSubcomponents("vevent")) {
    const uid = String(ve.getFirstPropertyValue("uid") ?? "");
    let series = byUid.get(uid);
    if (series === undefined) {
      series = { overrides: [] };
      byUid.set(uid, series);
    }
    if (ve.hasProperty("recurrence-id")) series.overrides.push(ve);
    // A second VEVENT without a RECURRENCE-ID for one UID is not valid; the
    // first one is the main event, as every reader here has always taken it.
    else if (series.master === undefined) series.master = ve;
  }
  return byUid;
}

/**
 * The {@link Series} for exactly `uid` — compared exactly, not as the
 * substring CalDAV's `text-match` uses — or an empty one when the object does
 * not hold it.
 */
export function seriesFor(vcal: ICAL.Component, uid: string): Series {
  return seriesIn(vcal).get(uid) ?? { overrides: [] };
}
