/**
 * One occurrence of a series changed or deleted (#206, spec 2026-09-29
 * §2.3), for `update_event` and `delete_event` with a `recurrence_id`. No
 * network access, and no recurrence rule walked: the occurrence arrives as
 * `findOccurrence` (src/ical-expand.ts) found it in a worker — plain data,
 * its original start and the overrides that replace it — and this module
 * writes what that finding says into the caller's one parse of the same text.
 *
 * The rules of src/ical-edit.ts hold here too — the stored object is edited
 * in place, never rebuilt; every refusal ends in the caller's `nothingDone`;
 * a written VEVENT has its revision stamped — and its `applyAttendeePatch`,
 * `patchText`, `patchTimes` and `stampRevision` are what change an override,
 * exactly as they change a main event.
 *
 * Split out of src/ical-edit.ts in the code-health review of PR #229, which
 * also found the one-occurrence writes ignoring `RANGE=THISANDFUTURE`: the
 * last part of this module keeps such an override's change reaching exactly
 * the occurrences it reached before.
 */

import ICAL from "ical.js";
import {
  applyAttendeePatch,
  patchText,
  patchTimes,
  stampRevision,
  touchesTime,
  type EditResult,
  type EventPatch,
} from "./ical-edit.js";
import type { FoundOccurrence } from "./ical-expand.js";
import { seriesFor, type ParsedCalendar } from "./ical-parse.js";
import { allDaySeries, keyOf, modifiesFuture, sequenceOf } from "./ical-series.js";
import { ToolRefusal } from "./tool-refusal.js";

/**
 * The time `occurrence` started at, as a value for a RECURRENCE-ID or an
 * EXDATE beside `master`: its clock fields (as `findOccurrence` handed them
 * back) in the zone object of the master's own DTSTART, so it is written in
 * the master's value type and zone (spec 2026-09-29 §2.3) — a date for an
 * all-day series, `TZID=…` local time for a zoned one, `…Z` for a UTC one,
 * and clock time for a floating one. Nothing is converted: the fields are
 * the ones the recurrence rule produced.
 */
function originalStart(
  master: ICAL.Component,
  occurrence: Pick<FoundOccurrence, "wall" | "isDate">
): { time: ICAL.Time; tzid: string | null } {
  const startProp = master.getFirstProperty("dtstart") as ICAL.Property;
  const start = startProp.getFirstValue() as ICAL.Time;
  const time = ICAL.Time.fromData({ ...occurrence.wall, isDate: occurrence.isDate }, start.zone);
  const tzid = startProp.getParameter("tzid");
  return { time, tzid: occurrence.isDate || tzid === undefined ? null : String(tzid) };
}

/**
 * A copy of the VEVENT `ve` to add beside it — every property, parameter and
 * VALARM — whose DTSTART, DTEND and RECURRENCE-ID keep the zones they were
 * read in. A copy through `toJSON` alone would not: a TZID with no VTIMEZONE
 * is placed through `Intl` by `parseCalendar` on the parsed times, not in the
 * text, and the copy's times read as a zone nothing can place.
 */
function copyOf(ve: ICAL.Component): ICAL.Component {
  const copy = new ICAL.Component(structuredClone(ve.toJSON()));
  for (const name of ["dtstart", "dtend", "recurrence-id"]) {
    const from = ve.getFirstProperty(name);
    const to = copy.getFirstProperty(name);
    const value = from?.getFirstValue();
    if (to !== null && value instanceof ICAL.Time) to.setValue(value.clone());
  }
  return copy;
}

/** A property `name` holding `time`, with `tzid` when it has one. */
function timeProperty(name: string, time: ICAL.Time, tzid: string | null): ICAL.Property {
  const prop = new ICAL.Property(name);
  prop.setValue(time);
  if (tzid !== null) prop.setParameter("tzid", tzid);
  return prop;
}

/**
 * A new override VEVENT for `occurrence`, made from `master` (spec §2.3): a
 * copy of it — so VALARM, ATTENDEE with its parameters, ORGANIZER and every
 * X- property come along, as another client's override would carry them —
 * with RRULE, RDATE, EXDATE and EXRULE removed, `RECURRENCE-ID` set to the
 * occurrence's original start in the master's type and zone, and the
 * occurrence's own start and end: the start that RECURRENCE-ID names, and
 * the end `list_events` showed for it (the master's length added to the
 * start's clock, as ical.js expands it), in the start's zone. A DURATION
 * stays a DURATION. Its SEQUENCE starts at the master's; the edit then
 * raises it, so the override has a revision of its own.
 */
function overrideFrom(master: ICAL.Component, occurrence: FoundOccurrence): ICAL.Component {
  const copy = copyOf(master);
  for (const name of ["rrule", "rdate", "exdate", "exrule"]) copy.removeAllProperties(name);
  const { time, tzid } = originalStart(master, occurrence);
  const start = copy.getFirstProperty("dtstart") as ICAL.Property;
  start.setValue(time.clone());
  copy.addProperty(timeProperty("recurrence-id", time.clone(), tzid));
  const end = copy.getFirstProperty("dtend");
  if (end !== null) {
    const until = time.clone();
    until.addDuration(new ICAL.Event(master).duration);
    end.setValue(until);
    if (tzid === null) end.removeParameter("tzid");
    else end.setParameter("tzid", tzid);
  }
  copy.updatePropertyWithValue("sequence", sequenceOf(master));
  return copy;
}

/**
 * Where ical.js lists the occurrence whose rule start is `occurrenceStart`
 * when the `RANGE=THISANDFUTURE` override `range` reaches it, worked out
 * exactly as its `getOccurrenceDetails` does, so that what is written is what
 * `list_events` showed: the override's start minus its RECURRENCE-ID, read
 * in the override's start zone, added to the occurrence's clock fields in
 * that zone, and the override's length after that. Arithmetic on one
 * override — no recurrence rule is walked here (src/ical-worker-ops.ts).
 */
function rangeShifted(range: ICAL.Component, occurrenceStart: ICAL.Time): { start: ICAL.Time; end: ICAL.Time } {
  const event = new ICAL.Event(range);
  const original = event.recurrenceId.clone();
  const moved = event.startDate.clone();
  original.zone = moved.zone;
  const diff = moved.subtractDate(original);
  const start = occurrenceStart.clone();
  start.zone = event.startDate.zone;
  start.addDuration(diff);
  const end = start.clone();
  end.addDuration(event.duration);
  return { start, end };
}

/**
 * Put `ve` — an override — at `start`/`end`: DTSTART takes `start`, keeping
 * its TZID (the zone `start` is in), and DTEND, when it has one, `end` in the
 * same zone. A DURATION is left alone: the length is the override's own.
 */
function placeOverride(ve: ICAL.Component, start: ICAL.Time, end: ICAL.Time): void {
  const startProp = ve.getFirstProperty("dtstart") as ICAL.Property;
  startProp.setValue(start.clone());
  const endProp = ve.getFirstProperty("dtend");
  if (endProp === null) return;
  endProp.setValue(end.clone());
  const tzid = startProp.getParameter("tzid");
  if (tzid === undefined || start.isDate) endProp.removeParameter("tzid");
  else endProp.setParameter("tzid", String(tzid));
}

/** `ve`'s RECURRENCE-ID replaced by one for `time` in `tzid`, with `RANGE=THISANDFUTURE` when `range` says so. */
function setRecurrenceId(ve: ICAL.Component, time: ICAL.Time, tzid: string | null, range: boolean): void {
  ve.removeAllProperties("recurrence-id");
  const prop = timeProperty("recurrence-id", time.clone(), tzid);
  if (range) prop.setParameter("range", "THISANDFUTURE");
  ve.addProperty(prop);
}

/**
 * A new override for `occurrence`, which the `RANGE=THISANDFUTURE` override
 * `range` of an earlier occurrence reaches: made from the occurrence as
 * `list_events` listed it (fix-pass review of PR #229) — a copy of `range`,
 * whose properties it was listed with, at the start and end that override
 * gave it ({@link rangeShifted}), with its own RECURRENCE-ID in the master's
 * type and zone and no RANGE: it changes this occurrence, and only this one.
 * Copying the master instead put it back at the series' old time and title.
 */
function overrideFromRange(master: ICAL.Component, range: ICAL.Component, occurrence: FoundOccurrence): ICAL.Component {
  const copy = copyOf(range);
  const { time, tzid } = originalStart(master, occurrence);
  const { start, end } = rangeShifted(range, time);
  setRecurrenceId(copy, time, tzid, false);
  placeOverride(copy, start, end);
  return copy;
}

/**
 * Take the occurrence a `RANGE=THISANDFUTURE` override `range` starts at out
 * of that override's reach, leaving every later occurrence as it was listed
 * (fix-pass review of PR #229) — for changing or deleting that one
 * occurrence alone. Returns a plain override for it, a copy of `range` with
 * no RANGE, already in `vcal`, for a change to be applied to; a deletion
 * removes it again.
 *
 * `range` itself moves on to the series' next occurrence: its RECURRENCE-ID
 * becomes that occurrence's original start (RANGE kept), and its DTSTART and
 * DTEND the times it gave that occurrence ({@link rangeShifted}) — so its
 * change still starts there and reaches every one after. Its revision is
 * stamped. When there is no next occurrence, nothing further is reached, and
 * `range` itself becomes the plain override.
 *
 * Refused, ending in `nothingDone`, when this cannot be done faithfully: the
 * next occurrence has an override of its own — which the moved RECURRENCE-ID
 * would collide with — or the walk that found the occurrence could not say
 * what the next one is.
 */
function detachRangeAnchor(
  vcal: ICAL.Component,
  master: ICAL.Component,
  range: ICAL.Component,
  occurrence: FoundOccurrence,
  nothingDone: string,
  now: Date
): ICAL.Component {
  const { next } = occurrence;
  if (next === null) {
    range.getFirstProperty("recurrence-id")?.removeParameter("range");
    return range;
  }
  if (next === "unknown" || next.overridden) {
    const why =
      next === "unknown"
        ? "the occurrence after it could not be found"
        : "the occurrence after it has changes of its own";
    throw new ToolRefusal(
      `The occurrence "${occurrence.recurrenceId}" is where another calendar app's change to "this and all following occurrences" begins (RANGE=THISANDFUTURE), and ${why}, so this connector cannot change that one occurrence without also changing every later one. To change only this occurrence, use the calendar app that made that change. ${nothingDone}`
    );
  }
  const plain = copyOf(range);
  plain.getFirstProperty("recurrence-id")?.removeParameter("range");
  const { time, tzid } = originalStart(master, { wall: next.wall, isDate: occurrence.isDate });
  const { start, end } = rangeShifted(range, time);
  setRecurrenceId(range, time, tzid, true);
  placeOverride(range, start, end);
  stampRevision(range, now);
  vcal.addSubcomponent(plain);
  return plain;
}

/** The VEVENT at `index` in `vcal` (document order), which `findOccurrence` named as an override of `uid`. */
function overrideAt(vcal: ICAL.Component, uid: string, index: number): ICAL.Component {
  const ve = vcal.getAllSubcomponents("vevent")[index];
  if (ve === undefined || String(ve.getFirstPropertyValue("uid")) !== uid || !ve.hasProperty("recurrence-id")) {
    throw new Error(`VEVENT ${index} is not an override of ${uid}`);
  }
  return ve;
}

/**
 * Change one occurrence of `uid`'s series (#206, spec 2026-09-29 §2.3), the
 * one `findOccurrence` (src/ical-expand.ts) found in the same stored text
 * `parsed` was read from.
 *
 * The occurrence's override VEVENT is edited if it has one — the current
 * one, of several revisions — and otherwise one is made from the master
 * ({@link overrideFrom}) and added to the object. Either way the patch is
 * applied to the override alone, with the time logic the main event gets
 * ({@link patchTimes}), and its revision stamped; the master and every other
 * override are left exactly as they were. An object with no master (an
 * invitation to one instance, #211.3) is edited the same way.
 *
 * `RANGE=THISANDFUTURE` (fix-pass review of PR #229): a change another
 * client made to "this and all following occurrences" is an override whose
 * change reaches every later occurrence too, and this writes one occurrence
 * all the same. An occurrence it reaches gets its new override from the
 * occurrence as listed — that override's properties and times, never its
 * RANGE ({@link overrideFromRange}) — and the occurrence it starts at is
 * taken out of its reach before the patch is applied
 * ({@link detachRangeAnchor}), or the refusal that explains why it cannot be.
 *
 * Attendees (#205): `add_attendees` and `remove_attendees` change this
 * occurrence's guest list alone — the override's ATTENDEEs, which it took
 * from the master when it was made — through {@link applyAttendeePatch},
 * with `own` the account's calendar user addresses. An invitation to one
 * instance of someone else's series is refused there, as their meeting.
 *
 * Refused, ending in `nothingDone`: switching one occurrence between all-day
 * and timed — it keeps the form of its series, whose RECURRENCE-ID must
 * match the master's — whatever {@link applyAttendeePatch} refuses, and
 * whatever {@link patchTimes} refuses.
 */
export function applyOccurrencePatch(
  parsed: ParsedCalendar,
  uid: string,
  occurrence: FoundOccurrence,
  patch: EventPatch,
  nothingDone: string,
  now: Date = new Date(),
  own: readonly string[] = []
): EditResult {
  const { vcal } = parsed;
  if (patch.allDay !== undefined && patch.allDay !== occurrence.isDate) {
    throw new ToolRefusal(
      `One occurrence of a series cannot be switched between all-day and timed: it keeps the form of its series. ${nothingDone}`
    );
  }
  const { master } = seriesFor(vcal, uid);
  let target: ICAL.Component;
  if (occurrence.current !== null) {
    target = overrideAt(vcal, uid, occurrence.current);
    // The override of the occurrence a THISANDFUTURE change starts at: its
    // changes reach every later one, so this one is taken out of it first.
    if (master !== undefined && modifiesFuture(target)) {
      target = detachRangeAnchor(vcal, master, target, occurrence, nothingDone, now);
    }
  } else {
    if (master === undefined) throw new Error(`applyOccurrencePatch: no main VEVENT for UID ${uid} to copy`);
    target =
      occurrence.range === null
        ? overrideFrom(master, occurrence)
        : overrideFromRange(master, overrideAt(vcal, uid, occurrence.range), occurrence);
    vcal.addSubcomponent(target);
  }
  applyAttendeePatch(target, patch, own, nothingDone);
  patchText(target, patch);
  if (touchesTime(patch)) patchTimes(target, patch, nothingDone);
  const sequence = stampRevision(target, now);
  const override = keyOf(new ICAL.Event(target).recurrenceId, allDaySeries(master));
  return { ics: vcal.toString(), mark: { uid, sequence, override } };
}

/**
 * Delete one occurrence of `uid`'s series (#206, spec §2.3), the one
 * `findOccurrence` found: an `EXDATE` for it on the master, in the master's
 * value type and zone ({@link originalStart}), every override of it removed,
 * and the master's revision stamped. The object itself is kept even when this
 * was the series' last occurrence; `seriesEmpty` says so, for the answer.
 *
 * An object with no master has no series to exclude from: the occurrence's
 * overrides are removed and nothing else. It is the caller's to delete the
 * object outright when that leaves it empty, and the result then has no
 * mark to read back by (`mark: null`), since no VEVENT left was written.
 *
 * `RANGE=THISANDFUTURE` (fix-pass review of PR #229): an occurrence such an
 * override of an earlier one reaches has no override of its own, and just
 * gets its EXDATE; the override is never removed for it. The occurrence the
 * override starts at is taken out of its reach first
 * ({@link detachRangeAnchor}), so the change still reaches every later
 * occurrence — it used to be removed as that occurrence's override, and every
 * later occurrence went back to the series' old time and title. That is the
 * one refusal here, ending in `nothingDone`.
 */
export function excludeOccurrence(
  parsed: ParsedCalendar,
  uid: string,
  occurrence: FoundOccurrence,
  nothingDone: string,
  now: Date = new Date()
): EditResult & { seriesEmpty: boolean } {
  const { vcal } = parsed;
  const { master } = seriesFor(vcal, uid);
  const vevents = vcal.getAllSubcomponents("vevent");
  let removed = occurrence.overrides.map((index) => vevents[index]);
  const current = occurrence.current === null ? undefined : overrideAt(vcal, uid, occurrence.current);
  if (master !== undefined && current !== undefined && modifiesFuture(current)) {
    // The occurrence a THISANDFUTURE change starts at: that change moves on
    // to the next occurrence rather than going with this one, so every later
    // occurrence stays as it was listed.
    const detached = detachRangeAnchor(vcal, master, current, occurrence, nothingDone, now);
    if (detached !== current) removed = [...removed.filter((ve) => ve !== current), detached];
  }
  for (const ve of removed) vcal.removeSubcomponent(ve);
  const seriesEmpty = !occurrence.others;
  if (master === undefined) return { ics: vcal.toString(), mark: null, seriesEmpty };
  const { time, tzid } = originalStart(master, occurrence);
  master.addProperty(timeProperty("exdate", time, tzid));
  const sequence = stampRevision(master, now);
  return { ics: vcal.toString(), mark: { uid, sequence }, seriesEmpty };
}
