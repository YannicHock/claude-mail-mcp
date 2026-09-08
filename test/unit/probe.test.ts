/**
 * Unit tests for src/probe.ts. Most cases here point at a closed local port
 * (1 — privileged, nothing listens), so they run offline with no fixture and
 * no Docker: connection refusal happens fast on any platform. That fails via
 * ECONNREFUSED, though, which never reaches withTimeout's timer branch — see
 * the blackhole-host test below for the case that actually exercises it.
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

test("an unresponsive host fails within the per-probe timeout, not the library's own default", async () => {
  // 192.0.2.1 is TEST-NET-1 (RFC 5737): reserved for documentation, never
  // routed. Connecting to it blackholes — no RST, no response, ever — unlike
  // the closed-port cases above, which fail fast via ECONNREFUSED and never
  // reach withTimeout's timer branch at all. This is the one case that
  // actually proves probeImap/probeSmtp configure imapflow's/nodemailer's own
  // connectionTimeout down to perProbeMs, rather than leaving their 90s/120s
  // defaults running underneath a wrapper that only stopped watching them.
  const started = Date.now();
  const report = await probeAccount(
    {
      imap: creds({ host: "192.0.2.1", port: 143 }),
      smtp: creds({ host: "192.0.2.1", port: 25 }),
    },
    { perProbeMs: 1500, totalMs: 5000 }
  );
  assert.equal(report.imap.ok, false);
  assert.equal(report.smtp.ok, false);
  assert.ok(
    Date.now() - started < 4000,
    "a blackholed host should fail at the per-probe timeout, not linger toward the total one"
  );
  // The real proof this doesn't leak a live socket/ref'd timer is external to
  // this assertion: `node --import tsx --test` does not force-exit, so if
  // imapflow's or nodemailer's own default deadline (90s / 120s) were still
  // running underneath, the whole test *process* would hang for another
  // minute-plus after this test's assertions already passed. See the task
  // report for the wall-clock evidence of the full suite exiting promptly.
});

test("probeAccount resolves, never rejects, even if the total bound fires before any per-probe one would", async () => {
  // totalMs is deliberately far shorter than perProbeMs here, so the outer
  // withTimeout(runAll(), totalMs, ...) in probeAccount wins the race while
  // every per-probe call is still in flight. probeAccount's signature is
  // Promise<ProbeReport> -- it must resolve with an all-failed report on
  // this path, not reject, or every future caller (the settings HTTP
  // handler) would need a special case just for this one bound.
  //
  // No `caldav` input here deliberately: tsdav's fetch() has no configured
  // timeout at all (unlike imapflow/nodemailer, which is what Important
  // Finding 1 was about), so a blackholed CalDAV host would hang this test
  // on an OS-level TCP retry budget rather than exercising probeAccount's
  // own total-timeout handling. Fixing that is out of this round's scope.
  const report = await probeAccount(
    {
      imap: creds({ host: "192.0.2.1", port: 143 }),
      smtp: creds({ host: "192.0.2.1", port: 25 }),
    },
    { perProbeMs: 3000, totalMs: 200 }
  );
  assert.equal(report.imap.ok, false);
  assert.equal(report.smtp.ok, false);
  assert.equal(report.caldav, null);
});
