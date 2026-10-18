/**
 * Reading and editing a stored iCalendar object, for `update_event` and
 * `delete_event` (#152, #153). No network access: `CalDavClient` fetches and
 * writes, this module decides what the new object says.
 *
 * The one rule everything here serves: **an update edits the stored object, it
 * does not rebuild it.** The object is parsed, the main VEVENT for the UID is
 * changed in place, and the whole thing is serialised again — so VTIMEZONE,
 * VALARM, ATTENDEE with all its parameters, ORGANIZER, X- properties and any
 * override VEVENTs come out as they went in. Rebuilding from the fields this
 * connector models would silently drop every one of them, which #152 names as
 * the failure mode to design against.
 *
 * See docs/planning/specs/2026-09-28-v0.7.2-the-other-half-of-the-calendar.md §4.
 *
 * v0.7.4 (spec 2026-09-29 §2.5, #208, #209): that includes the event's zone.
 * A new time goes back in the zone the old one was stored in, through the
 * writing half of src/ical-zones.ts, and the object is read through
 * `parseCalendar` exactly as `list_events` reads it — so a TZID with no
 * VTIMEZONE is Berlin to both, not Berlin to one and floating to the other.
 *
 * Two conventions since the code-health review of PR 3. Every refusal here
 * ends in the `nothingDone` its caller passes — "Nothing was changed.",
 * "Nothing was deleted.", "Nothing was created." — rather than a sentence
 * this module picks for it. And an edit takes the caller's one parse of the
 * stored text (`ParsedCalendar`), changes it in place, and hands back the
 * text to write: a write parses the stored object once.
 *
 * What lives where since the code-health review of PR #229, which split this
 * module before the attendee edits land in it:
 *
 *   - here: what a patch is checked for, the read-back by its
 *     {@link WriteMark}, and {@link applyEventPatch}, the edit of a main
 *     event;
 *   - src/ical-edit-kit.ts (#234): the patch itself, and the edit of one
 *     VEVENT — `patchText`, `patchTimes`, `stampRevision`, and the one
 *     writer of a time property under them, `writeTimeProp` — that every
 *     writer here uses for whichever VEVENT it changes;
 *   - src/ical-attendees.ts (#204, #205, spec 2026-09-29 §2.1): a guest list
 *     changed, which every writer here calls the way it calls
 *     {@link patchText}. Those are the edits that decide whether a calendar
 *     server mails real people, and they live on their own so that the
 *     worker can read a guest list without importing an editor;
 *   - src/ical-occurrence-edit.ts: one occurrence of a series changed or
 *     deleted (#206);
 *   - src/ical-series-shift.ts: a whole series moved to a new time (#207);
 *   - src/ical-input.ts: a caller's date or time read, shared with
 *     `create_event`'s builder (src/ical-build.ts);
 *   - src/ical-series.ts: which VEVENT is which occurrence and which counts,
 *     shared with the reader (src/ical-expand.ts), which this module no
 *     longer imports.
 */

import { patchSeriesAttendees, touchesAttendees } from "./ical-attendees.js";
import {
  mayNotifyOf,
  patchText,
  patchTimes,
  stampOthers,
  stampRevision,
  withReadableZones,
  type EditContext,
  type EditResult,
  type EventPatch,
  type WriteMark,
} from "./ical-edit-kit.js";
import { parseCalendar, seriesFor, type ParsedCalendar, type Series } from "./ical-parse.js";
import { allDaySeries, currentOverrides, sequenceOf } from "./ical-series.js";

export interface StoredEventShape {
  /** Some VEVENT in the object carries exactly this UID. */
  found: boolean;
  /** RRULE or RDATE on the main VEVENT, or any VEVENT with a RECURRENCE-ID. */
  recurring: boolean;
  /**
   * Only overrides for the UID, no main VEVENT: one occurrence of a series
   * that lives elsewhere, as an invitation to a single instance is stored
   * (#211.3, R3). `recurring` is true for it as well.
   */
  overrideOnly: boolean;
}

/** True when the patch touches the event's time, which a series refuses (§4.3). */
export function touchesTime(patch: EventPatch): boolean {
  return patch.start !== undefined || patch.end !== undefined || patch.allDay !== undefined;
}

/** True when the patch changes anything at all. */
export function changesSomething(patch: EventPatch): boolean {
  return (
    patch.summary !== undefined ||
    patch.description !== undefined ||
    patch.location !== undefined ||
    touchesTime(patch) ||
    touchesAttendees(patch)
  );
}

/**
 * What one UID's VEVENTs are, for the checks that come before any write. The
 * caller has found them with `seriesFor` (src/ical-parse.ts), which compares
 * the UID exactly: the server-side lookup is a CalDAV `text-match`, which
 * RFC 4791 defines as a substring match, so the object it hands back for
 * `ev1` may be `ev10`'s. `found` is false for that one.
 */
export function describeSeries({ master, overrides }: Series): StoredEventShape {
  if (master === undefined && overrides.length === 0) {
    return { found: false, recurring: false, overrideOnly: false };
  }
  const recurring =
    overrides.length > 0 || master?.hasProperty("rrule") === true || master?.hasProperty("rdate") === true;
  return { found: true, recurring, overrideOnly: master === undefined };
}

/**
 * True when `ics` still holds the version `mark` describes: the VEVENT the
 * write changed — the main one, or the current override of the occurrence
 * it names — carries the SEQUENCE the write gave it. False for an object that
 * no longer holds it, or that cannot be read.
 */
export function writtenBy(ics: string, mark: WriteMark): boolean {
  try {
    const { master, overrides } = seriesFor(parseCalendar(ics).vcal, mark.uid);
    if (mark.override === undefined) return master !== undefined && sequenceOf(master) === mark.sequence;
    const current = currentOverrides(overrides, allDaySeries(master)).get(mark.override);
    return current !== undefined && sequenceOf(current.ve) === mark.sequence;
  } catch {
    return false;
  }
}

/**
 * Apply `patch` to the main VEVENT of `uid` in `parsed` — an object read by
 * `parseCalendar` (src/ical-parse.ts), which the caller has already used to
 * establish that the UID is there — and return the new object with its
 * {@link WriteMark}. `parsed` is changed in place: it is the caller's one
 * parse of the stored text, for this one write (code-health review of PR 3:
 * a write parsed the same text three times).
 *
 * The attendees first, by `patchSeriesAttendees` (src/ical-attendees.ts) —
 * so its refusals come before anything is changed — then the text fields as
 * given and the time by `patchTimes` (src/ical-edit-kit.ts); the VEVENT's
 * revision is stamped, and that of every other VEVENT the attendee change
 * wrote. Throws `ToolRefusal` ending in `ctx.nothingDone` for a patch that
 * cannot be applied as asked.
 */
export function applyEventPatch(parsed: ParsedCalendar, uid: string, patch: EventPatch, ctx: EditContext): EditResult {
  const { nothingDone, now, own } = ctx;
  const { vcal } = parsed;
  const { master, overrides } = seriesFor(vcal, uid);
  if (master === undefined) {
    throw new Error(`applyEventPatch: no main VEVENT for UID ${uid}`);
  }
  return withReadableZones(nothingDone, () => {
    const guests = patchSeriesAttendees(master, overrides, patch, own, nothingDone);
    patchText(master, patch);
    if (touchesTime(patch)) patchTimes(master, patch, nothingDone);
    const sequence = stampRevision(master, now);
    stampOthers(guests, master, now);
    return { ics: vcal.toString(), mark: { uid, sequence }, ...mayNotifyOf(guests, [master, ...overrides], own) };
  });
}
