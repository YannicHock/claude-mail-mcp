/**
 * Unit tests for src/mail-tls.ts — when `tls: false` may fall back to
 * plaintext, where such a connection goes, and the options every IMAP and
 * SMTP connection is built with (#220).
 *
 * The resolver is injected throughout: no test here reaches a DNS server.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  localMailAddress,
  imapTlsOptions,
  smtpTlsOptions,
  isStartTlsUnavailable,
  type MailTlsDeps,
} from "../../src/mail-tls.js";

/** A resolver that answers from a table, and records every name it was asked. */
function resolver(table: Record<string, string[]>): MailTlsDeps & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    async resolveAddresses(hostname) {
      asked.push(hostname);
      const addresses = table[hostname];
      if (!addresses) throw new Error(`ENOTFOUND ${hostname}`);
      return addresses;
    },
  };
}

const NOWHERE = resolver({});

test("loopback and private address literals are local, as themselves, without a lookup", async () => {
  for (const [host, address] of [
    ["127.0.0.1", "127.0.0.1"],
    ["127.10.0.3", "127.10.0.3"],
    ["::1", "::1"],
    ["[::1]", "::1"],
    ["10.0.0.5", "10.0.0.5"],
    ["172.17.0.2", "172.17.0.2"],
    ["192.168.1.20", "192.168.1.20"],
    ["fd00::1", "fd00::1"],
    ["fe80::1", "fe80::1"],
    ["::ffff:127.0.0.1", "::ffff:127.0.0.1"],
  ] as const) {
    assert.equal(await localMailAddress(host, NOWHERE), address, host);
  }
  assert.deepEqual(NOWHERE.asked, []);
});

test("a public address literal is not local", async () => {
  for (const host of ["8.8.8.8", "192.0.2.1", "2a00:1450:4001::6d", "::ffff:8.8.8.8"]) {
    assert.equal(await localMailAddress(host, NOWHERE), null, host);
  }
});

test("a name that could be a public DNS name is never local, and is never looked up", async () => {
  // An attacker who can alter traffic can also answer a DNS query, so a
  // resolution that comes back private must not be what lets a public
  // server's name fall back to plaintext.
  const dns = resolver({
    "smtp.gmail.com": ["10.0.0.1"],
    "mail.example.com": ["192.168.0.10"],
    "imap.mailbox.org": ["127.0.0.1"],
  });
  for (const host of ["smtp.gmail.com", "mail.example.com", "imap.mailbox.org.", "SMTP.GMAIL.COM"]) {
    assert.equal(await localMailAddress(host, dns), null, host);
  }
  assert.deepEqual(dns.asked, []);
});

test("a single-label or special-use name is local at the address it resolved to", async () => {
  const dns = resolver({
    localhost: ["::1", "127.0.0.1"],
    "protonmail-bridge": ["172.18.0.4"],
    "bridge.localhost": ["127.0.0.1"],
    "host.docker.internal": ["192.168.65.254"],
    "nas.local": ["192.168.1.30"],
    "mail.home.arpa": ["fd12::3"],
  });
  // IPv4 first when there is one: a pinned connection has no other family to fall back to.
  assert.equal(await localMailAddress("localhost", dns), "127.0.0.1");
  assert.equal(await localMailAddress("LOCALHOST", dns), "127.0.0.1");
  assert.equal(await localMailAddress("protonmail-bridge", dns), "172.18.0.4");
  assert.equal(await localMailAddress("bridge.localhost", dns), "127.0.0.1");
  assert.equal(await localMailAddress("host.docker.internal", dns), "192.168.65.254");
  assert.equal(await localMailAddress("nas.local", dns), "192.168.1.30");
  assert.equal(await localMailAddress("mail.home.arpa", dns), "fd12::3");
});

test("a single-label name that resolves anywhere public is not local", async () => {
  // A search domain can turn `mail` into `mail.example.com`: then it is a
  // public server, typed short.
  const dns = resolver({
    mail: ["203.0.113.7"],
    mixed: ["10.0.0.2", "203.0.113.7"],
    empty: [],
  });
  assert.equal(await localMailAddress("mail", dns), null);
  assert.equal(await localMailAddress("mixed", dns), null);
  assert.equal(await localMailAddress("empty", dns), null);
});

test("a name that does not resolve is not local", async () => {
  assert.equal(await localMailAddress("greenmail", NOWHERE), null);
});

test("a plaintext connection goes to the address that was checked, and the name is resolved once", async () => {
  // The forgery the pinning stops: a resolver that answers the check with a
  // private address and a second lookup, the library's own at connect time,
  // with a public one. Were the connection made by name, that second answer
  // would get a plaintext LOGIN to a public host.
  let calls = 0;
  const flipping: MailTlsDeps = {
    async resolveAddresses() {
      calls += 1;
      return calls === 1 ? ["10.0.0.9"] : ["203.0.113.66"];
    },
  };
  const check = (host: string) => localMailAddress(host, flipping);

  assert.deepEqual(await imapTlsOptions("mailhost", false, check), {
    host: "10.0.0.9",
    servername: "mailhost",
    secure: false,
  });
  assert.equal(calls, 1, "one lookup per connection, and its answer is the host connected to");

  calls = 0;
  assert.deepEqual(await smtpTlsOptions("mailhost", false, check), {
    host: "10.0.0.9",
    servername: "mailhost",
    secure: false,
  });
  assert.equal(calls, 1);
});

const PUBLIC = async (): Promise<string | null> => null;

test("tls: true is implicit TLS by name, wherever the host is, and the host is not classified", async () => {
  const never = async (): Promise<string | null> => {
    throw new Error("a tls: true account has nothing to classify");
  };
  assert.deepEqual(await imapTlsOptions("imap.gmail.com", true, never), {
    host: "imap.gmail.com",
    secure: true,
  });
  assert.deepEqual(await smtpTlsOptions("smtp.gmail.com", true, never), {
    host: "smtp.gmail.com",
    secure: true,
  });
});

test("tls: false on a host that is not local requires STARTTLS, by name", async () => {
  assert.deepEqual(await imapTlsOptions("imap.gmail.com", false, PUBLIC), {
    host: "imap.gmail.com",
    secure: false,
    doSTARTTLS: true,
  });
  assert.deepEqual(await smtpTlsOptions("smtp.gmail.com", false, PUBLIC), {
    host: "smtp.gmail.com",
    secure: false,
    requireTLS: true,
  });
});

test("tls: false on a local address literal keeps opportunistic STARTTLS, at that literal", async () => {
  assert.deepEqual(await imapTlsOptions("127.0.0.1", false), { host: "127.0.0.1", secure: false });
  assert.deepEqual(await smtpTlsOptions("[::1]", false), { host: "::1", secure: false });
  assert.deepEqual(await smtpTlsOptions("192.0.2.1", false), {
    host: "192.0.2.1",
    secure: false,
    requireTLS: true,
  });
});

test("the two libraries' STARTTLS refusals are recognised, and nothing else is", () => {
  const imap = Object.assign(new Error("Server does not support STARTTLS"), { tlsFailed: true });
  const smtpRefused = Object.assign(new Error("Error upgrading connection with STARTTLS"), {
    code: "ETLS",
    command: "STARTTLS",
  });
  const smtpNoEhlo = Object.assign(
    new Error("EHLO failed but HELO does not support required STARTTLS. response=500 no"),
    { code: "ECONNECTION", command: "EHLO" }
  );
  assert.equal(isStartTlsUnavailable(imap), true);
  assert.equal(isStartTlsUnavailable(smtpRefused), true);
  assert.equal(isStartTlsUnavailable(smtpNoEhlo), true);

  // A certificate the client does not trust is a TLS failure too, but the
  // server did offer STARTTLS, and its own message says what went wrong.
  const badCert = Object.assign(new Error("Error initiating TLS - self-signed certificate"), {
    code: "ETLS",
    command: "STARTTLS",
  });
  const imapHandshake = Object.assign(new Error("self-signed certificate"), { tlsFailed: true });
  assert.equal(isStartTlsUnavailable(badCert), false);
  assert.equal(isStartTlsUnavailable(imapHandshake), false);
  assert.equal(isStartTlsUnavailable(new Error("connect ECONNREFUSED")), false);
  assert.equal(isStartTlsUnavailable("Server does not support STARTTLS"), false);
});
