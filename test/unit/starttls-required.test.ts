/**
 * `tls: false` against a server that does not offer STARTTLS (#220): refused
 * before the password is sent, by the probe and by both clients, unless the
 * host is local.
 *
 * The fake servers listen on 127.0.0.1, which is local by the rule in
 * src/mail-tls.ts. The cases that model a public server therefore inject a
 * classification that says "not local", which is the seam every connection
 * builder takes for exactly this. What the libraries then do on the wire is
 * real: the assertion is on what the server received, not on an option.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { probeAccount, CREDENTIAL_REJECTION_MESSAGE } from "../../src/probe.js";
import {
  STARTTLS_REQUIRED_MESSAGE,
  localMailAddress,
  type LocalAddress,
  type MailTlsDeps,
} from "../../src/mail-tls.js";
import { ImapClient } from "../../src/imap-client.js";
import { SmtpClient } from "../../src/smtp-client.js";
import type { ImapCreds, SmtpCreds } from "../../src/accounts.js";
import { startRejectingImapServer, startStartTlsRefusingImapServer } from "../helpers/fake-imap.js";
import { startNoStartTlsSmtpServer } from "../helpers/fake-smtp.js";

const NOT_LOCAL = async (): Promise<LocalAddress | null> => null;
const BOUNDS = { perProbeMs: 3000, totalMs: 6000 };

function creds(port: number): ImapCreds & SmtpCreds {
  return { host: "127.0.0.1", port, user: "user@example.invalid", pass: "test-secret", tls: false };
}

const sentLogin = (lines: readonly string[]): boolean =>
  lines.some((line) => /^\S+ (LOGIN|AUTHENTICATE)\b/i.test(line));
const sentAuth = (lines: readonly string[]): boolean => lines.some((line) => /^AUTH\b/i.test(line));
const sentMail = (lines: readonly string[]): boolean => lines.some((line) => /^MAIL FROM/i.test(line));

test("the probe refuses a public server without STARTTLS, and never sends the password", async () => {
  const imap = await startRejectingImapServer();
  const smtp = await startNoStartTlsSmtpServer();
  try {
    const report = await probeAccount(
      { imap: creds(imap.port), smtp: creds(smtp.port) },
      { ...BOUNDS, localAddress: NOT_LOCAL }
    );
    assert.deepEqual(report.imap, {
      ok: false,
      message: STARTTLS_REQUIRED_MESSAGE,
      credentialRejection: false,
    });
    assert.deepEqual(report.smtp, {
      ok: false,
      message: STARTTLS_REQUIRED_MESSAGE,
      credentialRejection: false,
    });
    assert.equal(sentLogin(imap.received), false, `IMAP saw: ${imap.received.join(" | ")}`);
    assert.equal(sentAuth(smtp.received), false, `SMTP saw: ${smtp.received.join(" | ")}`);
  } finally {
    await imap.close();
    await smtp.close();
  }
});

test("on a local host the probe still logs in without STARTTLS, as GreenMail needs", async () => {
  // The other half of the rule, and the reason it has two halves: the same
  // servers, classified as what they are, are logged in to in plaintext.
  const imap = await startRejectingImapServer();
  const smtp = await startNoStartTlsSmtpServer();
  try {
    const report = await probeAccount({ imap: creds(imap.port), smtp: creds(smtp.port) }, BOUNDS);
    assert.equal(report.imap.ok, false);
    if (report.imap.ok) return;
    assert.equal(report.imap.message, CREDENTIAL_REJECTION_MESSAGE);
    assert.equal(sentLogin(imap.received), true);
    assert.deepEqual(report.smtp, { ok: true });
    assert.equal(sentAuth(smtp.received), true);
  } finally {
    await imap.close();
    await smtp.close();
  }
});

test("ImapClient refuses a public server without STARTTLS before LOGIN", async () => {
  const imap = await startRejectingImapServer();
  const client = new ImapClient(
    { host: "127.0.0.1", port: imap.port, user: "u", pass: "test-secret", secure: false },
    { localAddress: NOT_LOCAL }
  );
  try {
    await assert.rejects(client.listMailboxes(), { message: STARTTLS_REQUIRED_MESSAGE });
    assert.equal(sentLogin(imap.received), false, `IMAP saw: ${imap.received.join(" | ")}`);
  } finally {
    await client.close();
    await imap.close();
  }
});

test("SmtpClient refuses a public server without STARTTLS before AUTH", async () => {
  const smtp = await startNoStartTlsSmtpServer();
  const client = new SmtpClient(
    { host: "127.0.0.1", port: smtp.port, user: "u", pass: "test-secret", secure: false },
    { from: "u@example.invalid" },
    { localAddress: NOT_LOCAL }
  );
  try {
    await assert.rejects(
      client.send({ to: "someone@example.invalid", subject: "s", text: "t" }),
      { message: STARTTLS_REQUIRED_MESSAGE }
    );
    assert.equal(sentAuth(smtp.received), false, `SMTP saw: ${smtp.received.join(" | ")}`);
    assert.equal(sentMail(smtp.received), false, "nothing of the message was sent either");
  } finally {
    await smtp.close();
  }
});

test("a server that advertises STARTTLS and refuses it, or refuses EHLO, is refused too", async () => {
  // The two other ways to keep a client off TLS: leave STARTTLS in the
  // capabilities and answer it NO, or answer EHLO with an error so the client
  // falls back to HELO, which has no STARTTLS at all.
  const imap = await startStartTlsRefusingImapServer();
  const smtp = await startNoStartTlsSmtpServer({ ehlo: "refused" });
  try {
    const report = await probeAccount(
      { imap: creds(imap.port), smtp: creds(smtp.port) },
      { ...BOUNDS, localAddress: NOT_LOCAL }
    );
    const refused = { ok: false, message: STARTTLS_REQUIRED_MESSAGE, credentialRejection: false };
    assert.deepEqual(report.imap, refused);
    assert.deepEqual(report.smtp, refused);
    assert.ok(imap.received.some((line) => /^\S+ STARTTLS$/i.test(line)), "STARTTLS was asked for");
    assert.equal(sentLogin(imap.received), false, `IMAP saw: ${imap.received.join(" | ")}`);
    assert.equal(sentAuth(smtp.received), false, `SMTP saw: ${smtp.received.join(" | ")}`);
    assert.equal(sentMail(smtp.received), false);

    const imapClient = new ImapClient(
      { host: "127.0.0.1", port: imap.port, user: "u", pass: "test-secret", secure: false },
      { localAddress: NOT_LOCAL }
    );
    await assert.rejects(imapClient.listMailboxes(), { message: STARTTLS_REQUIRED_MESSAGE });
    await imapClient.close();
    const smtpClient = new SmtpClient(
      { host: "127.0.0.1", port: smtp.port, user: "u", pass: "test-secret", secure: false },
      { from: "u@example.invalid" },
      { localAddress: NOT_LOCAL }
    );
    await assert.rejects(
      smtpClient.send({ to: "someone@example.invalid", subject: "s", text: "t" }),
      { message: STARTTLS_REQUIRED_MESSAGE }
    );
    assert.equal(sentLogin(imap.received), false);
    assert.equal(sentAuth(smtp.received), false);
    assert.equal(sentMail(smtp.received), false);
  } finally {
    await imap.close();
    await smtp.close();
  }
});

test("ImapClient connects again after a connect that failed, rather than repeating its failure", async () => {
  // The first connect is refused for STARTTLS; the second is classified local
  // and reaches LOGIN. Before the fix the second call got the first one's
  // rejected promise back, without a connection, and so did every call after.
  const imap = await startRejectingImapServer();
  let calls = 0;
  const client = new ImapClient(
    { host: "127.0.0.1", port: imap.port, user: "u", pass: "test-secret", secure: false },
    {
      localAddress: async (host) => {
        calls += 1;
        return calls === 1 ? null : { address: host };
      },
    }
  );
  try {
    await assert.rejects(client.listMailboxes(), { message: STARTTLS_REQUIRED_MESSAGE });
    assert.equal(sentLogin(imap.received), false);
    await assert.rejects(client.listMailboxes(), (err: Error) => err.message !== STARTTLS_REQUIRED_MESSAGE);
    assert.equal(calls, 2, "the second call connected again");
    assert.equal(sentLogin(imap.received), true);
  } finally {
    await client.close();
    await imap.close();
  }
});

test("a local name is logged in to at the address it was checked at, not looked up again", async () => {
  // The resolver answers the check with loopback and any lookup after it with
  // a public address. `fake-mail` exists in no real DNS either, so a client
  // that resolved the name itself would not reach the fake servers at all:
  // that IMAP LOGIN and SMTP AUTH both arrive proves each connection went to
  // the checked address, and the count that the name was looked up once per
  // connection, by the check alone.
  const imap = await startRejectingImapServer();
  const smtp = await startNoStartTlsSmtpServer();
  let lookups = 0;
  const flipping: MailTlsDeps = {
    async resolveAddresses() {
      lookups += 1;
      return lookups <= 2 ? ["127.0.0.1"] : ["203.0.113.66"];
    },
  };
  const localAddress = (host: string) => localMailAddress(host, flipping);
  const named = (port: number) => ({ ...creds(port), host: "fake-mail" });
  try {
    const report = await probeAccount(
      { imap: named(imap.port), smtp: named(smtp.port) },
      { ...BOUNDS, localAddress }
    );
    assert.equal(report.imap.ok, false);
    if (report.imap.ok) return;
    assert.equal(report.imap.message, CREDENTIAL_REJECTION_MESSAGE);
    assert.equal(sentLogin(imap.received), true);
    assert.deepEqual(report.smtp, { ok: true });
    assert.equal(sentAuth(smtp.received), true);
    assert.equal(lookups, 2, "one lookup per service, and none by the libraries");
  } finally {
    await imap.close();
    await smtp.close();
  }
});
