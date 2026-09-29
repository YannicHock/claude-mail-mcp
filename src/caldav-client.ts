/**
 * CalDAV client wrapper around tsdav + ical.js.
 *
 * Discovers calendars on demand, lists events in a window, creates new
 * events, and computes free slots between existing busy intervals.
 *
 * v0.1 trade-off: we discover calendars on each call rather than caching,
 * because tsdav's discovery is cheap (one PROPFIND) and stale caches are
 * worse than a small extra request. v0.2 will introduce a short TTL cache.
 *
 * v0.7.4 (spec 2026-09-29 §2.2): recurrence is expanded here, not on the
 * server — `listEvents` asks for every object with an occurrence in the
 * window and src/ical-expand.ts turns each into instances. Every object the
 * server lists is read, whatever its href is called (#211.1), and one that
 * cannot be read is named in `skipped` instead of failing the calendar
 * (#211.2).
 */

import {
  createDAVClient,
  DAVCalendar,
  DAVCalendarObject,
} from "tsdav";
import ICAL from "ical.js";
import { randomUUID } from "node:crypto";
import {
  applyEventPatch,
  calendarDate,
  changesSomething,
  describeStoredEvent,
  mainSequence,
  timedBound,
  touchesTime,
  type EventPatch,
} from "./ical-edit.js";
import { expandObject, instantOfReported, type CalendarEvent } from "./ical-expand.js";
import {
  calendarZone,
  canonicalZone,
  IntlTimezone,
  isUtcName,
  timeIn,
  UTC_ZONE,
  vtimezoneFromIntl,
  type WriteZone,
} from "./ical-zones.js";
import { ToolRefusal } from "./tool-refusal.js";

// createDAVClient returns a logged-in client whose type omits the login
// methods. Capture that shape for our field types.
type AuthedDAVClient = Awaited<ReturnType<typeof createDAVClient>>;

export interface CalDavAuth {
  url: string;
  user: string;
  pass: string;
}

export interface CalendarSummary {
  url: string;
  displayName: string;
  description: string | null;
  ctag: string | null;
  timezone: string | null;
  components: string[];
}

/** An object `listEvents` could not list, and why (#211.2). */
export interface SkippedObject {
  url: string;
  reason: string;
}

export interface EventListing {
  events: CalendarEvent[];
  /** Empty when every object in the window was read. */
  skipped: SkippedObject[];
}

export interface NewEventInput {
  calendarUrl: string;
  summary: string;
  description?: string;
  location?: string;
  /** ISO 8601; with no offset, clock time in the zone the event is written in. */
  start: string;
  end: string;
  allDay?: boolean;
  attendees?: string[];
  /**
   * The IANA zone to write the event in (spec 2026-09-29 §2.5). Omitted, it is
   * the calendar's own zone when the server reports one, and UTC otherwise.
   */
  timezone?: string;
}

/** What `create_event` answers: where the event went, and the zone it was written in. */
export interface CreatedEvent {
  url: string;
  uid: string;
  /** The IANA zone, `"UTC"`, or `"floating"` for an all-day event — as `list_events` reports it. */
  timezone: string;
}

/** Which event a write is aimed at, and the guards spec §4 puts on it. */
export interface EventTarget {
  calendarUrl: string;
  uid: string;
  /** From `list_events`. Sent as If-Match; see spec §4.1 for when it may be omitted. */
  etag?: string;
  /** Present only to be refused: single occurrences are out of scope (spec §4.3). */
  recurrenceId?: string;
  /** Required to touch a recurring event at all. */
  applyToSeries?: boolean;
}

export interface EventUpdate extends EventTarget, EventPatch {}

export interface FreeSlot {
  start: string;
  end: string;
}

export class CalDavClient {
  private client: AuthedDAVClient | null = null;
  private connecting: Promise<AuthedDAVClient> | null = null;
  private readonly auth: CalDavAuth;

  constructor(auth: CalDavAuth) {
    this.auth = auth;
  }

  private async ensureClient(): Promise<AuthedDAVClient> {
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;
    this.connecting = (async (): Promise<AuthedDAVClient> => {
      const client = await createDAVClient({
        serverUrl: this.auth.url,
        credentials: {
          username: this.auth.user,
          password: this.auth.pass,
        },
        authMethod: "Basic",
        defaultAccountType: "caldav",
      });
      this.client = client;
      this.connecting = null;
      return client;
    })();
    return this.connecting;
  }

  async listCalendars(): Promise<CalendarSummary[]> {
    const client = await this.ensureClient();
    const calendars: DAVCalendar[] = await client.fetchCalendars();
    return calendars.map((cal) => ({
      url: cal.url,
      displayName:
        typeof cal.displayName === "string"
          ? cal.displayName
          : (cal.url.split("/").filter(Boolean).pop() ?? cal.url),
      description: (cal as { description?: string }).description ?? null,
      ctag: cal.ctag ?? null,
      timezone: typeof cal.timezone === "string" ? cal.timezone : null,
      components: Array.isArray(cal.components)
        ? cal.components.map(String)
        : [],
    }));
  }

  /**
   * Every instance in the window, expanded in the connector (spec §2.2).
   *
   * The query is a `calendar-query` with a `time-range` and no `expand`: the
   * server only picks the objects with an occurrence in the window, which it
   * does for every shape (R4), and returns them as stored. Asking it to
   * expand as well failed the whole REPORT on an all-day series, a floating
   * series or an override with no master (R1–R3).
   */
  async listEvents(calendarUrl: string, rangeStart: string, rangeEnd: string): Promise<EventListing> {
    const calendar = await this.findCalendar(calendarUrl);
    const client = await this.ensureClient();
    const objects: DAVCalendarObject[] = await client.fetchCalendarObjects({
      calendar,
      timeRange: {
        start: rangeStart,
        end: rangeEnd,
      },
      urlFilter: everyObjectIn(calendar),
    });
    const window = { start: Date.parse(rangeStart), end: Date.parse(rangeEnd) };
    const events: CalendarEvent[] = [];
    const skipped: SkippedObject[] = [];
    for (const obj of objects) {
      if (typeof obj.data !== "string" || obj.data === "") {
        skipped.push({ url: obj.url, reason: "The server sent no calendar data for it." });
        continue;
      }
      const expanded = expandObject(obj.data, window, { url: obj.url, etag: obj.etag ?? null });
      events.push(...expanded.instances);
      if (expanded.skipped !== undefined) skipped.push({ url: obj.url, reason: expanded.skipped });
    }
    events.sort((a, b) => instantOfReported(a.start) - instantOfReported(b.start));
    return { events, skipped };
  }

  /**
   * Write a new event. Its zone (spec 2026-09-29 §2.5) is `input.timezone`
   * when given — refused, before the server is contacted, unless it is an
   * IANA name — else the calendar's own `calendar-timezone`, so an event
   * Claude creates behaves like one made in the server's web UI, else UTC as
   * before v0.7.4. The answer says which zone it was.
   */
  async createEvent(input: NewEventInput): Promise<CreatedEvent> {
    let zone: string | null = null;
    if (input.timezone !== undefined) {
      zone = canonicalZone(input.timezone);
      if (zone === null) {
        throw new ToolRefusal(
          `"${input.timezone}" is not an IANA time zone. Pass a name like Europe/Berlin or America/New_York, or omit timezone to use the calendar's own. Nothing was created.`
        );
      }
    }
    const calendar = await this.findCalendar(input.calendarUrl);
    zone ??= calendarZone(calendar.timezone) ?? "UTC";
    const client = await this.ensureClient();
    const uid = `${randomUUID()}@claude-mail-mcp`;
    const ics = buildIcs({ ...input, uid }, zone);
    const filename = `${uid}.ics`;
    const res = await client.createCalendarObject({
      calendar,
      filename,
      iCalString: ics,
    });
    assertWritten(res, "PUT");
    const base = calendar.url.endsWith("/") ? calendar.url : `${calendar.url}/`;
    const timezone = input.allDay === true ? "floating" : isUtcName(zone) ? "UTC" : zone;
    return { url: `${base}${filename}`, uid, timezone };
  }

  /**
   * Change an existing event in place (#152). Spec §4: the caller's ETag guards
   * the write, a series needs `applyToSeries`, and everything the patch does
   * not name survives — see src/ical-edit.ts.
   */
  async updateEvent(update: EventUpdate): Promise<{ uid: string; url: string; etag: string | null }> {
    const nothingDone = "Nothing was changed, and no event was created.";
    if (update.recurrenceId !== undefined) {
      throw new ToolRefusal(
        "Changing a single occurrence of a recurring event is not supported yet: it needs an override (RECURRENCE-ID) this connector does not write. Nothing was changed. To change every occurrence, omit recurrence_id and pass apply_to_series: true."
      );
    }
    if (!changesSomething(update)) {
      throw new ToolRefusal(
        "Nothing to change: pass at least one of summary, description, location, start, end or all_day."
      );
    }
    const calendar = await this.findCalendar(update.calendarUrl);
    const stored = await this.findStoredEvent(calendar, update.uid, nothingDone);
    const shape = describeStoredEvent(stored.data, update.uid);
    if (shape.overrideOnly) {
      // #211.3: there is no master to patch, so without this the patch threw a
      // plain Error — logged as a server failure — or, without
      // apply_to_series, the call was told this is a series it can change.
      throw new ToolRefusal(
        `"${update.uid}" is a single occurrence of a series whose other occurrences are not in this calendar (an invitation to one instance, for example), and changing such an occurrence is not supported yet. Nothing was changed.`
      );
    }
    if (shape.recurring) {
      if (update.applyToSeries !== true) throw seriesRefusal(update.uid, "change");
      if (touchesTime(update)) {
        throw new ToolRefusal(
          `"${update.uid}" is a recurring series, and changing the time of a whole series is not supported yet. Nothing was changed. Its summary, description and location can be changed with apply_to_series: true.`
        );
      }
    }
    const ifMatch = requireEtag(update, stored);
    const data = applyEventPatch(stored.data, update.uid, update);
    const client = await this.ensureClient();
    const res = await client.updateCalendarObject({
      calendarObject: { url: stored.url, data, ...(ifMatch === undefined ? {} : { etag: ifMatch }) },
    });
    refuseLostRace(res, update.uid, calendar.url, nothingDone);
    assertWritten(res, "PUT");
    const etag =
      res.headers.get("etag") ??
      (await this.etagAfterWrite(calendar, update.uid, stored.url, mainSequence(data, update.uid)));
    return { uid: update.uid, url: stored.url, etag };
  }

  /**
   * The ETag of an object just written, read back with the same UID query the
   * write started from. RFC 4791 §5.3.4 lets a server answer a PUT without an
   * ETag when it stored something other than what was sent, and Nextcloud does
   * exactly that for an event it schedules — found on the v0.7.2 acceptance
   * run, where `update_event` answered `etag: null` and a second change needed
   * a `list_events` in between.
   *
   * The write has already succeeded, so this never turns it into a failure:
   * anything going wrong here is `null`, and the tool text tells the caller to
   * read the event again in that case.
   *
   * An ETag is handed back only for what is recognisably this write: the same
   * object URL, and the SEQUENCE this update just wrote. Otherwise someone
   * else's version landed in between (a phone syncing, a server applying an
   * attendee's reply that bumps it), and giving the caller *that* etag would
   * let its next update overwrite the other change unseen — `null` sends it to
   * `list_events` instead.
   */
  private async etagAfterWrite(
    calendar: DAVCalendar,
    uid: string,
    url: string,
    sequence: number | null
  ): Promise<string | null> {
    try {
      const now = await this.findStoredEvent(calendar, uid, "");
      if (now.url !== url || sequence === null || mainSequence(now.data, uid) !== sequence) return null;
      return now.etag;
    } catch {
      return null;
    }
  }

  /**
   * Delete an event, permanently (#153). The same guards as
   * {@link updateEvent}; a series is deleted whole, and only when asked to be.
   */
  async deleteEvent(target: EventTarget): Promise<{ uid: string; url: string }> {
    const nothingDone = "Nothing was deleted.";
    if (target.recurrenceId !== undefined) {
      throw new ToolRefusal(
        "Deleting a single occurrence of a recurring event is not supported yet: that is an EXDATE on the series, not a deletion. Nothing was deleted. To delete every occurrence, omit recurrence_id and pass apply_to_series: true."
      );
    }
    const calendar = await this.findCalendar(target.calendarUrl);
    const stored = await this.findStoredEvent(calendar, target.uid, nothingDone);
    const shape = describeStoredEvent(stored.data, target.uid);
    if (shape.overrideOnly && target.applyToSeries !== true) {
      // #211.3: not "every occurrence" — the object holds only this one.
      throw new ToolRefusal(
        `"${target.uid}" is a single occurrence of a series whose other occurrences are not in this calendar (an invitation to one instance, for example). Deleting it removes the whole stored object. Nothing was deleted. Pass apply_to_series: true if that is what you intend.`
      );
    }
    if (shape.recurring && target.applyToSeries !== true) {
      throw seriesRefusal(target.uid, "delete");
    }
    const ifMatch = requireEtag(target, stored);
    const client = await this.ensureClient();
    const res = await client.deleteCalendarObject({
      calendarObject: { url: stored.url, ...(ifMatch === undefined ? {} : { etag: ifMatch }) },
    });
    refuseLostRace(res, target.uid, calendar.url, nothingDone);
    assertWritten(res, "DELETE");
    return { uid: target.uid, url: stored.url };
  }

  /**
   * The stored object holding `uid`, found by a UID `calendar-query` and then
   * checked exactly: RFC 4791's text-match is a substring match (spec §4.2).
   *
   * Every object the query returns is a candidate, whatever its href is
   * called (#211.1), and one that cannot be parsed is passed over rather than
   * ending the search (#211.2): the query matched it on a substring, so the
   * exact match may well be a later one.
   */
  private async findStoredEvent(
    calendar: DAVCalendar,
    uid: string,
    nothingDone: string
  ): Promise<{ url: string; etag: string | null; data: string }> {
    const client = await this.ensureClient();
    const objects: DAVCalendarObject[] = await client.fetchCalendarObjects({
      calendar,
      filters: uidFilter(uid),
      urlFilter: everyObjectIn(calendar),
    });
    for (const obj of objects) {
      if (typeof obj.data !== "string") continue;
      let found: boolean;
      try {
        found = describeStoredEvent(obj.data, uid).found;
      } catch {
        continue;
      }
      if (found) return { url: obj.url, etag: obj.etag ?? null, data: obj.data };
    }
    throw notFound(uid, calendar.url, nothingDone);
  }

  async findFreeSlots(
    calendarUrls: string[],
    rangeStart: string,
    rangeEnd: string,
    durationMinutes: number,
    workingHours?: { startHour: number; endHour: number }
  ): Promise<FreeSlot[]> {
    const busy: Array<{ start: number; end: number }> = [];
    for (const url of calendarUrls) {
      const { events } = await this.listEvents(url, rangeStart, rangeEnd);
      for (const e of events) {
        busy.push({
          start: instantOfReported(e.start),
          end: instantOfReported(e.end),
        });
      }
    }
    busy.sort((a, b) => a.start - b.start);
    const merged: Array<{ start: number; end: number }> = [];
    for (const slot of busy) {
      const last = merged[merged.length - 1];
      if (last && slot.start <= last.end) {
        last.end = Math.max(last.end, slot.end);
      } else {
        merged.push({ ...slot });
      }
    }

    const rangeStartMs = new Date(rangeStart).getTime();
    const rangeEndMs = new Date(rangeEnd).getTime();
    const durationMs = durationMinutes * 60 * 1000;
    const free: FreeSlot[] = [];
    let cursor = rangeStartMs;

    const clampToWork = (start: number, end: number): { s: number; e: number } | null => {
      if (!workingHours) return { s: start, e: end };
      // Anchor to the day of `start` in UTC; users pass ISO with offset, so
      // working hours are interpreted in UTC. v0.2 will accept a timezone.
      const d = new Date(start);
      const dayStart = Date.UTC(
        d.getUTCFullYear(),
        d.getUTCMonth(),
        d.getUTCDate(),
        workingHours.startHour
      );
      const dayEnd = Date.UTC(
        d.getUTCFullYear(),
        d.getUTCMonth(),
        d.getUTCDate(),
        workingHours.endHour
      );
      const s = Math.max(start, dayStart);
      const e = Math.min(end, dayEnd);
      if (e - s < durationMs) return null;
      return { s, e };
    };

    for (const slot of merged) {
      if (cursor + durationMs <= slot.start) {
        const clamped = clampToWork(cursor, slot.start);
        if (clamped) {
          free.push({
            start: new Date(clamped.s).toISOString(),
            end: new Date(clamped.e).toISOString(),
          });
        }
      }
      cursor = Math.max(cursor, slot.end);
    }
    if (cursor + durationMs <= rangeEndMs) {
      const clamped = clampToWork(cursor, rangeEndMs);
      if (clamped) {
        free.push({
          start: new Date(clamped.s).toISOString(),
          end: new Date(clamped.e).toISOString(),
        });
      }
    }
    return free;
  }

  private async findCalendar(url: string): Promise<DAVCalendar> {
    const calendars = await (await this.ensureClient()).fetchCalendars();
    const match = calendars.find((c) => c.url === url || c.url.replace(/\/$/, "") === url.replace(/\/$/, ""));
    if (!match) {
      throw new Error(
        `Calendar not found: ${url}. Use list_calendars to discover available URLs.`
      );
    }
    return match;
  }
}

/**
 * tsdav's `urlFilter` for a query in `calendar`: every href except the
 * collection's own, which a server may list among the answers. tsdav's
 * default keeps only hrefs containing `.ics`, and a server that names its
 * objects without the extension then had events neither `list_events` nor
 * the UID lookup could see (#211.1, R7).
 */
function everyObjectIn(calendar: DAVCalendar): (url: string) => boolean {
  const own = calendar.url.replace(/\/+$/, "");
  return (url) => url !== "" && url.replace(/\/+$/, "") !== own;
}

/**
 * A `calendar-query` filter for one UID, in tsdav's xml-js compact form. The
 * shape mirrors tsdav's own default filter (VCALENDAR > VEVENT), with a
 * `prop-filter` where the time range would go.
 */
function uidFilter(uid: string) {
  return {
    "comp-filter": {
      _attributes: { name: "VCALENDAR" },
      "comp-filter": {
        _attributes: { name: "VEVENT" },
        "prop-filter": {
          _attributes: { name: "UID" },
          "text-match": { _attributes: { collation: "i;octet" }, _text: uid },
        },
      },
    },
  };
}

function notFound(uid: string, calendarUrl: string, nothingDone: string): ToolRefusal {
  return new ToolRefusal(`No event with UID "${uid}" in calendar ${calendarUrl}. ${nothingDone}`);
}

function seriesRefusal(uid: string, verb: "change" | "delete"): ToolRefusal {
  const done = verb === "change" ? "changed" : "deleted";
  return new ToolRefusal(
    `"${uid}" is a recurring series, so this would ${verb} every occurrence. Nothing was ${done}. Pass apply_to_series: true if that is what you intend.`
  );
}

/**
 * The If-Match value for a write, per spec §4.1: the caller's ETag when given;
 * none when the server keeps no ETag for the object; otherwise a refusal,
 * because writing blind over an object that *has* an ETag is the overwrite
 * #152 exists to prevent.
 */
export function requireEtag(target: EventTarget, stored: { etag: string | null }): string | undefined {
  if (target.etag !== undefined) return target.etag;
  if (stored.etag === null) return undefined;
  throw new ToolRefusal(
    `Pass the etag list_events returned for "${target.uid}", so a change made elsewhere since you read it is not overwritten. Nothing was written.`
  );
}

/**
 * 412 and 404 on a guarded write are answers about the event, not server
 * failures: someone else changed it, or it went away, since it was read.
 */
function refuseLostRace(res: Response, uid: string, calendarUrl: string, nothingDone: string): void {
  if (res.status === 412) {
    throw new ToolRefusal(
      `The event "${uid}" changed after you read it. ${nothingDone} Call list_events again for its current state and etag, then retry.`
    );
  }
  if (res.status === 404) throw notFound(uid, calendarUrl, nothingDone);
}

/**
 * tsdav returns the raw Response for every write and throws on none of them,
 * which is how `create_event` came to report success for a 403 (spec §0).
 * Any other non-2xx is a server failure and goes through reportingFailures().
 */
export function assertWritten(res: Response, method: string): void {
  if (!res.ok) {
    throw new Error(`CalDAV server answered ${res.status} ${res.statusText}`.trim() + ` to ${method}`);
  }
}

/** How far either side of a new event its generated VTIMEZONE reaches (spec §2.5 A). */
const VTIMEZONE_MARGIN_MS = 366 * 86_400_000;

/**
 * The object `create_event` writes, in the IANA zone `zone` (spec 2026-09-29
 * §2.5): UTC (`…Z`, and no VTIMEZONE, as before v0.7.4) when `zone` is UTC,
 * and otherwise `TZID=zone` local time with a VTIMEZONE {@link
 * vtimezoneFromIntl} generates for the event's span and a year either side. A
 * time given without an offset is clock time in `zone`. An all-day event is
 * dates whatever the zone.
 *
 * Throws {@link ToolRefusal} for a start or end it cannot read.
 */
export function buildIcs(input: NewEventInput & { uid: string }, zone: string, now: Date = new Date()): string {
  const nothingDone = "Nothing was created.";
  const cal = new ICAL.Component(["vcalendar", [], []]);
  cal.updatePropertyWithValue("prodid", "-//claude-mail-mcp//EN");
  cal.updatePropertyWithValue("version", "2.0");

  const vevent = new ICAL.Component("vevent");
  vevent.updatePropertyWithValue("uid", input.uid);
  vevent.updatePropertyWithValue("dtstamp", ICAL.Time.fromJSDate(now, true));
  if (input.allDay === true) {
    vevent.updatePropertyWithValue("dtstart", ICAL.Time.fromDateString(calendarDate("start", input.start, nothingDone)));
    vevent.updatePropertyWithValue("dtend", ICAL.Time.fromDateString(calendarDate("end", input.end, nothingDone)));
  } else {
    const target: WriteZone = isUtcName(zone)
      ? UTC_ZONE
      : { kind: "zoned", tzid: zone, zone: new IntlTimezone(zone, zone) };
    const startMs = timedBound("start", input.start, target, nothingDone);
    const endMs = timedBound("end", input.end, target, nothingDone);
    for (const [name, ms] of [["dtstart", startMs], ["dtend", endMs]] as const) {
      const prop = new ICAL.Property(name);
      prop.setValue(timeIn(ms, target));
      if (target.kind === "zoned") prop.setParameter("tzid", target.tzid);
      vevent.addProperty(prop);
    }
    if (target.kind === "zoned") {
      const from = Math.min(startMs, endMs) - VTIMEZONE_MARGIN_MS;
      const to = Math.max(startMs, endMs) + VTIMEZONE_MARGIN_MS;
      cal.addSubcomponent(new ICAL.Component(ICAL.parse(vtimezoneFromIntl(zone, from, to))));
    }
  }
  vevent.updatePropertyWithValue("summary", input.summary);
  if (input.description) {
    vevent.updatePropertyWithValue("description", input.description);
  }
  if (input.location) {
    vevent.updatePropertyWithValue("location", input.location);
  }
  for (const a of input.attendees ?? []) {
    const prop = new ICAL.Property("attendee");
    prop.setValue(a.startsWith("mailto:") ? a : `mailto:${a}`);
    vevent.addProperty(prop);
  }
  cal.addSubcomponent(vevent);
  return cal.toString();
}
