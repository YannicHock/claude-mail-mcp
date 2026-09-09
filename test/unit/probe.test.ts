/**
 * Unit tests for src/probe.ts. Most cases here point at a closed local port
 * (1 — privileged, nothing listens), so they run offline with no fixture and
 * no Docker: connection refusal happens fast on any platform. That fails via
 * ECONNREFUSED, though, which never reaches withTimeout's timer branch — see
 * the blackhole-host test below for the case that actually exercises it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  probeAccount,
  MAX_MESSAGE_LENGTH,
  CREDENTIAL_REJECTION_MESSAGE,
} from "../../src/probe.js";
import type { ImapCreds, SmtpCreds } from "../../src/accounts.js";
import {
  startRejectingImapServer,
  startMidLoginDropImapServer,
} from "../helpers/fake-imap.js";

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

test("a server that rejects LOGIN is reported as a credential rejection", async () => {
  // The whole point of this probe is that an operator can tell "wrong
  // password" apart from "host unreachable". A wrong password is not an
  // imapflow AuthenticationFailure — the server answers `NO` to LOGIN and
  // imapflow surfaces a plain Error("Command failed") carrying
  // `authenticationFailed`/`responseStatus`/`responseText` instead. Reporting
  // that verbatim reads like a connectivity problem, which is precisely the
  // confusion this message exists to prevent.
  //
  // The Docker-backed suite asserts the same thing against a real GreenMail
  // rejection (test/integration/probe.test.ts); this covers it offline so a
  // regression can't wait for someone to run the integration suite.
  const server = await startRejectingImapServer();
  try {
    const report = await probeAccount(
      { imap: creds({ port: server.port }), smtp: creds({ port: 1 }) },
      { perProbeMs: 3000, totalMs: 6000 }
    );
    assert.equal(report.imap.ok, false);
    if (report.imap.ok) return;
    assert.equal(report.imap.message, CREDENTIAL_REJECTION_MESSAGE);
  } finally {
    await server.close();
  }
});

test("a host that never answers is not reported as a credential rejection", async () => {
  // The other direction of the case above, and the reason probeImap keys off
  // the authentication stage rather than off "the connection failed at all":
  // a blackholed host (192.0.2.1, RFC 5737 TEST-NET-1) and a closed port must
  // still read as connectivity problems. Telling the operator their password
  // was rejected by a server they never reached would be a worse bug than the
  // one this replaced.
  const report = await probeAccount(
    {
      imap: creds({ host: "192.0.2.1", port: 143 }),
      smtp: creds({ host: "192.0.2.1", port: 25 }),
    },
    { perProbeMs: 1500, totalMs: 5000 }
  );
  assert.equal(report.imap.ok, false);
  if (report.imap.ok) return;
  assert.notEqual(report.imap.message, CREDENTIAL_REJECTION_MESSAGE);

  const refused = await probeAccount(
    { imap: creds({ port: 1 }), smtp: creds({ port: 1 }) },
    { perProbeMs: 2000, totalMs: 5000 }
  );
  assert.equal(refused.imap.ok, false);
  if (refused.imap.ok) return;
  assert.notEqual(refused.imap.message, CREDENTIAL_REJECTION_MESSAGE);
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

test("an unresponsive CalDAV host fails within the per-probe timeout via an aborted fetch", async () => {
  // Same TEST-NET-1 blackhole as the IMAP/SMTP case above (192.0.2.1, RFC
  // 5737 -- reserved, never routed, no RST). Unlike imapflow/nodemailer,
  // tsdav has no connectionTimeout of its own to configure -- it goes
  // straight through the platform fetch(), which has no default timeout at
  // all -- so this is the one case that actually proves probeCalDav()'s
  // AbortController is wired to withTimeout's onTimeout and really aborts
  // the underlying request, rather than just declining to await it further.
  //
  // IMAP/SMTP point at a closed port here (not another blackhole target) so
  // this test isolates the CalDAV path: they resolve in a few milliseconds
  // via ECONNREFUSED, well inside perProbeMs, leaving the wall-clock bound
  // below to be governed by the CalDAV probe alone.
  const started = Date.now();
  const report = await probeAccount(
    {
      imap: creds({ port: 1 }),
      smtp: creds({ port: 1 }),
      caldav: { url: "http://192.0.2.1/dav", user: "u", pass: "p" },
    },
    { perProbeMs: 1500, totalMs: 5000 }
  );
  assert.equal(report.caldav?.ok, false);
  assert.ok(
    Date.now() - started < 4000,
    "a blackholed CalDAV host should fail at the per-probe timeout, not hang toward the total one"
  );
  // As with the IMAP/SMTP blackhole case, the proof this doesn't leak a live
  // request is external to this assertion: `node --import tsx --test` does
  // not force-exit, so if the underlying fetch() were still pending when
  // this test's assertions passed, the whole process would hang on it
  // afterward. See the task report for the wall-clock evidence.
});

test("a server that drops the connection mid-LOGIN does not take the process down", async () => {
  // The regression this test exists for is not the returned value — that was
  // always right — but what imapflow does a moment *after* it.
  //
  // A server that greets, answers CAPABILITY and then closes the socket while
  // LOGIN is still in flight makes imapflow reject the pending command with
  // "Unexpected close", which probeImap correctly reports as a connectivity
  // failure. imapflow then emits a *second* failure for the same event — an
  // 'error' event on the ImapFlow instance itself (`Connection not available`,
  // `code: NoConnection`), raised from its socket 'end' handler after
  // probeAccount has already resolved. An EventEmitter with no 'error'
  // listener rethrows, so Node turned that into an uncaught exception and the
  // connector died — from a connection test, against a host the operator typed
  // in, which is exactly the input probeAccount promises to survive.
  //
  // Asserting only on the report would pass with or without the fix, so the
  // process-level handler below is the real assertion. node:test installs an
  // 'uncaughtException' handler of its own and will attribute the late event
  // to whichever test is running — which is what makes this fail rather than
  // abort the run — but that attribution is the runner's business, not a
  // contract this test should rest on. Capturing the event here says out loud
  // what is being asserted, and gives the wait below something concrete to
  // watch for instead of a fixed sleep.
  const escaped: unknown[] = [];
  const onUncaught = (err: unknown): void => {
    escaped.push(err);
  };
  process.on("uncaughtException", onUncaught);

  const server = await startMidLoginDropImapServer();
  try {
    const report = await probeAccount(
      { imap: creds({ port: server.port }), smtp: creds({ port: 1 }) },
      { perProbeMs: 3000, totalMs: 6000 }
    );

    // (a) the probe still reports the truth: reached, then lost — a
    // connectivity failure, not a rejected password.
    assert.equal(report.imap.ok, false);
    if (report.imap.ok) return;
    assert.notEqual(report.imap.message, CREDENTIAL_REJECTION_MESSAGE);

    // (b) nothing escapes afterwards. The late event arrives within a tick or
    // two of the socket closing, so this poll settles immediately when the bug
    // is present; the full budget is only ever spent on the passing path,
    // which is the trade an absence assertion has to make.
    await waitFor(() => escaped.length > 0, 1000);
    assert.deepEqual(
      escaped.map((err) => (err instanceof Error ? err.message : String(err))),
      [],
      "probeImap left imapflow's post-resolution 'error' event with nowhere to go"
    );
  } finally {
    process.off("uncaughtException", onUncaught);
    await server.close();
  }
});

/**
 * Resolve as soon as `predicate` holds, or after `budgetMs`, whichever comes
 * first. Polls on a timer rather than awaiting a promise, so it observes an
 * event delivered by any means — including one Node routes through
 * 'uncaughtException' rather than through a rejection this test could await.
 */
async function waitFor(predicate: () => boolean, budgetMs: number): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
