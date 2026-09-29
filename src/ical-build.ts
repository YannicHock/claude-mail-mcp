/**
 * The one iCalendar object this connector writes from nothing: the event
 * `create_event` makes. No network access — `CalDavClient` PUTs what
 * {@link buildIcs} returns — and the counterpart of src/ical-edit.ts, which
 * changes an object someone else wrote and never builds one.
 *
 * It lived in src/caldav-client.ts until the code-health review of PR 3:
 * the network class carried a pure iCalendar builder, and assembled the
 * zone the builder wrote in by hand. The zone now comes from
 * `zonedWriteZone` (src/ical-zones.ts), and the name `create_event` answers
 * with is read back off the built object by {@link builtZoneName}, the way
 * `list_events` reads any event's, instead of being worked out a second time.
 */

import ICAL from "ical.js";
import { calendarDate, distinctAddresses, mailtoOf, notifyChoice, timedBound } from "./ical-input.js";
import { parseCalendar } from "./ical-parse.js";
import { generatedVtimezone, writtenTime, zonedWriteZone, zoneNameOf } from "./ical-zones.js";
import { ToolRefusal } from "./tool-refusal.js";

/** What `create_event` is given for the event itself; `CalDavClient` adds the calendar and the zone. */
export interface NewEventFields {
  summary: string;
  description?: string;
  location?: string;
  /** ISO 8601; with no offset, clock time in the zone the event is written in. */
  start: string;
  end: string;
  allDay?: boolean;
  attendees?: string[];
  /**
   * Whether the calendar server may mail the attendees (spec 2026-09-29
   * §2.1): `false` marks each `SCHEDULE-AGENT=CLIENT`. Required when
   * `attendees` is non-empty.
   */
  notifyAttendees?: boolean;
}

/**
 * The object `create_event` writes, in the IANA zone `zone` (spec 2026-09-29
 * §2.5): UTC (`…Z`, and no VTIMEZONE, as before v0.7.4) when `zone` is UTC,
 * and otherwise `TZID=zone` local time with a VTIMEZONE `generatedVtimezone`
 * makes for the event's span and a year either side — marked as this
 * connector's, so `update_event` regenerates it when the event moves outside
 * that span (review of #224). A time given without an offset is clock time
 * in `zone`. An all-day event is dates whatever the zone.
 *
 * A bound on the second pass through an autumn overlap is written in UTC:
 * as a wall time it would mean the first pass, an hour earlier, and could
 * land before the start (see `writtenTime` in src/ical-zones.ts).
 *
 * Attendees (#204, spec 2026-09-29 §2.1): an event with any is written with
 * `ORGANIZER:<organizer>` — the account's own address, the first of
 * `ownAddresses` in src/caldav-client.ts — since RFC 5545 expects one
 * wherever there are attendees, and without it a scheduling server such as
 * Nextcloud does not treat the event as a meeting at all. Each attendee is a
 * bare `mailto:`; with `notifyAttendees: false` each carries
 * `SCHEDULE-AGENT=CLIENT` (RFC 6638 §7.1), which asks the server to send it
 * nothing. With `true` the server is free to mail them an invitation. An
 * event with no attendees gets no ORGANIZER, as before.
 *
 * Throws {@link ToolRefusal} ending in `nothingDone` for a start or end it
 * cannot read, for an end at or before the start — which until the review
 * of #224 was written as it was given, an event every client shows with no
 * length or backwards — for attendees without `notifyAttendees`, and for one
 * address listed twice.
 */
export function buildIcs(
  input: NewEventFields & { uid: string; organizer?: string },
  zone: string,
  nothingDone: string,
  now: Date = new Date()
): string {
  const attendees = input.attendees ?? [];
  const notify = attendees.length > 0 ? notifyChoice(input.notifyAttendees, nothingDone) : true;
  distinctAddresses(attendees, nothingDone);
  if (attendees.length > 0 && input.organizer === undefined) {
    throw new Error("buildIcs: attendees need the account's address as ORGANIZER");
  }
  const cal = new ICAL.Component(["vcalendar", [], []]);
  cal.updatePropertyWithValue("prodid", "-//claude-mail-mcp//EN");
  cal.updatePropertyWithValue("version", "2.0");

  const vevent = new ICAL.Component("vevent");
  vevent.updatePropertyWithValue("uid", input.uid);
  vevent.updatePropertyWithValue("dtstamp", ICAL.Time.fromJSDate(now, true));
  if (input.allDay === true) {
    const start = calendarDate("start", input.start, nothingDone);
    const end = calendarDate("end", input.end, nothingDone);
    if (end <= start) {
      throw new ToolRefusal(
        `The event would end (${end}) on or before it starts (${start}). For an all-day event the end date is exclusive: a one-day event on ${start} ends the day after. ${nothingDone}`
      );
    }
    vevent.updatePropertyWithValue("dtstart", ICAL.Time.fromDateString(start));
    vevent.updatePropertyWithValue("dtend", ICAL.Time.fromDateString(end));
  } else {
    const target = zonedWriteZone(zone);
    const startMs = timedBound("start", input.start, target, nothingDone);
    const endMs = timedBound("end", input.end, target, nothingDone);
    if (endMs <= startMs) {
      throw new ToolRefusal(
        `The event would end (${new Date(endMs).toISOString()}) at or before it starts (${new Date(startMs).toISOString()}). ${nothingDone}`
      );
    }
    for (const [name, ms] of [["dtstart", startMs], ["dtend", endMs]] as const) {
      const written = writtenTime(ms, target);
      const prop = new ICAL.Property(name);
      prop.setValue(written.time);
      if (written.zone.kind === "zoned") prop.setParameter("tzid", written.zone.tzid);
      vevent.addProperty(prop);
    }
    if (target.kind === "zoned") cal.addSubcomponent(generatedVtimezone(zone, [startMs, endMs]));
  }
  vevent.updatePropertyWithValue("summary", input.summary);
  if (input.description) {
    vevent.updatePropertyWithValue("description", input.description);
  }
  if (input.location) {
    vevent.updatePropertyWithValue("location", input.location);
  }
  if (attendees.length > 0 && input.organizer !== undefined) {
    const organizer = new ICAL.Property("organizer");
    organizer.setValue(mailtoOf(input.organizer));
    vevent.addProperty(organizer);
  }
  for (const a of attendees) {
    const prop = new ICAL.Property("attendee");
    prop.setValue(mailtoOf(a));
    if (!notify) prop.setParameter("schedule-agent", "CLIENT");
    vevent.addProperty(prop);
  }
  cal.addSubcomponent(vevent);
  return cal.toString();
}

/**
 * The `timezone` `create_event` answers with: the zone of the built event's
 * DTSTART as `list_events` will report it — the IANA name, `"UTC"`, or
 * `"floating"` for an all-day event. Read off the object rather than worked
 * out beside it, so the answer and the next `list_events` cannot disagree;
 * a start on the second pass through an autumn overlap, written in UTC, is
 * `"UTC"` in both.
 */
export function builtZoneName(ics: string): string {
  const start = parseCalendar(ics).vcal.getFirstSubcomponent("vevent")?.getFirstPropertyValue("dtstart");
  if (!(start instanceof ICAL.Time)) throw new Error("builtZoneName: the built object has no DTSTART");
  return zoneNameOf(start);
}
