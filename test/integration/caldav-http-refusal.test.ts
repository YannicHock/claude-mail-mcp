/**
 * #247, end to end: an accounts.json written before v0.8 whose CalDAV URL is
 * `http://` to a host that is not local.
 *
 * The connector starts on it (#155), the calendar tools on that account are
 * refused before a single request leaves the process — its Basic credentials
 * never cross the network in cleartext — and the mail tools on the very same
 * account go on working, against GreenMail, through a real MCP session. The
 * offline half (the one start-up `warn`, every calendar tool) is
 * test/unit/caldav-http-refusal.test.ts.
 *
 * "No request" is watched at `globalThis.fetch`, which tsdav and the CalDAV
 * client's own requests both go through: every request to the CalDAV host is
 * recorded and failed, and everything else — this test's own MCP session — is
 * passed on untouched.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { makeAccount, makeAccountsFile, makeTmpDir, cleanupTmpDir } from "../helpers/fixtures.js";
import { startMcpApp, type McpTestApp } from "../helpers/mcp-app.js";
import { isDockerAvailable, composeUp, composeDown, waitForGreenmailReady } from "../helpers/docker.js";
import { ensureMailboxes } from "../helpers/imap-setup.js";

const DOCKER_AVAILABLE = isDockerAvailable();
const SKIP: { skip: string } | Record<string, never> = DOCKER_AVAILABLE
  ? {}
  : { skip: "Docker is not available — skipping integration tests against GreenMail" };

const AUTH_TOKEN = "caldav-http-refusal-token";
const CALDAV_HOST = "cloud.example.com";
const CALDAV_URL = `http://${CALDAV_HOST}/dav/`;

let dir: string | undefined;
let app: McpTestApp | undefined;
let client: Client | undefined;
const originalFetch = globalThis.fetch;
const caldavRequests: string[] = [];

async function call(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  return (await client!.callTool({ name, arguments: args })) as CallToolResult;
}

function textOf(result: CallToolResult): string {
  const first = result.content[0];
  assert.ok(first && first.type === "text", JSON.stringify(result));
  return first.text;
}

before(async () => {
  if (!DOCKER_AVAILABLE) return;
  composeUp();
  await waitForGreenmailReady();
  // A handshake is not a login: GreenMail registers its preloaded users a
  // moment after its listeners answer, and a LOGIN in that window is refused
  // as bad credentials. ensureMailboxes logs in with retries until alice
  // exists — the same wait mail-server.test.ts gets from it — and the
  // account's Drafts folder is created while it is there.
  await ensureMailboxes({ host: "127.0.0.1", port: 3143, user: "alice", pass: "pw1" }, ["Drafts"]);

  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const href = input instanceof Request ? input.url : String(input);
    if (new URL(href).hostname === CALDAV_HOST) {
      caldavRequests.push(href);
      throw new Error("a request to the CalDAV host left the process");
    }
    return originalFetch(input, init);
  }) as typeof fetch;

  dir = await makeTmpDir();
  const accountsFile = await makeAccountsFile(dir, [
    makeAccount({
      id: "alice",
      label: "Alice (GreenMail)",
      default: true,
      imap: { host: "127.0.0.1", port: 3143, user: "alice", pass: "pw1", tls: false },
      smtp: { host: "127.0.0.1", port: 3025, user: "alice", pass: "pw1", tls: false },
      mail: { defaultFrom: "alice@example.com", draftsFolder: "Drafts", sentFolder: null },
      caldav: { url: CALDAV_URL, user: "alice", pass: "dav-secret-never-sent" },
    }),
  ]);
  app = await startMcpApp({ accountsFile, authToken: AUTH_TOKEN });

  client = new Client({ name: "caldav-http-refusal-client", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${app.url}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${AUTH_TOKEN}` } },
    })
  );
});

after(async () => {
  await client?.close().catch(() => {});
  await app?.close().catch(() => {});
  globalThis.fetch = originalFetch;
  if (dir) await cleanupTmpDir(dir);
  if (DOCKER_AVAILABLE) composeDown();
});

test("list_events on that account is refused, and no request reaches the CalDAV server", SKIP, async () => {
  const result = await call("list_events", {
    account: "alice",
    calendar_url: `${CALDAV_URL}alice/calendar/`,
    start: "2026-10-01T00:00:00Z",
    end: "2026-10-08T00:00:00Z",
  });
  assert.equal(result.isError, true);
  const text = textOf(result);
  assert.match(text, /https:\/\//);
  assert.match(text, /Nothing was read or changed\./);
  assert.ok(!text.includes("dav-secret-never-sent"));
  assert.deepEqual(caldavRequests, []);
});

test("list_messages on the same account works", SKIP, async () => {
  const result = await call("list_messages", { account: "alice", mailbox: "INBOX", limit: 5 });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  JSON.parse(textOf(result));
  assert.deepEqual(caldavRequests, []);
});
