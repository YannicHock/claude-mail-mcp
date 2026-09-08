/**
 * Integration tests for src/probe.ts against a real mail server (GreenMail,
 * via docker-compose.test.yml) — the part a mocked ImapFlow/nodemailer can
 * never exercise: a real IMAP/SMTP handshake and a real authentication
 * failure from the server rather than a simulated one.
 *
 * probeAccount() is called directly; there's no MCP tool layer or accounts
 * store involved in a connection test, so this doesn't need the full
 * startMcpApp() harness that test/integration/mail-server.test.ts uses.
 *
 * If Docker is unavailable every test below is skipped with a clear reason
 * instead of failing (`npm run test:unit` is entirely unaffected either
 * way).
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";

import { probeAccount } from "../../src/probe.js";
import type { ImapCreds, SmtpCreds } from "../../src/accounts.js";
import { isDockerAvailable, composeUp, composeDown, waitForGreenmailReady } from "../helpers/docker.js";
import { ensureMailboxes } from "../helpers/imap-setup.js";

const DOCKER_AVAILABLE = isDockerAvailable();
const SKIP: { skip: string } | Record<string, never> = DOCKER_AVAILABLE
  ? {}
  : { skip: "Docker is not available — skipping integration tests against GreenMail" };

const GREENMAIL_HOST = "127.0.0.1";
const IMAP_PORT = 3143;
const SMTP_PORT = 3025;

function greenmailImap(): ImapCreds {
  return { host: GREENMAIL_HOST, port: IMAP_PORT, user: "alice", pass: "pw1", tls: false };
}

function greenmailSmtp(): SmtpCreds {
  return { host: GREENMAIL_HOST, port: SMTP_PORT, user: "alice", pass: "pw1", tls: false };
}

before(async () => {
  if (!DOCKER_AVAILABLE) return;
  composeUp();
  await waitForGreenmailReady();
  // GreenMail's `-Dgreenmail.users=...` accounts aren't necessarily
  // registered the instant the IMAP listener finishes its handshake (see
  // imap-setup.ts) — ensureMailboxes' connectWithRetry absorbs that race
  // for us; the empty mailbox list means it does nothing beyond that.
  await ensureMailboxes(greenmailImap(), []);
});

after(async () => {
  if (DOCKER_AVAILABLE) composeDown();
});

test("correct credentials against GreenMail report success", SKIP, async () => {
  const report = await probeAccount({ imap: greenmailImap(), smtp: greenmailSmtp() });
  assert.deepEqual(report.imap, { ok: true });
  assert.deepEqual(report.smtp, { ok: true });
});

test("a wrong password reports failure, not success", SKIP, async () => {
  const report = await probeAccount({
    imap: { ...greenmailImap(), pass: "wrong" },
    smtp: greenmailSmtp(),
  });
  assert.equal(report.imap.ok, false);
});
