/**
 * Unit tests for the CalDAV half of src/probe.ts — specifically, that its
 * three outcomes stay three distinct outcomes.
 *
 * The probe exists so an operator can tell "these credentials are wrong" apart
 * from "this host is unreachable". The CalDAV path could not: tsdav loses the
 * server's `401` on the discovery path, so a rejected password came back as
 * `cannot find principalUrl`, which reads as neither of those things. Each
 * test below pins one of the three answers, and they are kept in one file so
 * that a change which collapses two of them into one fails loudly.
 *
 * IMAP and SMTP point at port 1 (privileged, nothing listens) throughout:
 * they fail in milliseconds via ECONNREFUSED, so every wall-clock bound here
 * is governed by the CalDAV probe alone.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  probeAccount,
  MAX_MESSAGE_LENGTH,
  CREDENTIAL_REJECTION_MESSAGE,
  CALDAV_DISCOVERY_FAILURE_PREFIX,
} from "../../src/probe.js";
import type { ImapCreds, SmtpCreds } from "../../src/accounts.js";
import { startFakeCalDavServer } from "../helpers/fake-caldav.js";

function closedPort(): ImapCreds & SmtpCreds {
  return {
    host: "127.0.0.1",
    port: 1,
    user: "user@example.invalid",
    pass: "test-secret",
    tls: false,
  };
}

test("a CalDAV endpoint that answers 401 is reported as a credential rejection", async () => {
  // The defect this covers: tsdav's createAccount() walks a list of candidate
  // root URLs and keeps only the *last* failure, so the `401` from the URL the
  // operator actually configured is routinely replaced by `cannot find
  // principalUrl` from some other candidate. Even when it does survive, it
  // arrives as free-form prose ("Invalid credentials: PROPFIND … returned 401
  // Unauthorized"), not as anything a caller can classify on.
  //
  // The wording asserted here is the same constant the IMAP probe reports, on
  // purpose: the operator is being told one of two things, and which library
  // happened to be involved is not part of the answer.
  const server = await startFakeCalDavServer("reject-credentials");
  try {
    const report = await probeAccount(
      {
        imap: closedPort(),
        smtp: closedPort(),
        caldav: { url: server.url, user: "u", pass: "wrong-password" },
      },
      { perProbeMs: 3000, totalMs: 6000 }
    );
    assert.equal(report.caldav?.ok, false);
    if (!report.caldav || report.caldav.ok) return;
    assert.equal(report.caldav.message, CREDENTIAL_REJECTION_MESSAGE);
  } finally {
    await server.close();
  }
});

test("an unreachable CalDAV host is not reported as a credential rejection", async () => {
  // The other direction, and the reason the pre-flight classifies on the
  // server's *answer* rather than on "the probe failed at all". Telling an
  // operator their password was rejected by a host they never reached would be
  // a worse bug than the one this replaced.
  //
  // Both flavours of unreachable are covered: a closed port (fast RST) and a
  // blackholed address (192.0.2.1, RFC 5737 TEST-NET-1 — reserved, never
  // routed, no RST at all), which is the one that reaches the abort path.
  const refused = await probeAccount(
    {
      imap: closedPort(),
      smtp: closedPort(),
      caldav: { url: "http://127.0.0.1:1/dav", user: "u", pass: "p" },
    },
    { perProbeMs: 2000, totalMs: 5000 }
  );
  assert.equal(refused.caldav?.ok, false);
  if (!refused.caldav || refused.caldav.ok) return;
  assert.notEqual(refused.caldav.message, CREDENTIAL_REJECTION_MESSAGE);

  const blackholed = await probeAccount(
    {
      imap: closedPort(),
      smtp: closedPort(),
      caldav: { url: "http://192.0.2.1/dav", user: "u", pass: "p" },
    },
    { perProbeMs: 1500, totalMs: 5000 }
  );
  assert.equal(blackholed.caldav?.ok, false);
  if (!blackholed.caldav || blackholed.caldav.ok) return;
  assert.notEqual(blackholed.caldav.message, CREDENTIAL_REJECTION_MESSAGE);
});

test("a reachable URL that is not a CalDAV endpoint is its own third answer", async () => {
  // Reachable, answers, does not refuse anything — and still is not a
  // calendar. Before the fix this was indistinguishable from a rejected
  // password: both arrived as tsdav's `cannot find principalUrl`. The probe
  // now says which side of its own pre-flight the failure happened on, so this
  // case can be neither mistaken for a wrong password nor for a dead host.
  const server = await startFakeCalDavServer("not-caldav");
  try {
    const report = await probeAccount(
      {
        imap: closedPort(),
        smtp: closedPort(),
        caldav: { url: server.url, user: "u", pass: "hunter2-very-secret" },
      },
      { perProbeMs: 5000, totalMs: 8000 }
    );
    assert.equal(report.caldav?.ok, false);
    if (!report.caldav || report.caldav.ok) return;
    assert.notEqual(report.caldav.message, CREDENTIAL_REJECTION_MESSAGE);
    assert.ok(
      report.caldav.message.startsWith(CALDAV_DISCOVERY_FAILURE_PREFIX),
      `expected a discovery failure, got: ${report.caldav.message}`
    );
    // The same two guarantees every other probe message carries: bounded, and
    // no credentials in it. Worth restating here because this is the one
    // message that wraps a second message from a third-party library.
    assert.ok(report.caldav.message.length <= MAX_MESSAGE_LENGTH);
    assert.ok(!report.caldav.message.includes("hunter2"));
  } finally {
    await server.close();
  }
});

test("a rejected CalDAV password is reported without waiting on discovery", async () => {
  // The pre-flight is one request. If it ever ended up behind tsdav's
  // discovery — or ran in addition to a full discovery pass — this would still
  // pass its assertions but take several round trips to do it, so the bound is
  // part of the claim.
  const server = await startFakeCalDavServer("reject-credentials");
  try {
    const started = Date.now();
    const report = await probeAccount(
      {
        imap: closedPort(),
        smtp: closedPort(),
        caldav: { url: server.url, user: "u", pass: "p" },
      },
      { perProbeMs: 3000, totalMs: 6000 }
    );
    assert.equal(report.caldav?.ok, false);
    assert.ok(Date.now() - started < 2000, "a local 401 should come back immediately");
  } finally {
    await server.close();
  }
});
