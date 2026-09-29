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
  config: { inputSchema: Record<string, z.ZodType> };
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
  return found.config.inputSchema;
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
