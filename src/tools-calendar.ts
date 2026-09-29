/**
 * Calendar tool registry (v0.2).
 *
 * Calendar tools are registered for any account that has CalDAV configured.
 * Each tool accepts an optional `account` parameter selecting which mailbox's
 * calendar to act on. If the resolved account has no CalDAV, the tool
 * surfaces a clear error rather than silently failing.
 *
 * Times given to a tool are ISO 8601 with timezone offset (e.g.
 * 2026-05-22T09:00:00+02:00), or `YYYY-MM-DD` for an all-day event. Times
 * `list_events` reports are UTC instants, `YYYY-MM-DD` for an all-day event,
 * and clock time with no offset for a floating one, beside the event's
 * `timezone` (v0.7.4, spec 2026-09-29 §2.5).
 *
 * A time written keeps a zone (v0.7.4, #208, #209): `update_event` writes a
 * new time in the event's own zone — Berlin local time with its TZID, UTC,
 * a date, or clock time for a floating event, which is refused a time with an
 * offset — and `create_event` writes in its `timezone`, else the calendar's
 * own zone, else UTC. A time given without an offset is clock time in that
 * zone.
 *
 * v0.7.4 (spec 2026-09-29 §2.2): `list_events` expands recurrence in the
 * connector, so an all-day series, a floating series or an invitation to one
 * instance no longer fails the whole calendar (R1–R3), and an object that
 * cannot be read is named in the answer's `skipped` instead (#211).
 *
 * What the calendar can do: list calendars and events, create an event, find
 * free time, and since v0.7.2 change (`update_event`, #152) and delete
 * (`delete_event`, #153) an existing one. Both writes are guarded by the ETag
 * `list_events` returns, and need `apply_to_series` to touch a series as a
 * whole (spec 2026-09-28 §4). Since v0.7.4 they address one occurrence by the
 * `recurrence_id` `list_events` reports (#206, spec 2026-09-29 §2.3), and
 * `update_event` gives a series a new clock time or length, every occurrence
 * keeping its date (#207, §2.4). An update
 * edits the stored object in place — see src/ical-edit.ts — so attendees,
 * alarms and anything else this connector does not model survive it.
 * Neither tool sends mail to attendees: there is no iMIP yet (#29). The
 * calendar server may send its own, though — Nextcloud mails attendees of an
 * event you organize when it is changed or deleted (found on the v0.7.2
 * acceptance run) — so both descriptions tell the model to confirm first.
 *
 * Those refusals are answers, not failures. They are thrown as `ToolRefusal`,
 * which `reportingFailures()` passes through word for word with no log line: a
 * model retrying after a conflict is the tool working, and a `warn` for it
 * would bury the lines #146 exists for.
 *
 * v0.7.1 (#146): a CalDAV failure names the account and leaves exactly one
 * `warn` line, the same as the mail tools, through `reportingFailures()`.
 *
 * One asymmetry is worth stating rather than leaving to be rediscovered. The
 * *probe* can report a CalDAV credential rejection as one, because #44 gave it
 * a plain-HTTP pre-flight that reads the `401` before tsdav's discovery
 * overwrites it. `CalDavClient` has no such pre-flight, and tsdav keeps only
 * the last error from the candidate root URLs it walks, so what arrives here
 * for a refused password is tsdav's own prose. That prose does currently say
 * `Invalid credentials: … returned 401 Unauthorized`, which is a usable
 * sentence — but it is the library's wording, not a classification, and
 * nothing here pattern-matches it into one. What #146 guarantees for the
 * calendar tools is the rest: the account named, the reason bounded by
 * `describeFailure()`, and one line in the log.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ClientPool } from "./client-pool.js";
import { CalDavClient } from "./caldav-client.js";
import { reportingFailures } from "./tool-errors.js";

function asJson(value: unknown): { content: { type: "text"; text: string }[] } {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

const isoDateTime = z
  .string()
  .describe(
    "ISO 8601 datetime with timezone offset, e.g. 2026-05-22T09:00:00+02:00"
  );

/**
 * A start or end an event is given (#214): `isoDateTime` said "with timezone
 * offset" even where an all-day event takes a bare date, so the schema told
 * the model one thing and the tool description another.
 */
const DATE_OR_DATE_TIME =
  "an ISO 8601 date-time with offset, e.g. 2026-05-22T09:00:00+02:00, or YYYY-MM-DD when all_day";

const dateOrDateTime = z.string().describe(`Start: ${DATE_OR_DATE_TIME}`);

/**
 * What a changed time needs besides {@link DATE_OR_DATE_TIME} (#209): a
 * floating event is refused a time with an offset, so the model has to be
 * told before it tries one.
 */
const IN_THE_EVENTS_ZONE =
  "Written in the event's own time zone. For a floating event (timezone \"floating\" in list_events) give it without an offset, e.g. 2026-05-22T09:00:00";

const accountSchema = z
  .string()
  .optional()
  .describe(
    "Account ID (from list_accounts) to act on. Omit to use the default account."
  );

// The fields every tool that names one stored event shares (#214). One
// definition each, so update_event, delete_event and the writes still to come
// cannot describe the same argument two ways.

const calendarUrlSchema = z
  .string()
  .url()
  .describe("Calendar URL as returned by list_calendars");

const uidSchema = z.string().min(1).describe("Event UID as returned by list_events");

const etagSchema = z
  .string()
  .min(1)
  .optional()
  .describe("The event's etag as returned by list_events. Required unless list_events returned null for it.");

const applyToSeriesSchema = z
  .boolean()
  .optional()
  .describe(
    "Required to change or delete a recurring event as a whole; the call then applies to every occurrence. Not needed with recurrence_id, which addresses one occurrence"
  );

const recurrenceIdSchema = z
  .string()
  .min(1)
  .optional()
  .describe(
    "One occurrence of a recurring event: its recurrenceId exactly as list_events reported it — an ISO instant (2026-10-08T07:00:00.000Z), a clock time with no offset for a floating series, or a date (YYYY-MM-DD) for an all-day series. The call then changes or deletes that occurrence only. With apply_to_series=true (update_event only) it instead names the occurrence whose new start/end the whole series' time is measured against"
  );

/**
 * Resolve the account and hand back its CalDAV client together with the id
 * every failure below is reported and logged against (#146).
 *
 * The two errors thrown from here — an unknown account id out of
 * `pool.for()`, and "no CalDAV configured" — deliberately do not go through
 * `reportingFailures()`: both already say something true and specific, and
 * neither is a server that failed. Logging them as mailbox failures would
 * blame a host nothing ever contacted. The second message names the *resolved*
 * id rather than the argument, so a caller who omitted `account` is told which
 * mailbox it landed on instead of the unhelpful `(default)`.
 */
function requireCaldav(
  pool: ClientPool,
  accountId?: string
): { caldav: CalDavClient; id: string } {
  const clients = pool.for(accountId);
  if (!clients.caldav) {
    throw new Error(
      `Account "${clients.id}" has no CalDAV configured. Add a CalDAV URL under /settings/mailboxes on this deployment's public URL.`
    );
  }
  return { caldav: clients.caldav, id: clients.id };
}

export function registerCalendarTools(
  server: McpServer,
  pool: ClientPool
): void {
  server.registerTool(
    "list_calendars",
    {
      description:
        "List all CalDAV calendars on the configured account. Returns URL (used as `calendar_url` in other tools), display name, timezone, and supported components. Errors if the resolved account has no CalDAV configured.",
      inputSchema: {
        account: accountSchema,
      },
    },
    async ({ account }) => {
      const { caldav, id } = requireCaldav(pool, account);
      return asJson(
        await reportingFailures(pool, "list_calendars", id, () => caldav.listCalendars())
      );
    }
  );

  server.registerTool(
    "list_events",
    {
      description:
        "List events in a calendar between two timestamps. Recurring events are expanded into individual instances, each with the `recurrenceId` of the occurrence it is (a date, YYYY-MM-DD, for an all-day series). Each event carries `timezone`: its IANA zone, \"UTC\", or \"floating\" — a clock time with no zone, whose `start` and `end` are given without an offset. `transparent: true` means it does not block time. An event whose stored data cannot be read is left out and named in `skipped` with the reason, rather than failing the whole calendar.",
      inputSchema: {
        calendar_url: calendarUrlSchema,
        start: isoDateTime.describe("Window start (inclusive)"),
        end: isoDateTime.describe("Window end (exclusive)"),
        account: accountSchema,
      },
    },
    async ({ calendar_url, start, end, account }) => {
      const { caldav, id } = requireCaldav(pool, account);
      const { events, skipped } = await reportingFailures(pool, "list_events", id, () =>
        caldav.listEvents(calendar_url, start, end)
      );
      return asJson({ count: events.length, events, skipped });
    }
  );

  server.registerTool(
    "create_event",
    {
      description:
        "Create a new calendar event. WRITE OPERATION. Use all_day=true for date-only events (start/end should then be YYYY-MM-DD; end is exclusive — for a one-day event set end to the day after). The event is written in `timezone`, or the calendar's own zone, or UTC; the answer's `timezone` says which. The end must come after the start.",
      inputSchema: {
        calendar_url: calendarUrlSchema,
        summary: z.string().min(1).describe("Event title"),
        start: dateOrDateTime,
        end: dateOrDateTime.describe(`End: ${DATE_OR_DATE_TIME}; exclusive for an all-day event`),
        all_day: z.boolean().optional(),
        description: z.string().optional(),
        location: z.string().optional(),
        attendees: z
          .array(z.string().email())
          .optional()
          .describe(
            "Email addresses of attendees. Attendees may or may not receive an invitation, depending on the calendar server. CalDAV itself does not mail invitations, and this connector does not send them."
          ),
        timezone: z
          .string()
          .min(1)
          .optional()
          .describe(
            "IANA time zone to write the event in, e.g. Europe/Berlin. Omit to use the calendar's own zone when the server reports one, and UTC otherwise. A start or end with no offset is clock time in this zone."
          ),
        account: accountSchema,
      },
    },
    async (args) => {
      const { caldav, id } = requireCaldav(pool, args.account);
      const result = await reportingFailures(pool, "create_event", id, () =>
        caldav.createEvent({
          calendarUrl: args.calendar_url,
          summary: args.summary,
          description: args.description,
          location: args.location,
          start: args.start,
          end: args.end,
          allDay: args.all_day,
          attendees: args.attendees,
          timezone: args.timezone,
        })
      );
      return asJson({ success: true, ...result });
    }
  );

  server.registerTool(
    "update_event",
    {
      description:
        "Change an existing calendar event. WRITE OPERATION. Pass the `etag` list_events returned: if the event was changed elsewhere since, nothing is written and you are told to read it again. Only the fields you pass change; everything else — attendees, reminders, recurrence rules — is kept exactly as it is. `start` alone moves the event and keeps its length as elapsed time (whole days for an all-day event): one that spans a daylight-saving change keeps its hours, not its clock times. The answer carries the event's new `etag` for a further change; if it is null, call list_events before changing it again. This connector sends no invitation or update mail itself. However, the calendar server may: some servers (e.g. Nextcloud) automatically email attendees when an event you organize is changed. Treat changing an event that has attendees as a message to real people, and confirm with the user first. One occurrence of a recurring event: pass its recurrence_id from list_events, and only that occurrence changes. The whole series: pass apply_to_series=true. A series' start and end then give every occurrence a new clock time and/or length, each keeping its date — start and end describe the series' first occurrence, or the one recurrence_id names — and the day of a series cannot be changed, only its time. Cancelled and individually changed occurrences stay the ones they were. An invitation to a single occurrence of someone else's series is changed like one occurrence, with or without recurrence_id.",
      inputSchema: {
        calendar_url: calendarUrlSchema,
        uid: uidSchema,
        etag: etagSchema,
        summary: z.string().min(1).optional().describe("New title"),
        description: z.string().optional().describe("New description; an empty string removes it"),
        location: z.string().optional().describe("New location; an empty string removes it"),
        start: dateOrDateTime
          .optional()
          .describe(`New start: ${DATE_OR_DATE_TIME}. Alone, it moves the event and keeps its length as elapsed time. ${IN_THE_EVENTS_ZONE}.`),
        end: dateOrDateTime
          .optional()
          .describe(`New end: ${DATE_OR_DATE_TIME}; exclusive for an all-day event. ${IN_THE_EVENTS_ZONE}.`),
        all_day: z
          .boolean()
          .optional()
          .describe("Switch between all-day and timed; needs both start and end (YYYY-MM-DD, end exclusive, when all-day)"),
        recurrence_id: recurrenceIdSchema,
        apply_to_series: applyToSeriesSchema,
        account: accountSchema,
      },
    },
    async (args) => {
      const { caldav, id } = requireCaldav(pool, args.account);
      const result = await reportingFailures(pool, "update_event", id, () =>
        caldav.updateEvent({
          calendarUrl: args.calendar_url,
          uid: args.uid,
          etag: args.etag,
          summary: args.summary,
          description: args.description,
          location: args.location,
          start: args.start,
          end: args.end,
          allDay: args.all_day,
          recurrenceId: args.recurrence_id,
          applyToSeries: args.apply_to_series,
        })
      );
      return asJson({ success: true, ...result });
    }
  );

  server.registerTool(
    "delete_event",
    {
      description:
        "Delete a calendar event. DESTRUCTIVE AND PERMANENT: CalDAV has no trash, so a deleted event cannot be recovered. This connector sends no cancellation itself. However, the calendar server may: some servers (e.g. Nextcloud) automatically email attendees a cancellation when an event you organize is deleted, and that mail cannot be recalled. Confirm with the user first if the event has attendees. Pass the `etag` list_events returned: if the event was changed elsewhere since, nothing is deleted. To cancel one occurrence of a recurring event, pass its recurrence_id from list_events: that one occurrence is removed from the series (an EXDATE), the rest stay, and the answer carries the series' new `etag`. A whole recurring event needs apply_to_series=true and is then deleted with every occurrence. Deleting an invitation to a single occurrence of someone else's series deletes the stored invitation; on some servers (e.g. Nextcloud) that may send the organizer a decline.",
      inputSchema: {
        calendar_url: calendarUrlSchema,
        uid: uidSchema,
        etag: etagSchema,
        recurrence_id: recurrenceIdSchema,
        apply_to_series: applyToSeriesSchema,
        account: accountSchema,
      },
    },
    async (args) => {
      const { caldav, id } = requireCaldav(pool, args.account);
      const result = await reportingFailures(pool, "delete_event", id, () =>
        caldav.deleteEvent({
          calendarUrl: args.calendar_url,
          uid: args.uid,
          etag: args.etag,
          recurrenceId: args.recurrence_id,
          applyToSeries: args.apply_to_series,
        })
      );
      return asJson({ success: true, ...result });
    }
  );

  server.registerTool(
    "find_free_slot",
    {
      description:
        "Find free time slots across one or more calendars in a window. Returns continuous gaps long enough to fit `duration_minutes`. Optional working hours restrict the search to a daily window (in UTC; pass start/end already in your local TZ if you want local-time anchoring).",
      inputSchema: {
        calendar_urls: z
          .array(z.string().url())
          .min(1)
          .describe("One or more calendar URLs to consider busy"),
        range_start: isoDateTime,
        range_end: isoDateTime,
        duration_minutes: z
          .number()
          .int()
          .min(5)
          .max(24 * 60)
          .describe("Minimum slot length in minutes"),
        working_hours: z
          .object({
            start_hour: z.number().int().min(0).max(23),
            end_hour: z.number().int().min(1).max(24),
          })
          .optional()
          .describe(
            "Restrict slots to this daily UTC window (e.g. 8–18 for 09:00–19:00 in CEST)"
          ),
        account: accountSchema,
      },
    },
    async (args) => {
      const { caldav, id } = requireCaldav(pool, args.account);
      const slots = await reportingFailures(pool, "find_free_slot", id, () =>
        caldav.findFreeSlots(
          args.calendar_urls,
          args.range_start,
          args.range_end,
          args.duration_minutes,
          args.working_hours
            ? {
                startHour: args.working_hours.start_hour,
                endHour: args.working_hours.end_hour,
              }
            : undefined
        )
      );
      return asJson({ count: slots.length, slots });
    }
  );
}
