/**
 * What the calendar tools declare, and the refusal that never reaches the
 * server (#214).
 *
 * The tools are registered against a stand-in `McpServer` that records each
 * tool's config and handler, as in tool-failures.test.ts: the schemas are
 * what a client is shown, and the handler is what the SDK calls.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { z } from "zod";
import { AccountsStore } from "../../src/accounts.js";
import { ClientPool } from "../../src/client-pool.js";
import { registerCalendarTools } from "../../src/tools-calendar.js";
import { ToolRefusal } from "../../src/tool-refusal.js";
import { makeTmpDir, cleanupTmpDir, makeAccount, makeAccountsFile } from "../helpers/fixtures.js";

type Handler = (args: Record<string, unknown>) => Promise<unknown>;
interface Registered {
  /** A raw shape, or — for a tool whose fields depend on each other — an object schema with a refinement. */
  config: { description?: string; inputSchema: Record<string, z.ZodType> | z.ZodObject };
  handler: Handler;
}

/** Port 1 on loopback refuses every connection at once. */
const CLOSED = "http://127.0.0.1:1/";

/** Register the calendar tools for one account whose CalDAV is `caldavUrl`. */
async function withCalendarTools<T>(
  caldavUrl: string,
  run: (tools: Map<string, Registered>, warnings: () => number) => Promise<T>
): Promise<T> {
  const dir = await makeTmpDir();
  try {
    const file = await makeAccountsFile(dir, [
      makeAccount({ id: "work", default: true, caldav: { url: caldavUrl, user: "alice", pass: "pw" } }),
    ]);
    const store = new AccountsStore(file);
    await store.reload();
    let warns = 0;
    const pool = new ClientPool(store, (level) => {
      if (level === "warn") warns += 1;
    });
    const tools = new Map<string, Registered>();
    const server = {
      registerTool: (name: string, config: Registered["config"], handler: Handler) => {
        tools.set(name, { config, handler });
      },
    } as unknown as McpServer;
    registerCalendarTools(server, pool);
    return await run(tools, () => warns);
  } finally {
    await cleanupTmpDir(dir);
  }
}

function schemaOf(tools: Map<string, Registered>, tool: string): Record<string, z.ZodType> {
  const found = tools.get(tool);
  assert.ok(found, `${tool} is not registered`);
  const schema = found.config.inputSchema;
  return isObjectSchema(schema) ? (schema.shape as Record<string, z.ZodType>) : schema;
}

function isObjectSchema(schema: Registered["config"]["inputSchema"]): schema is z.ZodObject {
  return typeof (schema as { safeParse?: unknown }).safeParse === "function";
}

/** What the SDK checks a call's arguments against: the tool's whole input schema, refinements included. */
function inputOf(tools: Map<string, Registered>, tool: string): z.ZodObject {
  const found = tools.get(tool);
  assert.ok(found, `${tool} is not registered`);
  const schema = found.config.inputSchema;
  assert.ok(isObjectSchema(schema), `${tool} declares no refinement over its fields`);
  return schema;
}

describe("the calendar tools' shared fields (#214)", () => {
  it("update_event and delete_event take calendar_url, uid, etag, apply_to_series and recurrence_id from one definition", async () => {
    await withCalendarTools(CLOSED, async (tools) => {
      const update = schemaOf(tools, "update_event");
      const del = schemaOf(tools, "delete_event");
      for (const field of ["calendar_url", "uid", "etag", "apply_to_series", "recurrence_id"]) {
        assert.ok(update[field], `update_event has no ${field}`);
        assert.equal(update[field], del[field], `${field} is defined twice`);
      }
      assert.equal(schemaOf(tools, "create_event").calendar_url, update.calendar_url);
    });
  });

  it("describes start and end as a date-time, or a date for an all-day event", async () => {
    await withCalendarTools(CLOSED, async (tools) => {
      for (const tool of ["create_event", "update_event"]) {
        for (const field of ["start", "end"]) {
          const description = schemaOf(tools, tool)[field]?.description ?? "";
          assert.match(description, /YYYY-MM-DD/, `${tool}.${field}: ${description}`);
          assert.match(description, /all.day/, `${tool}.${field}: ${description}`);
        }
      }
    });
  });
});

describe("occurrences and a series' time on the calendar tools (spec 2026-09-29 §2.3, §2.4)", () => {
  it("recurrence_id is supported, says what it takes, and that it comes from list_events", async () => {
    await withCalendarTools(CLOSED, async (tools) => {
      const description = schemaOf(tools, "update_event").recurrence_id?.description ?? "";
      assert.doesNotMatch(description, /not supported/i);
      assert.match(description, /recurrenceId/);
      assert.match(description, /list_events/);
      assert.match(description, /YYYY-MM-DD/);
    });
  });

  it("update_event and delete_event describe one occurrence, and update_event a series' new time, and neither says it cannot yet", async () => {
    await withCalendarTools(CLOSED, async (tools) => {
      const update = tools.get("update_event")?.config.description ?? "";
      const del = tools.get("delete_event")?.config.description ?? "";
      for (const [tool, description] of [["update_event", update], ["delete_event", del]] as const) {
        assert.doesNotMatch(description, /cannot be (changed|deleted) yet|not supported/i, tool);
        assert.match(description, /recurrence_id/, tool);
      }
      assert.match(update, /keeping its date|keeps its date/);
      assert.match(update, /day of a series cannot/);
      assert.match(del, /EXDATE|that one occurrence/);
    });
  });
});

describe("zones on the calendar tools (spec 2026-09-29 §2.5)", () => {
  it("create_event takes an optional IANA timezone, and says what it defaults to", async () => {
    await withCalendarTools(CLOSED, async (tools) => {
      const timezone = schemaOf(tools, "create_event").timezone;
      assert.ok(timezone, "create_event has no timezone");
      assert.equal(timezone.safeParse(undefined).success, true, "timezone is required");
      assert.match(timezone.description ?? "", /IANA/);
      assert.match(timezone.description ?? "", /calendar's own/);
    });
  });

  it("update_event tells the model a floating event takes its times without an offset", async () => {
    await withCalendarTools(CLOSED, async (tools) => {
      for (const field of ["start", "end"]) {
        assert.match(schemaOf(tools, "update_event")[field]?.description ?? "", /floating.*without an offset/, field);
      }
    });
  });

  it("create_event refuses a timezone that is no IANA name before any request, and leaves no warn line", async () => {
    await withCalendarTools(CLOSED, async (tools, warnings) => {
      const create = tools.get("create_event");
      assert.ok(create);
      await assert.rejects(
        create.handler({
          calendar_url: `${CLOSED}cal/`,
          summary: "x",
          start: "2026-10-01T09:00:00Z",
          end: "2026-10-01T10:00:00Z",
          timezone: "Mars/Olympus_Mons",
        }),
        (err: unknown) => err instanceof ToolRefusal && /Nothing was created/.test(err.message)
      );
      assert.equal(warnings(), 0);
    });
  });
});

describe("update_event with nothing to change", () => {
  it("is refused before any request, and leaves no warn line", async () => {
    // Had the call reached for the closed port, it would have failed as
    // unreachable, with a warn line, instead.
    await withCalendarTools(CLOSED, async (tools, warnings) => {
      const update = tools.get("update_event");
      assert.ok(update);
      await assert.rejects(
        update.handler({ calendar_url: `${CLOSED}cal/`, uid: "e@example.com", etag: '"a"' }),
        (err: unknown) => err instanceof ToolRefusal && /^Nothing to change/.test(err.message)
      );
      assert.equal(warnings(), 0);
    });
  });
});

describe("attendees on the calendar tools (#204, #205, spec 2026-09-29 §2.1)", () => {
  const CAL = "https://dav.example/cal/";
  const NEW = { calendar_url: CAL, summary: "Planning", start: "2026-10-01T09:00:00Z", end: "2026-10-01T10:00:00Z" };
  const CHANGE = { calendar_url: CAL, uid: "e@example.com", etag: '"a"' };

  /** The message a refused parse gives, which the model is shown. */
  function rejection(schema: z.ZodObject, args: Record<string, unknown>): string {
    const result = schema.safeParse(args);
    assert.equal(result.success, false, `accepted: ${JSON.stringify(args)}`);
    return result.error?.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") ?? "";
  }

  it("create_event requires notify_attendees when it has attendees, and says why", async () => {
    await withCalendarTools(CLOSED, async (tools) => {
      const create = inputOf(tools, "create_event");
      const message = rejection(create, { ...NEW, attendees: ["ben@example.com"] });
      assert.match(message, /notify_attendees/);
      assert.match(message, /confirm/i);
      assert.equal(create.safeParse({ ...NEW, attendees: ["ben@example.com"], notify_attendees: false }).success, true);
      assert.equal(create.safeParse({ ...NEW, attendees: [] }).success, true);
      assert.equal(create.safeParse(NEW).success, true);
    });
  });

  it("update_event requires notify_attendees when either attendee list is non-empty", async () => {
    await withCalendarTools(CLOSED, async (tools) => {
      const update = inputOf(tools, "update_event");
      assert.match(rejection(update, { ...CHANGE, add_attendees: ["dan@example.com"] }), /notify_attendees/);
      assert.match(rejection(update, { ...CHANGE, remove_attendees: ["ben@example.com"] }), /notify_attendees/);
      assert.equal(update.safeParse({ ...CHANGE, add_attendees: ["dan@example.com"], notify_attendees: true }).success, true);
      assert.equal(update.safeParse({ ...CHANGE, summary: "x" }).success, true);
      assert.equal(update.safeParse({ ...CHANGE, add_attendees: ["not an address"], notify_attendees: true }).success, false);
    });
  });

  it("notify_attendees is one definition, and says what the server may send, that it cannot be recalled, and to confirm first — without promising what a server does", async () => {
    await withCalendarTools(CLOSED, async (tools) => {
      const create = schemaOf(tools, "create_event").notify_attendees;
      const update = schemaOf(tools, "update_event").notify_attendees;
      assert.ok(create, "create_event has no notify_attendees");
      assert.equal(create, update, "notify_attendees is defined twice");
      const text = create.description ?? "";
      assert.match(text, /server may/);
      assert.match(text, /SCHEDULE-AGENT=CLIENT/);
      assert.match(text, /cannot be recalled/);
      assert.match(text, /[Cc]onfirm with the user/);
      assert.doesNotMatch(text, /\bwill (e?mail|send)|nobody is told|no one is told|guarantee/i);
    });
  });

  it("notify_attendees and remove_attendees say removal with false is refused for now, and what to do instead: leave them listed first (spec §2.1, until acceptance A2)", async () => {
    await withCalendarTools(CLOSED, async (tools) => {
      const notify = schemaOf(tools, "update_event").notify_attendees?.description ?? "";
      assert.match(notify, /[Rr]emoving attendees with false is refused for now/);
      assert.match(notify, /leave them listed.*true/);
      assert.doesNotMatch(notify, /removing an attendee the server was free to notify is refused/);
      const remove = schemaOf(tools, "update_event").remove_attendees?.description ?? "";
      assert.match(remove, /notify_attendees: true/);
      assert.match(remove, /false is refused/);
    });
  });

  it("create_event and update_event say their answer names, in may_notify, whom the calendar server may now email", async () => {
    await withCalendarTools(CLOSED, async (tools) => {
      for (const tool of ["create_event", "update_event"]) {
        assert.match(tools.get(tool)?.config.description ?? "", /may_notify/, tool);
      }
      assert.match(schemaOf(tools, "update_event").notify_attendees?.description ?? "", /may_notify/);
    });
  });

  it("create_event, update_event and delete_event say the server may mail attendees, and to confirm first", async () => {
    await withCalendarTools(CLOSED, async (tools) => {
      for (const tool of ["create_event", "update_event", "delete_event"]) {
        const text = tools.get(tool)?.config.description ?? "";
        assert.match(text, /sends no mail itself/, tool);
        assert.match(text, /calendar server may/, tool);
        assert.match(text, /cannot be recalled/, tool);
        assert.match(text, /[Cc]onfirm with the user/, tool);
      }
      assert.match(tools.get("create_event")?.config.description ?? "", /ORGANIZER/);
      assert.match(tools.get("update_event")?.config.description ?? "", /only its organizer/);
      const add = schemaOf(tools, "update_event").add_attendees?.description ?? "";
      assert.match(add, /notify_attendees/);
    });
  });

  it("update_event with only attendee changes is not 'nothing to change', and without notify_attendees is refused before any request", async () => {
    await withCalendarTools(CLOSED, async (tools, warnings) => {
      const update = tools.get("update_event");
      assert.ok(update);
      await assert.rejects(
        update.handler({ ...CHANGE, calendar_url: `${CLOSED}cal/`, add_attendees: ["dan@example.com"] }),
        (err: unknown) => err instanceof ToolRefusal && /notify_attendees/.test(err.message) && /Nothing was changed/.test(err.message)
      );
      const create = tools.get("create_event");
      assert.ok(create);
      await assert.rejects(
        create.handler({ ...NEW, calendar_url: `${CLOSED}cal/`, attendees: ["ben@example.com"] }),
        (err: unknown) => err instanceof ToolRefusal && /notify_attendees/.test(err.message) && /Nothing was created/.test(err.message)
      );
      assert.equal(warnings(), 0);
    });
  });
});
