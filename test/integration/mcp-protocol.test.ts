/**
 * MCP protocol-level integration tests, run against a real in-process
 * Express app on a free port (see test/helpers/mcp-app.ts). These don't
 * touch GreenMail at all — account credentials here are the same
 * `*.invalid` placeholders the unit suite uses — so, unlike
 * mail-server.test.ts, this file runs regardless of Docker availability.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import {
  makeAccount,
  makeAccountsFile,
  makeTmpDir,
  cleanupTmpDir,
  assertNoKeyNamed,
} from "../helpers/fixtures.js";
import {
  startMcpApp,
  SERVER_NAME,
  VERSION,
  type McpTestApp,
} from "../helpers/mcp-app.js";

const AUTH_TOKEN = "protocol-test-token-please-do-not-reuse";

// 1 account + 9 mail tools (registerMailTools) + 7 calendar tools (registerCalendarTools).
const EXPECTED_TOOL_NAMES = [
  "list_accounts",
  "list_folders",
  "list_messages",
  "search_messages",
  "get_message",
  "send_message",
  "create_draft",
  "mark_read",
  "move_message",
  "delete_message",
  "list_calendars",
  "list_events",
  "create_event",
  "update_event",
  "delete_event",
  "move_event",
  "find_free_slot",
].sort();

let dir: string;
let app: McpTestApp;

function connectedClient(): { client: Client; transport: StreamableHTTPClientTransport } {
  const client = new Client({ name: "integration-test-client", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${app.url}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${AUTH_TOKEN}` } },
  });
  return { client, transport };
}

before(async () => {
  dir = await makeTmpDir();
  const work = makeAccount({ id: "work", label: "Work", default: true });
  const home = makeAccount({ id: "home", label: "Home" });
  const accountsFile = await makeAccountsFile(dir, [work, home]);
  app = await startMcpApp({ accountsFile, authToken: AUTH_TOKEN });
});

after(async () => {
  await app?.close();
  await cleanupTmpDir(dir);
});

test("POST /mcp without a bearer token is rejected with 401", async () => {
  const res = await fetch(`${app.url}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
  });
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.error, "unauthorized");
});

test("POST /mcp with the wrong bearer token is rejected with 401", async () => {
  const res = await fetch(`${app.url}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer not-the-right-token",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
  });
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.error, "unauthorized");
});

test("initialize negotiates the expected protocolVersion and serverInfo", async () => {
  const { client, transport } = connectedClient();
  try {
    await client.connect(transport);
    assert.equal(transport.protocolVersion, LATEST_PROTOCOL_VERSION);
    assert.deepEqual(client.getServerVersion(), {
      name: SERVER_NAME,
      version: VERSION,
    });
  } finally {
    await client.close();
  }
});

test("tools/list returns exactly the 17 registered tools", async () => {
  const { client, transport } = connectedClient();
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.equal(tools.length, 17);
    assert.deepEqual(
      tools.map((t) => t.name).sort(),
      EXPECTED_TOOL_NAMES
    );
  } finally {
    await client.close();
  }
});

test("create_event and update_event list notify_attendees, and a call with attendees but without it is refused before the handler runs (spec 2026-09-29 §2.1)", async () => {
  const { client, transport } = connectedClient();
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    for (const name of ["create_event", "update_event"]) {
      const properties = tools.find((t) => t.name === name)?.inputSchema.properties ?? {};
      assert.ok("notify_attendees" in properties, `${name} does not list notify_attendees`);
    }
    // The account has no CalDAV: had the call reached the handler, it would
    // have been refused for that instead.
    let message: string;
    try {
      const result = await client.callTool({
        name: "create_event",
        arguments: {
          calendar_url: "https://dav.example/cal/",
          summary: "Planning",
          start: "2026-10-01T09:00:00Z",
          end: "2026-10-01T10:00:00Z",
          attendees: ["ben@example.com"],
        },
      });
      assert.equal(result.isError, true, "the call was accepted");
      message = JSON.stringify(result.content);
    } catch (err) {
      message = String(err);
    }
    assert.match(message, /notify_attendees is required/);
    assert.doesNotMatch(message, /no CalDAV configured/);
  } finally {
    await client.close();
  }
});

test("GET /health reports the configured accounts without passwords", async () => {
  const res = await fetch(`${app.url}/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, "ok");
  assert.deepEqual(
    body.accounts.map((a: { id: string }) => a.id).sort(),
    ["home", "work"]
  );

  // No key literally named "pass" anywhere in the response, regardless of
  // nesting, plus a belt-and-suspenders check that the raw secrets from
  // makeAccount()'s defaults never leak into the serialized body.
  assertNoKeyNamed(body, "pass");
  const serialized = JSON.stringify(body);
  assert.ok(!serialized.includes("test-imap-secret"));
  assert.ok(!serialized.includes("test-smtp-secret"));
});
