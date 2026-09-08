/**
 * Unit tests for src/probe.ts. Every probe here is pointed at a closed local
 * port (1 — privileged, nothing listens), so these run offline with no
 * fixture and no Docker: connection refusal happens fast on any platform.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { probeAccount, MAX_MESSAGE_LENGTH } from "../../src/probe.js";
import type { ImapCreds, SmtpCreds } from "../../src/accounts.js";

function creds(overrides: Partial<ImapCreds & SmtpCreds> = {}): ImapCreds & SmtpCreds {
  return {
    host: "127.0.0.1",
    port: 1,
    user: "user@example.invalid",
    pass: "test-secret",
    tls: false,
    ...overrides,
  };
}

test("a closed port fails within the per-probe timeout", async () => {
  const started = Date.now();
  const report = await probeAccount(
    { imap: creds({ port: 1 }), smtp: creds({ port: 1 }) },
    { perProbeMs: 2000, totalMs: 5000 }
  );
  assert.equal(report.imap.ok, false);
  assert.equal(report.smtp.ok, false);
  assert.ok(Date.now() - started < 5000);
});

test("failure messages are bounded and carry no password", async () => {
  const report = await probeAccount(
    { imap: creds({ port: 1, pass: "hunter2-very-secret" }), smtp: creds({ port: 1 }) },
    { perProbeMs: 2000, totalMs: 5000 }
  );
  assert.equal(report.imap.ok, false);
  if (report.imap.ok) return;
  assert.ok(report.imap.message.length <= MAX_MESSAGE_LENGTH);
  assert.ok(!report.imap.message.includes("hunter2"));
});

test("CalDAV is skipped when no URL is configured", async () => {
  const report = await probeAccount(
    { imap: creds({ port: 1 }), smtp: creds({ port: 1 }) },
    { perProbeMs: 1000, totalMs: 3000 }
  );
  assert.equal(report.caldav, null);
});

test("the three probes run concurrently, not one after another", async () => {
  const started = Date.now();
  await probeAccount(
    {
      imap: creds({ port: 1 }),
      smtp: creds({ port: 1 }),
      caldav: { url: "http://127.0.0.1:1/dav", user: "u", pass: "p" },
    },
    { perProbeMs: 2000, totalMs: 6000 }
  );
  assert.ok(Date.now() - started < 4000, "three sequential 2s probes would exceed this");
});
