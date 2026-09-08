/**
 * Integration tests against a real mail server (GreenMail, via
 * docker-compose.test.yml) — the part of this system that a mocked
 * ImapFlow/nodemailer can never exercise: real IMAP SEARCH/FETCH/MOVE/
 * APPEND semantics, a real SMTP round trip, and real UTF-8 handling over
 * the wire.
 *
 * TLS: GreenMail's plain ports (3143 IMAP, 3025 SMTP) advertise no
 * STARTTLS capability at all, so the test accounts use tls:false and there
 * is no self-signed certificate anywhere in this path — see
 * .superpowers/sdd/plan-dockerize-ci-tests/greenmail-findings.md. This repo
 * never sets NODE_TLS_REJECT_UNAUTHORIZED=0, here or anywhere else.
 *
 * Tests go through the real MCP tool layer (test/helpers/mcp-app.ts +
 * an actual MCP Client), not the IMAP/SMTP clients directly, so this also
 * exercises tools-mail.ts's handler logic (response shaping, the
 * best-effort Sent-folder copy, the text/html requirement) against a real
 * server — none of which has any other test coverage today.
 *
 * Tests within this file are intentionally ordered and share state (a
 * single sent message, threaded through list/search/get/mark/move) rather
 * than each re-sending their own message — cheaper against a real server
 * and closer to how one message is actually handled end-to-end. If Docker
 * is unavailable every test below is skipped with a clear reason instead
 * of failing (`npm run test:unit` is entirely unaffected either way).
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

const AUTH_TOKEN = "greenmail-test-token";
const GREENMAIL_HOST = "127.0.0.1";
const IMAP_PORT = 3143;
const SMTP_PORT = 3025;

function greenmailAccount(id: "alice" | "bob", label: string, isDefault: boolean) {
  const pass = id === "alice" ? "pw1" : "pw2";
  return makeAccount({
    id,
    label,
    default: isDefault,
    imap: { host: GREENMAIL_HOST, port: IMAP_PORT, user: id, pass, tls: false },
    smtp: { host: GREENMAIL_HOST, port: SMTP_PORT, user: id, pass, tls: false },
    mail: { defaultFrom: `${id}@example.com`, draftsFolder: "Drafts", sentFolder: null },
  });
}

let dir: string | undefined;
let app: McpTestApp | undefined;
let client: Client | undefined;

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const result = (await client!.callTool({ name, arguments: args })) as CallToolResult;
  if (result.isError) {
    throw new Error(`Tool "${name}" returned an error result: ${JSON.stringify(result)}`);
  }
  const first = result.content[0];
  if (!first || first.type !== "text") {
    throw new Error(`Tool "${name}" returned no text content: ${JSON.stringify(result)}`);
  }
  return JSON.parse(first.text);
}

before(async () => {
  if (!DOCKER_AVAILABLE) return;

  composeUp();
  await waitForGreenmailReady();

  await ensureMailboxes(
    { host: GREENMAIL_HOST, port: IMAP_PORT, user: "alice", pass: "pw1" },
    ["Drafts", "Archive"]
  );
  await ensureMailboxes(
    { host: GREENMAIL_HOST, port: IMAP_PORT, user: "bob", pass: "pw2" },
    ["Drafts", "Archive"]
  );

  dir = await makeTmpDir();
  const accountsFile = await makeAccountsFile(dir, [
    greenmailAccount("alice", "Alice (GreenMail)", true),
    greenmailAccount("bob", "Bob (GreenMail)", false),
  ]);
  app = await startMcpApp({ accountsFile, authToken: AUTH_TOKEN });

  client = new Client({ name: "integration-test-client", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${app.url}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${AUTH_TOKEN}` } },
  });
  await client.connect(transport);
});

after(async () => {
  await client?.close().catch(() => {});
  await app?.close().catch(() => {});
  if (dir) await cleanupTmpDir(dir);
  if (DOCKER_AVAILABLE) composeDown();
});

const uniqueTag = `it-${Date.now()}`;
const subject = `Grüße mit Umlaut ${uniqueTag}`;
// Deliberately packed with umlauts and ß, per the task brief's UTF-8
// requirement — mailparser/nodemailer must round-trip this byte-for-byte.
const body = "Öffnungszeiten: Mo–Fr 9–17 Uhr. Grüße, Ärger, Übermut, Straße.";

let sentUid: number;

test("list_folders finds INBOX for both accounts", SKIP, async () => {
  for (const account of ["alice", "bob"]) {
    const folders = (await callTool("list_folders", { account })) as Array<{ path: string }>;
    assert.ok(
      folders.some((f) => f.path === "INBOX"),
      `expected INBOX in ${account}'s folder list, got: ${JSON.stringify(folders)}`
    );
  }
});

test("send_message delivers via SMTP with no rejected recipients", SKIP, async () => {
  const result = (await callTool("send_message", {
    account: "alice",
    to: "bob@example.com",
    subject,
    text: body,
  })) as { accepted: string[]; rejected: string[] };
  assert.deepEqual(result.rejected, []);
  assert.ok(result.accepted.includes("bob@example.com"));
});

test("list_messages shows the delivered message with correct subject and sender", SKIP, async () => {
  const result = (await callTool("list_messages", {
    account: "bob",
    mailbox: "INBOX",
  })) as { messages: Array<{ uid: number; subject: string; from: string }> };
  const msg = result.messages.find((m) => m.subject === subject);
  assert.ok(msg, `expected "${subject}" in bob's INBOX, got: ${JSON.stringify(result.messages)}`);
  assert.match(msg!.from, /alice@example\.com/);
  sentUid = msg!.uid;
});

test("search_messages finds it by sender and by subject", SKIP, async () => {
  const bySubject = (await callTool("search_messages", {
    account: "bob",
    mailbox: "INBOX",
    subject: uniqueTag,
  })) as { messages: Array<{ uid: number }> };
  assert.ok(bySubject.messages.some((m) => m.uid === sentUid), "subject search missed the message");

  const byFrom = (await callTool("search_messages", {
    account: "bob",
    mailbox: "INBOX",
    from: "alice@example.com",
  })) as { messages: Array<{ uid: number }> };
  assert.ok(byFrom.messages.some((m) => m.uid === sentUid), "from search missed the message");
});

test("get_message returns full body and headers with correct UTF-8 handling", SKIP, async () => {
  const detail = (await callTool("get_message", {
    account: "bob",
    mailbox: "INBOX",
    uid: sentUid,
  })) as { subject: string; bodyText: string | null; from: string; flags: string[] };
  assert.equal(detail.subject, subject);
  assert.equal(detail.bodyText?.trim(), body);
  assert.match(detail.from, /alice@example\.com/);
  assert.ok(!detail.flags.includes("\\Seen"), "message should still be unread at this point");
});

test("mark_read sets \\Seen and a follow-up call sees it", SKIP, async () => {
  await callTool("mark_read", { account: "bob", mailbox: "INBOX", uid: sentUid, read: true });
  const detail = (await callTool("get_message", {
    account: "bob",
    mailbox: "INBOX",
    uid: sentUid,
  })) as { flags: string[] };
  assert.ok(detail.flags.includes("\\Seen"));
});

test("move_message moves the message from INBOX to Archive", SKIP, async () => {
  await callTool("move_message", {
    account: "bob",
    source_mailbox: "INBOX",
    uid: sentUid,
    destination_mailbox: "Archive",
  });

  const archive = (await callTool("list_messages", {
    account: "bob",
    mailbox: "Archive",
  })) as { messages: Array<{ subject: string }> };
  assert.ok(archive.messages.some((m) => m.subject === subject), "message not found in Archive");

  const inbox = (await callTool("list_messages", {
    account: "bob",
    mailbox: "INBOX",
  })) as { messages: Array<{ subject: string }> };
  assert.ok(!inbox.messages.some((m) => m.subject === subject), "message still present in INBOX");
});

test("create_draft lands in the Drafts folder", SKIP, async () => {
  const draftSubject = `Draft ${uniqueTag}`;
  const result = (await callTool("create_draft", {
    account: "alice",
    to: "bob@example.com",
    subject: draftSubject,
    text: "This is a draft, not sent.",
  })) as { success: boolean; folder: string };
  assert.equal(result.success, true);
  assert.equal(result.folder, "Drafts");

  const drafts = (await callTool("list_messages", {
    account: "alice",
    mailbox: "Drafts",
  })) as { messages: Array<{ subject: string }> };
  assert.ok(drafts.messages.some((m) => m.subject === draftSubject));
});

test("multi-account: the `account` parameter addresses the right mailbox", SKIP, async () => {
  // alice sent the earlier message to bob and has no Sent-folder copy
  // configured (sentFolder: null) — so if `account` routing were broken
  // (e.g. both calls silently hit the same mailbox) this message would
  // show up here too.
  const aliceInbox = (await callTool("list_messages", {
    account: "alice",
    mailbox: "INBOX",
  })) as { messages: Array<{ subject: string }> };
  assert.ok(
    !aliceInbox.messages.some((m) => m.subject === subject),
    "alice's INBOX unexpectedly contains the message addressed to bob"
  );

  const accounts = (await callTool("list_accounts", {})) as {
    accounts: Array<{ id: string; smtp_from: string }>;
  };
  const byId = new Map(accounts.accounts.map((a) => [a.id, a]));
  assert.deepEqual([...byId.keys()].sort(), ["alice", "bob"]);
  assert.equal(byId.get("alice")?.smtp_from, "alice@example.com");
  assert.equal(byId.get("bob")?.smtp_from, "bob@example.com");
});
