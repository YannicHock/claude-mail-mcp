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
 *
 * `move_event` (v0.7.4, #212, spec 2026-09-29 §2.6) moves an event, whole,
 * into another calendar of the same account, unchanged: a WebDAV MOVE, or a
 * copy into the target and a delete from the source where the server
 * refuses MOVE, and the answer's `via` says which. Its ETag is compared in
 * the connector before anything is sent, since Radicale ignores `If-Match`
 * on MOVE (R11).
 *
 * Attendees (v0.7.4, #204, #205, spec 2026-09-29 §2.1). No tool sends mail
 * to attendees: there is no iMIP yet (#29). The calendar server may send its
 * own, though — Nextcloud mails attendees of an event you organize when it
 * is changed or deleted (found on the v0.7.2 acceptance run) — and whether it
 * does for a new event or a changed guest list is what acceptance A1/A2
 * records. So every text here says "may", and never what a server will do.
 * `create_event` with `attendees` and `update_event` with `add_attendees` or
 * `remove_attendees` write the account as ORGANIZER and cannot be called
 * without `notify_attendees`: a refinement over the tool's whole input
 * schema makes it required exactly when one of those lists is non-empty, so
 * the model cannot add a person without saying whether the server may mail
 * them — "confirm with the user first" made structural. `false` marks the
 * attendees the call adds `SCHEDULE-AGENT=CLIENT` (RFC 6638), which asks the
 * server to send them nothing. Removing attendees with `false` is refused
 * until acceptance A2 shows the server honours it (spec §2.1,
 * `REMOVE_WITHOUT_NOTIFY_HONOURED` in src/ical-attendees.ts). And since an
 * ORGANIZER written by the call changes whom the server contacts — every
 * attendee already listed, not only the ones added — the answer says whom it
 * may now email, as `may_notify` (review of PR #230).
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
import { MAX_FREE_SLOT_RANGE_DAYS, MAX_FREE_SLOTS } from "./free-slots.js";
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

/**
 * What every tool that can make the calendar server mail attendees says
 * (spec 2026-09-29 §2.1): conditional throughout, since what a server sends is
 * acceptance A1/A2's to record, not this text's to promise.
 */
const SERVER_MAY_MAIL =
  "This connector sends no mail itself. However, your calendar server may: Nextcloud, for example, may email the attendees of an event you organize when it is created, changed or deleted, and that mail cannot be recalled. Confirm with the user before creating, changing or deleting an event that has attendees.";

/**
 * {@link SERVER_MAY_MAIL} for `move_event` (#212, spec 2026-09-29 §2.1,
 * §2.6). Whether a server mails anyone for a move is acceptance A5's to
 * record on Nextcloud, so until then the sentence says how it might — a move
 * seen as a deletion in one calendar and a creation in the other — and
 * never that it will. Once A5 is in, "moved" either joins the list in
 * {@link SERVER_MAY_MAIL} and this goes, or this says it does not.
 */
const SERVER_MAY_MAIL_ON_MOVE =
  "This connector sends no mail itself. However, your calendar server may: it may treat a move as a deletion from one calendar and a creation in the other, and email the attendees of an event you organize (or the organizer of someone else's meeting) accordingly, and that mail cannot be recalled. Confirm with the user before moving an event that has attendees.";

/** Why `notify_attendees` is refused missing: the refinement's message, which the model is shown. */
const NOTIFY_REQUIRED =
  "notify_attendees is required when attendees are added or removed: true lets the calendar server email them, false asks it not to. Confirm with the user which they want first.";

const notifyAttendeesSchema = z
  .boolean()
  .optional()
  .describe(
    "Required whenever attendees are added or removed (create_event's attendees, update_event's add_attendees or remove_attendees): this is where real people may get mail, so ask the user which they want and confirm with the user before the call. true: the attendees are written plainly, and the calendar server may then email them an invitation, update or cancellation on its own; that mail cannot be recalled. false: each attendee this call adds is marked SCHEDULE-AGENT=CLIENT, which asks the calendar server to send them nothing; the event lists them, and whether the server honours the request is up to the server. Removing attendees with false is refused for now, since the server may send them a cancellation regardless: leave them listed, or confirm with the user that they may be emailed and pass true. On an event that has attendees but no organizer yet, the account becomes its organizer, and the attendees already listed are treated like the ones added: with true, the server may email them too. The answer's may_notify lists everyone the calendar server may now email about the event."
  );

/**
 * The refinement that makes `notify_attendees` required when any list
 * `listsOf` returns is non-empty (spec 2026-09-29 §2.1). It sits on the
 * tool's whole input schema, which the MCP SDK checks every call against,
 * so a call without it is refused before the handler runs, with
 * {@link NOTIFY_REQUIRED} as the reason.
 */
function notifyRequired<T extends { notify_attendees?: boolean }>(
  listsOf: (args: T) => Array<readonly string[] | undefined>
): (args: T, ctx: z.RefinementCtx<T>) => void {
  return (args, ctx) => {
    if (args.notify_attendees === undefined && listsOf(args).some((list) => (list?.length ?? 0) > 0)) {
      ctx.addIssue({ code: "custom", path: ["notify_attendees"], message: NOTIFY_REQUIRED });
    }
  };
}

/**
 * A write's answer as the tool gives it: `success`, and the client's
 * `mayNotify` — whom the calendar server may now email (review of PR #230)
 * — as `may_notify`, only where the write changed a guest list.
 */
function withMayNotify<T extends { mayNotify?: string[] }>(result: T): Record<string, unknown> {
  const { mayNotify, ...rest } = result;
  return { success: true, ...rest, ...(mayNotify === undefined ? {} : { may_notify: mayNotify }) };
}

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
        `Create a new calendar event. WRITE OPERATION. Use all_day=true for date-only events (start/end should then be YYYY-MM-DD; end is exclusive — for a one-day event set end to the day after). The event is written in \`timezone\`, or the calendar's own zone, or UTC; the answer's \`timezone\` says which. The end must come after the start. With attendees, the account is written as the event's ORGANIZER, notify_attendees is required, and the answer's \`may_notify\` lists whom the calendar server may now email. ${SERVER_MAY_MAIL}`,
      inputSchema: z.object({
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
            "Email addresses to invite. Needs notify_attendees: with true the calendar server may email each of them an invitation. This connector sends none itself."
          ),
        notify_attendees: notifyAttendeesSchema,
        timezone: z
          .string()
          .min(1)
          .optional()
          .describe(
            "IANA time zone to write the event in, e.g. Europe/Berlin. Omit to use the calendar's own zone when the server reports one, and UTC otherwise. A start or end with no offset is clock time in this zone."
          ),
        account: accountSchema,
      }).superRefine(notifyRequired((args) => [args.attendees])),
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
          notifyAttendees: args.notify_attendees,
          timezone: args.timezone,
        })
      );
      return asJson(withMayNotify(result));
    }
  );

  server.registerTool(
    "update_event",
    {
      description:
        `Change an existing calendar event. WRITE OPERATION. Pass the \`etag\` list_events returned: if the event was changed elsewhere since, nothing is written and you are told to read it again. Only the fields you pass change; everything else — attendees, reminders, recurrence rules — is kept exactly as it is. \`start\` alone moves the event and keeps its length as elapsed time (whole days for an all-day event): one that spans a daylight-saving change keeps its hours, not its clock times. The answer carries the event's new \`etag\` for a further change; if it is null, call list_events before changing it again. ${SERVER_MAY_MAIL} add_attendees and remove_attendees change who is invited, and need notify_attendees; only its organizer changes an event's guest list, so they are refused on a meeting someone else organizes, whose text and time can still be changed. With recurrence_id they change that one occurrence's guest list, and with apply_to_series every occurrence's. The answer's \`may_notify\` then lists whom the calendar server may now email: on an event that had attendees but no organizer, that includes the attendees already listed. One occurrence of a recurring event: pass its recurrence_id from list_events, and only that occurrence changes. The whole series: pass apply_to_series=true. A series' start and end then give every occurrence a new clock time and/or length, each keeping its date — start and end describe the series' first occurrence, or the one recurrence_id names — and the day of a series cannot be changed, only its time. Cancelled and individually changed occurrences stay the ones they were. An invitation to a single occurrence of someone else's series is changed like one occurrence, with or without recurrence_id.`,
      inputSchema: z.object({
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
        add_attendees: z
          .array(z.string().email())
          .optional()
          .describe(
            "Email addresses to invite. Needs notify_attendees. An address that already is an attendee is refused, and nothing is changed."
          ),
        remove_attendees: z
          .array(z.string().email())
          .optional()
          .describe(
            "Email addresses to take off the guest list; every other attendee keeps their reply. Needs notify_attendees: true, and the calendar server may then email them a cancellation; for now removal with false is refused. An address that is not an attendee (of any occurrence, with apply_to_series) is refused, and nothing is changed."
          ),
        notify_attendees: notifyAttendeesSchema,
        recurrence_id: recurrenceIdSchema,
        apply_to_series: applyToSeriesSchema,
        account: accountSchema,
      }).superRefine(notifyRequired((args) => [args.add_attendees, args.remove_attendees])),
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
          addAttendees: args.add_attendees,
          removeAttendees: args.remove_attendees,
          notifyAttendees: args.notify_attendees,
          recurrenceId: args.recurrence_id,
          applyToSeries: args.apply_to_series,
        })
      );
      return asJson(withMayNotify(result));
    }
  );

  server.registerTool(
    "delete_event",
    {
      description:
        `Delete a calendar event. DESTRUCTIVE AND PERMANENT: CalDAV has no trash, so a deleted event cannot be recovered. ${SERVER_MAY_MAIL} Pass the \`etag\` list_events returned: if the event was changed elsewhere since, nothing is deleted. To cancel one occurrence of a recurring event, pass its recurrence_id from list_events: that one occurrence is removed from the series (an EXDATE), the rest stay, and the answer carries the series' new \`etag\`. A whole recurring event needs apply_to_series=true and is then deleted with every occurrence. Deleting an invitation to a single occurrence of someone else's series deletes the stored invitation; on some servers (e.g. Nextcloud) that may send the organizer a decline.`,
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
    "move_event",
    {
      description:
        `Move an event to another calendar of the same account. WRITE OPERATION. The event is moved as it is stored: its UID, attendees, reminders and everything else stay unchanged. Pass the \`etag\` list_events returned: if the event was changed elsewhere since, nothing is moved. A recurring event moves whole and needs apply_to_series=true; one occurrence cannot be moved to another calendar, so recurrence_id is refused. Refused, with nothing moved, when the target calendar already has an event with this UID or an object of the same name. The answer gives the event's new \`url\` and \`etag\`, and \`via\`: "move" when the server moved it itself, "copy-then-delete" when it refused to and the event was copied into the target calendar and then deleted from the source, in which case the \`etag\` is a new one. If the source cannot be deleted, the copy is removed again and nothing is moved. A refusal that names both URLs means the event may be in both calendars, or that it is unclear where it went: call list_events on both before anything else. ${SERVER_MAY_MAIL_ON_MOVE} The answer's \`may_notify\` then lists whom the calendar server may email.`,
      inputSchema: {
        calendar_url: calendarUrlSchema.describe("The calendar the event is in now, as returned by list_calendars"),
        uid: uidSchema,
        etag: etagSchema,
        target_calendar_url: calendarUrlSchema.describe(
          "The calendar to move the event into, as returned by list_calendars: another calendar of the same account"
        ),
        apply_to_series: applyToSeriesSchema.describe("Required to move a recurring event, which moves with every occurrence"),
        recurrence_id: recurrenceIdSchema.describe(
          "Refused: one occurrence of a series cannot be moved to another calendar. Move the whole series with apply_to_series=true instead"
        ),
        account: accountSchema,
      },
    },
    async (args) => {
      const { caldav, id } = requireCaldav(pool, args.account);
      const result = await reportingFailures(pool, "move_event", id, () =>
        caldav.moveEvent({
          calendarUrl: args.calendar_url,
          uid: args.uid,
          etag: args.etag,
          targetCalendarUrl: args.target_calendar_url,
          applyToSeries: args.apply_to_series,
          recurrenceId: args.recurrence_id,
        })
      );
      return asJson(withMayNotify(result));
    }
  );

  server.registerTool(
    "find_free_slot",
    {
      // #213, R14, spec 2026-09-29 §2.7: the busy filter, the zone and
      // `skipped` are src/ical-busy.ts, src/free-slots.ts and
      // CalDavClient.findFreeSlots; this is only the shape the model sees.
      description:
        `Find free time slots across one or more calendars in a window of at most ${MAX_FREE_SLOT_RANGE_DAYS} days; a longer one is refused. Returns each continuous gap long enough to fit \`duration_minutes\`, the earliest first, at most ${MAX_FREE_SLOTS} of them, with \`truncated\` true when there were more. An event blocks time unless it is transparent ("show as free"), cancelled, or one the account declined under any of its addresses (its calendar addresses and its mailbox's); a tentative one blocks it. Optional working hours restrict the search to the same hours on every day of the range, on the clock of \`timezone\`. The answer's \`timezone\` names the zone used, and each slot is given with that zone's offset. A stored event whose data could not be read is named in \`skipped\`, with a \`warning\`: its time was not checked, so a slot may overlap it. The \`warning\` also says when the account's calendar addresses could not be looked up, so an invitation it declined may have counted as busy.`,
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
            "Restrict slots to these whole hours on every day of the range, on the clock of `timezone` (e.g. 9–17). end_hour 24 is midnight; it must be after start_hour."
          ),
        timezone: z
          .string()
          .min(1)
          .optional()
          .describe(
            "IANA time zone the working hours are in and the slots are given in, e.g. Europe/Berlin. Omit to use the calendars' own zone when they all name the same one, and UTC otherwise."
          ),
        account: accountSchema,
      },
    },
    async (args) => {
      const { caldav, id } = requireCaldav(pool, args.account);
      const { timezone, slots, truncated, skipped, addressesKnown } = await reportingFailures(pool, "find_free_slot", id, () =>
        caldav.findFreeSlots({
          calendarUrls: args.calendar_urls,
          rangeStart: args.range_start,
          rangeEnd: args.range_end,
          durationMinutes: args.duration_minutes,
          workingHours: args.working_hours
            ? { startHour: args.working_hours.start_hour, endHour: args.working_hours.end_hour }
            : undefined,
          timezone: args.timezone,
        })
      );
      // An object whose busy time is unknown is never left to look free: the
      // model is told, beside the slots, that they may overlap it. Nor is a
      // declined invitation counted busy in silence when the account's
      // addresses could not be looked up (review of PR #232).
      const warnings: string[] = [];
      if (skipped.length > 0) {
        warnings.push(
          `The busy time of ${skipped.length === 1 ? "one stored event" : `${skipped.length} stored events`} named in skipped could not be checked, so a slot above may overlap ${skipped.length === 1 ? "it" : "them"}. Check with list_events or with the user before relying on it.`
        );
      }
      if (!addressesKnown) {
        warnings.push(
          "The account's calendar addresses could not be looked up, so only its mailbox's address counted as its own: an invitation it declined under another address was counted as busy, and a slot may be missing where it is in fact free."
        );
      }
      const warning = warnings.length === 0 ? undefined : warnings.join(" ");
      return asJson({ timezone, count: slots.length, truncated, slots, skipped, ...(warning === undefined ? {} : { warning }) });
    }
  );
}
