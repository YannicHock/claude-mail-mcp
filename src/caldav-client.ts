/**
 * CalDAV client wrapper around tsdav + ical.js.
 *
 * Discovers calendars on demand, lists events in a window, creates new
 * events, and computes free slots between existing busy intervals.
 *
 * v0.1 trade-off: we discover calendars on each call rather than caching,
 * because tsdav's discovery is cheap (one PROPFIND) and stale caches are
 * worse than a small extra request. v0.2 will introduce a short TTL cache.
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
  changesSomething,
  describeStoredEvent,
  icalTimeFor,
  touchesTime,
  type EventPatch,
} from "./ical-edit.js";
import { ToolRefusal } from "./tool-errors.js";

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

export interface CalendarEvent {
  uid: string;
  url: string;
  summary: string | null;
  description: string | null;
  location: string | null;
  start: string; // ISO
  end: string; // ISO
  allDay: boolean;
  organizer: string | null;
  attendees: string[];
  status: string | null;
  recurrenceId: string | null;
  /**
   * The stored object's ETag exactly as the server sent it, quotes included,
   * or null when it sent none. What `update_event` and `delete_event` take as
   * `etag` (#152, #153). Instances expanded from one series share it.
   */
  etag: string | null;
}

export interface NewEventInput {
  calendarUrl: string;
  summary: string;
  description?: string;
  location?: string;
  start: string; // ISO 8601, with timezone offset
  end: string;
  allDay?: boolean;
  attendees?: string[];
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

  async listEvents(
    calendarUrl: string,
    rangeStart: string,
    rangeEnd: string
  ): Promise<CalendarEvent[]> {
    const calendar = await this.findCalendar(calendarUrl);
    const client = await this.ensureClient();
    const objects: DAVCalendarObject[] = await client.fetchCalendarObjects({
      calendar,
      timeRange: {
        start: rangeStart,
        end: rangeEnd,
      },
      expand: true,
    });
    const events: CalendarEvent[] = [];
    for (const obj of objects) {
      if (!obj.data) continue;
      const parsed = parseICalEvents(obj.data, obj.url, obj.etag ?? null);
      events.push(...parsed);
    }
    events.sort((a, b) => a.start.localeCompare(b.start));
    return events;
  }

  async createEvent(input: NewEventInput): Promise<{ url: string; uid: string }> {
    const calendar = await this.findCalendar(input.calendarUrl);
    const client = await this.ensureClient();
    const uid = `${randomUUID()}@claude-mail-mcp`;
    const ics = buildIcs({ ...input, uid });
    const filename = `${uid}.ics`;
    const res = await client.createCalendarObject({
      calendar,
      filename,
      iCalString: ics,
    });
    assertWritten(res, "PUT");
    const base = calendar.url.endsWith("/") ? calendar.url : `${calendar.url}/`;
    return { url: `${base}${filename}`, uid };
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
    if (describeStoredEvent(stored.data, update.uid).recurring) {
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
    return { uid: update.uid, url: stored.url, etag: res.headers.get("etag") };
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
    if (describeStoredEvent(stored.data, target.uid).recurring && target.applyToSeries !== true) {
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
    });
    for (const obj of objects) {
      if (typeof obj.data === "string" && describeStoredEvent(obj.data, uid).found) {
        return { url: obj.url, etag: obj.etag ?? null, data: obj.data };
      }
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
      const events = await this.listEvents(url, rangeStart, rangeEnd);
      for (const e of events) {
        busy.push({
          start: new Date(e.start).getTime(),
          end: new Date(e.end).getTime(),
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

function parseICalEvents(icsData: string, objectUrl: string, etag: string | null): CalendarEvent[] {
  const jcal = ICAL.parse(icsData);
  const vcal = new ICAL.Component(jcal);
  const vevents = vcal.getAllSubcomponents("vevent");
  return vevents.map((ve) => {
    const event = new ICAL.Event(ve);
    const start = event.startDate;
    const end = event.endDate;
    const attendeeProps = ve.getAllProperties("attendee");
    const organizerProp = ve.getFirstProperty("organizer");
    return {
      uid: event.uid ?? "",
      url: objectUrl,
      summary: event.summary ?? null,
      description: event.description ?? null,
      location: event.location ?? null,
      start: start.toJSDate().toISOString(),
      end: end.toJSDate().toISOString(),
      allDay: Boolean(start.isDate),
      organizer: organizerProp ? String(organizerProp.getFirstValue()) : null,
      attendees: attendeeProps.map((p) => String(p.getFirstValue())),
      status: (ve.getFirstPropertyValue("status") as string | null) ?? null,
      recurrenceId: event.recurrenceId
        ? event.recurrenceId.toJSDate().toISOString()
        : null,
      etag,
    };
  });
}

function buildIcs(input: NewEventInput & { uid: string }): string {
  const cal = new ICAL.Component(["vcalendar", [], []]);
  cal.updatePropertyWithValue("prodid", "-//claude-mail-mcp//EN");
  cal.updatePropertyWithValue("version", "2.0");

  const vevent = new ICAL.Component("vevent");
  vevent.updatePropertyWithValue("uid", input.uid);
  vevent.updatePropertyWithValue(
    "dtstamp",
    ICAL.Time.fromJSDate(new Date(), true)
  );
  vevent.updatePropertyWithValue("dtstart", icalTimeFor(input.start, input.allDay === true));
  vevent.updatePropertyWithValue("dtend", icalTimeFor(input.end, input.allDay === true));
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
