/**
 * Unit tests for src/autoconfig.ts — tier 1 of the setup wizard's step-2
 * cascade.
 *
 * Every test here is offline. The four network-facing operations the module
 * performs (resolving a hostname, one HTTPS GET, one SRV query, and reading a
 * capped body off a stream) go through the injectable `AutoconfigDeps` seam,
 * so the cascade, the redirect handling and the address rules are exercised
 * for real against fixtures rather than against the internet. The one
 * exception is the real resolver test at the bottom, which resolves
 * `localhost` — served from the hosts file, no outbound traffic.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";

import {
  lookupMailboxSettings,
  readCapped,
  isPublicIp,
  resolveSafeUrl,
  defaultDeps,
  MAX_RESPONSE_BYTES,
  type AutoconfigDeps,
  type HttpResponse,
  type SrvRecord,
} from "../../src/autoconfig.js";

const EMAIL = "anna@example.com";

const T1 = "https://autoconfig.example.com/mail/config-v1.1.xml?emailaddress=anna%40example.com";
const T2 = "https://example.com/.well-known/autoconfig/mail/config-v1.1.xml";
const T3 = "https://autoconfig.thunderbird.net/v1.1/example.com";
const CALDAV_WELL_KNOWN = "https://example.com/.well-known/caldav";

/** A Mozilla clientConfig document as the real endpoints serve one. */
function clientConfigXml(opts: { imapSocket?: string; smtpSocket?: string } = {}): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- a comment the parser must not read tags out of: <incomingServer type="imap"> -->
<clientConfig version="1.1">
  <emailProvider id="example.com">
    <domain>example.com</domain>
    <displayName>Example &amp; Co</displayName>
    <incomingServer type="pop3">
      <hostname>pop.example.com</hostname>
      <port>995</port>
      <socketType>SSL</socketType>
      <username>%EMAILADDRESS%</username>
      <authentication>password-cleartext</authentication>
    </incomingServer>
    <incomingServer type="imap">
      <hostname>imap.example.com</hostname>
      <port>993</port>
      <socketType>${opts.imapSocket ?? "SSL"}</socketType>
      <username>%EMAILADDRESS%</username>
      <authentication>password-cleartext</authentication>
    </incomingServer>
    <outgoingServer type="smtp">
      <hostname>smtp.example.com</hostname>
      <port>465</port>
      <socketType>${opts.smtpSocket ?? "SSL"}</socketType>
      <username>%EMAILLOCALPART%</username>
      <authentication>password-cleartext</authentication>
    </outgoingServer>
  </emailProvider>
</clientConfig>`;
}

interface FakeOptions {
  /** url → response, or a function for redirects/errors. */
  pages?: Record<string, HttpResponse | (() => Promise<HttpResponse>)>;
  /** hostname → addresses. Anything unlisted resolves to a public address. */
  addresses?: Record<string, string[]>;
  srv?: Record<string, SrvRecord[]>;
}

interface FakeDeps extends AutoconfigDeps {
  fetched: string[];
  resolved: string[];
}

function fakeDeps(opts: FakeOptions = {}): FakeDeps {
  const fetched: string[] = [];
  const resolved: string[] = [];
  return {
    fetched,
    resolved,
    async resolveAddresses(hostname) {
      resolved.push(hostname);
      return opts.addresses?.[hostname] ?? ["93.184.216.34"];
    },
    async httpsGet(url) {
      fetched.push(url.toString());
      const page = opts.pages?.[url.toString()];
      if (!page) throw new Error("404");
      return typeof page === "function" ? page() : page;
    },
    async resolveSrv(name) {
      const records = opts.srv?.[name];
      if (!records) throw new Error("ENOTFOUND");
      return records;
    },
  };
}

function ok(body: string): HttpResponse {
  return { status: 200, location: null, body };
}

function redirect(location: string): HttpResponse {
  return { status: 301, location, body: "" };
}

/** Deps that fail the test if the module touches the network at all. */
function forbiddenDeps(): AutoconfigDeps {
  return {
    async resolveAddresses(hostname) {
      assert.fail(`unexpected DNS lookup for ${hostname}`);
    },
    async httpsGet(url) {
      assert.fail(`unexpected fetch of ${url.toString()}`);
    },
    async resolveSrv(name) {
      assert.fail(`unexpected SRV query for ${name}`);
    },
  };
}

// ---------------------------------------------------------------- the cascade

test("tier 1: autoconfig.<domain> answers and wins", async () => {
  const deps = fakeDeps({ pages: { [T1]: ok(clientConfigXml()) } });
  const found = await lookupMailboxSettings(EMAIL, { deps });

  assert.ok(found, "expected a suggestion");
  assert.equal(found.source, "autoconfig-subdomain");
  assert.equal(found.domain, "example.com");
  assert.deepEqual(found.imap, {
    host: "imap.example.com",
    port: 993,
    tls: true,
    socketType: "SSL",
    user: "anna@example.com",
  });
  assert.deepEqual(found.smtp, {
    host: "smtp.example.com",
    port: 465,
    tls: true,
    socketType: "SSL",
    user: "anna",
  });
  // Later tiers must not run once one has answered.
  assert.deepEqual(deps.fetched, [T1, CALDAV_WELL_KNOWN]);
});

test("tier 2: the well-known path is tried when the subdomain has nothing", async () => {
  const deps = fakeDeps({ pages: { [T2]: ok(clientConfigXml()) } });
  const found = await lookupMailboxSettings(EMAIL, { deps });

  assert.equal(found?.source, "autoconfig-well-known");
  assert.equal(found?.imap.host, "imap.example.com");
});

test("tier 3: the ISPDB is tried when the domain itself has nothing", async () => {
  const deps = fakeDeps({ pages: { [T3]: ok(clientConfigXml()) } });
  const found = await lookupMailboxSettings(EMAIL, { deps });

  assert.equal(found?.source, "ispdb");
  assert.ok(deps.fetched.includes(T3));
});

test("tier 4: RFC 6186 SRV records, when no autoconfig document exists anywhere", async () => {
  const deps = fakeDeps({
    srv: {
      "_imaps._tcp.example.com": [
        { name: "imap2.example.com", port: 993, priority: 20, weight: 1 },
        { name: "imap1.example.com", port: 993, priority: 10, weight: 1 },
      ],
      "_submission._tcp.example.com": [
        { name: "smtp.example.com", port: 587, priority: 10, weight: 1 },
      ],
    },
  });
  const found = await lookupMailboxSettings(EMAIL, { deps });

  assert.equal(found?.source, "dns-srv");
  // Lowest priority wins.
  assert.equal(found?.imap.host, "imap1.example.com");
  assert.equal(found?.imap.tls, true);
  assert.equal(found?.smtp.host, "smtp.example.com");
  assert.equal(found?.smtp.port, 587);
  assert.equal(found?.smtp.socketType, "STARTTLS");
  assert.equal(found?.smtp.tls, false, "STARTTLS is not an implicit-TLS socket");
});

test('an SRV target of "." means the service is not offered', async () => {
  const deps = fakeDeps({
    srv: {
      "_imaps._tcp.example.com": [{ name: ".", port: 0, priority: 0, weight: 0 }],
      "_submission._tcp.example.com": [
        { name: "smtp.example.com", port: 587, priority: 10, weight: 1 },
      ],
    },
  });
  assert.equal(await lookupMailboxSettings(EMAIL, { deps }), null);
});

test("an unknown domain falls through to nothing, without throwing", async () => {
  const deps = fakeDeps();
  assert.equal(await lookupMailboxSettings(EMAIL, { deps }), null);
});

test("a malformed address is refused before anything is resolved or fetched", async () => {
  for (const bad of ["", "anna", "anna@", "@example.com", "anna@localhost", "anna@[127.0.0.1]", "a b@example.com"]) {
    assert.equal(await lookupMailboxSettings(bad, { deps: forbiddenDeps() }), null, bad);
  }
});

test("the suggestion has no password field to apply silently", async () => {
  const deps = fakeDeps({ pages: { [T1]: ok(clientConfigXml()) } });
  const found = await lookupMailboxSettings(EMAIL, { deps });

  assert.ok(found);
  assert.ok(!("pass" in found.imap), "a suggestion must never carry credentials");
  assert.ok(!("pass" in found.smtp));
});

// ------------------------------------------------------------------- the XML

test("a STARTTLS document maps onto tls:false, not a dropped result", async () => {
  const deps = fakeDeps({
    pages: { [T1]: ok(clientConfigXml({ imapSocket: "STARTTLS", smtpSocket: "STARTTLS" })) },
  });
  const found = await lookupMailboxSettings(EMAIL, { deps });

  assert.equal(found?.imap.socketType, "STARTTLS");
  assert.equal(found?.imap.tls, false);
  assert.equal(found?.smtp.tls, false);
});

test("a plaintext-only document is refused rather than suggested", async () => {
  const deps = fakeDeps({
    pages: { [T1]: ok(clientConfigXml({ imapSocket: "plain", smtpSocket: "plain" })) },
  });
  assert.equal(await lookupMailboxSettings(EMAIL, { deps }), null);
});

test("a document without an outgoing server is not half a suggestion", async () => {
  const xml = `<clientConfig version="1.1"><emailProvider id="example.com">
    <incomingServer type="imap"><hostname>imap.example.com</hostname><port>993</port>
    <socketType>SSL</socketType></incomingServer></emailProvider></clientConfig>`;
  const deps = fakeDeps({ pages: { [T1]: ok(xml) } });
  assert.equal(await lookupMailboxSettings(EMAIL, { deps }), null);
});

test("junk in place of XML falls through to the next tier", async () => {
  const deps = fakeDeps({
    pages: { [T1]: ok("<html><body>404 not found</body></html>"), [T2]: ok(clientConfigXml()) },
  });
  const found = await lookupMailboxSettings(EMAIL, { deps });
  assert.equal(found?.source, "autoconfig-well-known");
});

// ------------------------------------------------------------- the SSRF rules

test("a host that resolves to a loopback address is never fetched", async () => {
  const deps = fakeDeps({
    pages: { [T1]: ok(clientConfigXml()) },
    addresses: { "autoconfig.example.com": ["127.0.0.1"] },
  });
  const found = await lookupMailboxSettings(EMAIL, { deps });

  assert.equal(found, null);
  assert.ok(!deps.fetched.includes(T1), "the guard must run before the request");
});

test("a host that resolves to an RFC 1918 address is never fetched", async () => {
  for (const addr of ["10.0.0.5", "172.16.4.1", "192.168.1.1"]) {
    const deps = fakeDeps({
      pages: { [T1]: ok(clientConfigXml()) },
      addresses: { "autoconfig.example.com": [addr] },
    });
    assert.equal(await lookupMailboxSettings(EMAIL, { deps }), null, addr);
    assert.ok(!deps.fetched.includes(T1), addr);
  }
});

test("a host that resolves to the link-local metadata address is never fetched", async () => {
  const deps = fakeDeps({
    pages: { [T1]: ok(clientConfigXml()) },
    addresses: { "autoconfig.example.com": ["169.254.169.254"] },
  });
  assert.equal(await lookupMailboxSettings(EMAIL, { deps }), null);
  assert.ok(!deps.fetched.includes(T1));
});

test("one private address among several public ones still refuses the host", async () => {
  const deps = fakeDeps({
    pages: { [T1]: ok(clientConfigXml()) },
    addresses: { "autoconfig.example.com": ["93.184.216.34", "10.0.0.5"] },
  });
  assert.equal(await lookupMailboxSettings(EMAIL, { deps }), null);
  assert.ok(!deps.fetched.includes(T1));
});

test("a host with no addresses at all is refused", async () => {
  const deps = fakeDeps({
    pages: { [T1]: ok(clientConfigXml()) },
    addresses: { "autoconfig.example.com": [] },
  });
  assert.equal(await lookupMailboxSettings(EMAIL, { deps }), null);
  assert.ok(!deps.fetched.includes(T1));
});

test("a redirect to a private address is refused, and its body never read", async () => {
  const deps = fakeDeps({
    pages: {
      [T1]: redirect("https://internal.example.com/mail/config-v1.1.xml"),
      "https://internal.example.com/mail/config-v1.1.xml": ok(clientConfigXml()),
    },
    addresses: { "internal.example.com": ["10.1.2.3"] },
  });
  const found = await lookupMailboxSettings(EMAIL, { deps });

  assert.equal(found, null);
  assert.ok(
    !deps.fetched.includes("https://internal.example.com/mail/config-v1.1.xml"),
    "the redirect target must be refused before it is requested"
  );
});

test("a redirect to http is refused even though the first hop was https", async () => {
  const deps = fakeDeps({
    pages: {
      [T1]: redirect("http://autoconfig.example.com/mail/config-v1.1.xml"),
      "http://autoconfig.example.com/mail/config-v1.1.xml": ok(clientConfigXml()),
    },
  });
  const found = await lookupMailboxSettings(EMAIL, { deps });

  assert.equal(found, null);
  assert.ok(!deps.fetched.some((u) => u.startsWith("http://")));
});

test("one redirect is followed; a second is not", async () => {
  const one = fakeDeps({
    pages: {
      [T1]: redirect("https://cdn.example.com/config.xml"),
      "https://cdn.example.com/config.xml": ok(clientConfigXml()),
    },
  });
  const found = await lookupMailboxSettings(EMAIL, { deps: one });
  assert.equal(found?.imap.host, "imap.example.com");

  const two = fakeDeps({
    pages: {
      [T1]: redirect("https://cdn.example.com/a.xml"),
      "https://cdn.example.com/a.xml": redirect("https://cdn.example.com/b.xml"),
      "https://cdn.example.com/b.xml": ok(clientConfigXml()),
    },
  });
  assert.equal(await lookupMailboxSettings(EMAIL, { deps: two }), null);
  assert.ok(!two.fetched.includes("https://cdn.example.com/b.xml"));
});

test("a redirect with no Location header is not followed", async () => {
  const deps = fakeDeps({
    pages: { [T1]: { status: 302, location: null, body: "" } },
  });
  assert.equal(await lookupMailboxSettings(EMAIL, { deps }), null);
});

test("isPublicIp knows the ranges the cascade must refuse", () => {
  for (const addr of [
    "0.0.0.0",
    "127.0.0.1",
    "127.9.9.9",
    "10.0.0.1",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.0.1",
    "169.254.169.254",
    "100.64.0.1",
    "198.18.0.1",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "fe80::1",
    "fc00::1",
    "fd12:3456::1",
    "ff02::1",
    "::ffff:127.0.0.1",
    "::ffff:10.0.0.1",
    "not-an-ip",
  ]) {
    assert.equal(isPublicIp(addr), false, addr);
  }
  for (const addr of ["93.184.216.34", "8.8.8.8", "172.32.0.1", "2606:4700:4700::1111"]) {
    assert.equal(isPublicIp(addr), true, addr);
  }
});

test("resolveSafeUrl refuses a real hostname that resolves into loopback", async () => {
  // localhost comes from the hosts file — no outbound traffic, but it does
  // exercise the shipped resolver rather than a stub.
  const url = new URL("https://localhost/.well-known/autoconfig/mail/config-v1.1.xml");
  assert.equal(await resolveSafeUrl(url, defaultDeps, 3000), null);
});

test("resolveSafeUrl refuses a non-https URL without resolving anything", async () => {
  assert.equal(await resolveSafeUrl(new URL("http://example.com/x"), forbiddenDeps(), 3000), null);
  assert.equal(await resolveSafeUrl(new URL("ftp://example.com/x"), forbiddenDeps(), 3000), null);
});

// --------------------------------------------------------------- the budgets

test("a hung tier does not block the ones after it", async () => {
  const hang = () => new Promise<HttpResponse>(() => {});
  const deps = fakeDeps({ pages: { [T1]: hang, [T2]: ok(clientConfigXml()) } });

  const started = Date.now();
  const found = await lookupMailboxSettings(EMAIL, { deps, perAttemptMs: 150, totalMs: 2000 });
  const elapsed = Date.now() - started;

  assert.equal(found?.source, "autoconfig-well-known");
  assert.ok(elapsed < 1000, `fell through in ${elapsed}ms`);
});

test("the whole cascade gives up at its overall deadline", async () => {
  const hang = () => new Promise<HttpResponse>(() => {});
  const deps = fakeDeps({ pages: { [T1]: hang, [T2]: hang, [T3]: hang } });

  const started = Date.now();
  const found = await lookupMailboxSettings(EMAIL, { deps, perAttemptMs: 400, totalMs: 500 });
  const elapsed = Date.now() - started;

  assert.equal(found, null);
  assert.ok(elapsed < 1500, `cascade ran for ${elapsed}ms`);
});

test("readCapped refuses a body over the cap instead of buffering it", async () => {
  const chunk = Buffer.alloc(1024, 0x61);
  const stream = Readable.from(
    (function* () {
      for (let i = 0; i < 64; i++) yield chunk;
    })()
  );
  await assert.rejects(() => readCapped(stream, 16 * 1024), /too large/i);

  const small = Readable.from([Buffer.from("<clientConfig/>")]);
  assert.equal(await readCapped(small, MAX_RESPONSE_BYTES), "<clientConfig/>");
});

// ----------------------------------------------------------------- of CalDAV

test("CalDAV is found through the well-known redirect", async () => {
  const deps = fakeDeps({
    pages: {
      [T1]: ok(clientConfigXml()),
      [CALDAV_WELL_KNOWN]: redirect("https://dav.example.com/dav/"),
    },
  });
  const found = await lookupMailboxSettings(EMAIL, { deps });

  assert.deepEqual(found?.caldav, {
    url: "https://dav.example.com/dav/",
    user: "anna@example.com",
    source: "well-known",
  });
});

test("a well-known CalDAV endpoint that answers in place needs no redirect", async () => {
  const deps = fakeDeps({
    pages: {
      [T1]: ok(clientConfigXml()),
      [CALDAV_WELL_KNOWN]: { status: 401, location: null, body: "" },
    },
  });
  const found = await lookupMailboxSettings(EMAIL, { deps });
  assert.equal(found?.caldav?.url, CALDAV_WELL_KNOWN);
});

test("CalDAV falls back to its SRV record", async () => {
  const deps = fakeDeps({
    pages: { [T1]: ok(clientConfigXml()) },
    srv: {
      "_caldavs._tcp.example.com": [
        { name: "dav.example.com", port: 8443, priority: 0, weight: 0 },
      ],
    },
  });
  const found = await lookupMailboxSettings(EMAIL, { deps });

  assert.equal(found?.caldav?.url, "https://dav.example.com:8443/");
  assert.equal(found?.caldav?.source, "dns-srv");
});

test("no CalDAV anywhere is a null field, not a failed lookup", async () => {
  const deps = fakeDeps({ pages: { [T1]: ok(clientConfigXml()) } });
  const found = await lookupMailboxSettings(EMAIL, { deps });

  assert.ok(found);
  assert.equal(found.caldav, null);
  assert.equal(found.imap.host, "imap.example.com");
});

test("a CalDAV redirect to a private address is refused, mail settings kept", async () => {
  const deps = fakeDeps({
    pages: {
      [T1]: ok(clientConfigXml()),
      [CALDAV_WELL_KNOWN]: redirect("https://internal.example.com/dav/"),
    },
    addresses: { "internal.example.com": ["192.168.7.7"] },
  });
  const found = await lookupMailboxSettings(EMAIL, { deps });

  assert.ok(found);
  assert.equal(found.caldav, null);
  assert.equal(found.imap.host, "imap.example.com");
});
