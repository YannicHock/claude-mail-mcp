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
  parseClientConfig,
  readCapped,
  isPublicIp,
  resolveSafeUrl,
  defaultDeps,
  AUTOCONFIG_PER_ATTEMPT_TIMEOUT_MS,
  AUTOCONFIG_TOTAL_TIMEOUT_MS,
  AUTOCONFIG_DISCOVERY_TIMEOUT_MS,
  AUTOCONFIG_REACH_TIMEOUT_MS,
  MAX_REDIRECTS,
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
  const found = await lookupMailboxSettings(EMAIL, { deps, perAttemptMs: 150, discoveryMs: 2000 });
  const elapsed = Date.now() - started;

  assert.equal(found?.source, "autoconfig-well-known");
  assert.ok(elapsed < 1000, `fell through in ${elapsed}ms`);
});

test("the whole cascade gives up at its overall deadline", async () => {
  const hang = () => new Promise<HttpResponse>(() => {});
  const deps = fakeDeps({ pages: { [T1]: hang, [T2]: hang, [T3]: hang } });

  const started = Date.now();
  const found = await lookupMailboxSettings(EMAIL, { deps, perAttemptMs: 400, discoveryMs: 500 });
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

// -------------------------------------------- one tier's failure stays in it

/**
 * The cascade's whole shape is "if this tier finds nothing, try the next one",
 * so a tier that *throws* rather than returning null is not a lesser failure —
 * it takes every tier after it with it, and the operator is left with the same
 * `null` a domain with no autoconfig at all produces. The tests below pin that
 * property one tier at a time, using a payload any domain can serve: a numeric
 * character reference above the Unicode maximum, which is a `RangeError` out
 * of `String.fromCodePoint` rather than a parse failure (#84).
 */
const OVER_MAX = ["&#x110000;", "&#1114112;", "&#x7fffffff;", "&#2147483647;"];

/** A clientConfig whose IMAP hostname is unusable, so the tier finds nothing. */
function xmlWithEntityInHostname(entity: string): string {
  return `<clientConfig version="1.1"><emailProvider id="example.com">
    <incomingServer type="imap"><hostname>imap${entity}.example.com</hostname>
    <port>993</port><socketType>SSL</socketType></incomingServer>
    <outgoingServer type="smtp"><hostname>smtp.example.com</hostname>
    <port>465</port><socketType>SSL</socketType></outgoingServer>
  </emailProvider></clientConfig>`;
}

/** SRV records that let tier 4 answer, so tier 3's fall-through is visible. */
const SRV_FALLBACK: Record<string, SrvRecord[]> = {
  "_imaps._tcp.example.com": [{ name: "imap.example.com", port: 993, priority: 10, weight: 1 }],
  "_submissions._tcp.example.com": [
    { name: "smtp.example.com", port: 465, priority: 10, weight: 1 },
  ],
};

/** Deps whose one named operation throws *synchronously* instead of rejecting. */
function throwingDeps(
  on: { fetch?: string; resolve?: string; srv?: string },
  base: FakeOptions = {}
): FakeDeps {
  const inner = fakeDeps(base);
  return {
    fetched: inner.fetched,
    resolved: inner.resolved,
    resolveAddresses(hostname) {
      if (hostname === on.resolve) throw new Error("the resolver came apart");
      return inner.resolveAddresses(hostname);
    },
    httpsGet(url, addresses, timeoutMs) {
      if (url.toString() === on.fetch) throw new Error("the transport came apart");
      return inner.httpsGet(url, addresses, timeoutMs);
    },
    resolveSrv(name) {
      if (name === on.srv) throw new Error("the SRV query came apart");
      return inner.resolveSrv(name);
    },
  };
}

test("parseClientConfig returns null for an out-of-range entity rather than throwing", () => {
  for (const entity of OVER_MAX) {
    assert.equal(parseClientConfig(xmlWithEntityInHostname(entity), EMAIL), null, entity);
  }
});

test("an entity above the Unicode maximum is left as text, like any other unknown one", () => {
  const xml = `<clientConfig version="1.1"><emailProvider id="example.com">
    <displayName>Example &#x110000; Co</displayName>
    <incomingServer type="imap"><hostname>imap.example.com</hostname>
    <port>993</port><socketType>SSL</socketType>
    <username>%EMAILLOCALPART%&#1114112;</username></incomingServer>
    <outgoingServer type="smtp"><hostname>smtp.example.com</hostname>
    <port>465</port><socketType>SSL</socketType></outgoingServer>
  </emailProvider></clientConfig>`;
  const found = parseClientConfig(xml, EMAIL);

  assert.ok(found, "an unusable entity must not cost the document its servers");
  assert.equal(found.imap.host, "imap.example.com");
  assert.equal(found.imap.user, "anna&#1114112;", "the raw text is kept, as for any unknown entity");
});

test("tier 1: an unparseable document lets tier 2 run", async () => {
  for (const entity of OVER_MAX) {
    const deps = fakeDeps({
      pages: { [T1]: ok(xmlWithEntityInHostname(entity)), [T2]: ok(clientConfigXml()) },
    });
    const found = await lookupMailboxSettings(EMAIL, { deps });

    assert.equal(found?.source, "autoconfig-well-known", entity);
    assert.equal(found?.imap.host, "imap.example.com", entity);
  }
});

test("tier 2: an unparseable document lets tier 3 run", async () => {
  const deps = fakeDeps({
    pages: { [T2]: ok(xmlWithEntityInHostname("&#x110000;")), [T3]: ok(clientConfigXml()) },
  });
  const found = await lookupMailboxSettings(EMAIL, { deps });

  assert.equal(found?.source, "ispdb");
  assert.ok(deps.fetched.includes(T3), "tier 3 must still be reached");
});

test("tier 3: an unparseable document lets tier 4 run", async () => {
  const deps = fakeDeps({
    pages: { [T3]: ok(xmlWithEntityInHostname("&#x110000;")) },
    srv: SRV_FALLBACK,
  });
  const found = await lookupMailboxSettings(EMAIL, { deps });

  assert.equal(found?.source, "dns-srv");
  assert.equal(found?.smtp.socketType, "SSL");
});

test("every tier unparseable still reaches the SRV tier", async () => {
  const bad = ok(xmlWithEntityInHostname("&#1114112;"));
  const deps = fakeDeps({ pages: { [T1]: bad, [T2]: bad, [T3]: bad }, srv: SRV_FALLBACK });
  const found = await lookupMailboxSettings(EMAIL, { deps });

  assert.equal(found?.source, "dns-srv");
  assert.deepEqual(deps.fetched.slice(0, 3), [T1, T2, T3], "no tier may be skipped");
});

test("tier 4: an SRV query that throws is not the end of the lookup", async () => {
  const deps = throwingDeps({ srv: "_imaps._tcp.example.com" });
  assert.equal(await lookupMailboxSettings(EMAIL, { deps }), null);
});

test("a tier whose transport throws outright still lets the next one run", async () => {
  const fetchThrew = throwingDeps({ fetch: T1 }, { pages: { [T2]: ok(clientConfigXml()) } });
  const afterFetch = await lookupMailboxSettings(EMAIL, { deps: fetchThrew });
  assert.equal(afterFetch?.source, "autoconfig-well-known");

  const resolveThrew = throwingDeps(
    { resolve: "autoconfig.example.com" },
    { pages: { [T2]: ok(clientConfigXml()) } }
  );
  const afterResolve = await lookupMailboxSettings(EMAIL, { deps: resolveThrew });
  assert.equal(afterResolve?.source, "autoconfig-well-known");
});

test("CalDAV discovery cannot cost a lookup the mail settings it already found", async () => {
  for (const on of [
    { fetch: CALDAV_WELL_KNOWN },
    { resolve: "example.com" },
    { srv: "_caldavs._tcp.example.com" },
  ]) {
    const deps = throwingDeps(on, { pages: { [T1]: ok(clientConfigXml()) } });
    const found = await lookupMailboxSettings(EMAIL, { deps });

    assert.ok(found, JSON.stringify(on));
    assert.equal(found.imap.host, "imap.example.com");
    assert.equal(found.caldav, null);
  }
});

// ------------------------------------------------- the §7 numbers, as shipped
//
// The budget tests above all pass `perAttemptMs` and `discoveryMs` explicitly, which
// is what makes them fast and is also the hole in them: every one of those tests
// stays green if `lookupMailboxSettings` stops using its own constants as the
// defaults, and timeout.test.ts stays green too, because the constants would
// still hold the right values — nothing would be reading them. The two below
// close that, by watching what an un-optioned call actually hands the transport.

/** Deps that record the budget each attempt was given and find nothing. */
function budgetSpy(): { budgets: number[]; deps: AutoconfigDeps } {
  const budgets: number[] = [];
  return {
    budgets,
    deps: {
      async resolveAddresses() {
        return ["93.184.216.34"];
      },
      async httpsGet(_url, _addresses, timeoutMs) {
        budgets.push(timeoutMs);
        throw new Error("nothing published here");
      },
      async resolveSrv() {
        throw new Error("ENOTFOUND");
      },
    },
  };
}

test("an un-optioned lookup runs on the per-attempt deadline §7 fixes", async () => {
  const { budgets, deps } = budgetSpy();

  assert.equal(await lookupMailboxSettings(EMAIL, { deps }), null);

  assert.ok(budgets.length > 0, "the cascade made no attempt at all");
  for (const budget of budgets) {
    assert.equal(
      budget,
      AUTOCONFIG_PER_ATTEMPT_TIMEOUT_MS,
      "an attempt ran on something other than the shipped per-attempt budget"
    );
  }
});

test("an un-optioned lookup bounds every attempt by the cascade's total too", async () => {
  // The per-attempt slice is never longer than what is left of the overall
  // budget, which is what makes the 10-second ceiling real rather than a
  // sequence of 3-second attempts with no end. With the shipped values the
  // per-attempt figure is the smaller one, so it is what every slice reads as —
  // and a total shorter than one attempt would show up here immediately.
  assert.ok(AUTOCONFIG_PER_ATTEMPT_TIMEOUT_MS <= AUTOCONFIG_TOTAL_TIMEOUT_MS);

  const { budgets, deps } = budgetSpy();
  await lookupMailboxSettings(EMAIL, { deps });

  for (const budget of budgets) {
    assert.ok(budget <= AUTOCONFIG_DISCOVERY_TIMEOUT_MS, `an attempt got ${budget}ms`);
  }
});

test("the response cap and the redirect limit are the ones §7 asks for", () => {
  // Pinned as values because the behaviour is pinned above, on `readCapped` and
  // on the two-redirect case: a cap that quietly became 128 MB, or a limit that
  // became 5, would leave every other test in this file green.
  assert.equal(MAX_RESPONSE_BYTES, 128 * 1024);
  assert.equal(MAX_REDIRECTS, 1);
});

// ------------------------------------------- which candidate answers (#194)

const GMAIL = "anna@gmail.com";
const GMAIL_ISPDB = "https://autoconfig.thunderbird.net/v1.1/gmail.com";

interface XmlServer {
  host: string;
  port: number;
  socket: "SSL" | "STARTTLS";
}

/** A clientConfig document with exactly these servers, in this order. */
function xmlWith(imap: XmlServer[], smtp: XmlServer[]): string {
  const block = (tag: string, type: string, s: XmlServer): string => `
    <${tag} type="${type}">
      <hostname>${s.host}</hostname>
      <port>${s.port}</port>
      <socketType>${s.socket}</socketType>
      <username>%EMAILADDRESS%</username>
      <authentication>password-cleartext</authentication>
    </${tag}>`;
  return `<?xml version="1.0"?>
<clientConfig version="1.1"><emailProvider id="x">
${imap.map((s) => block("incomingServer", "imap", s)).join("")}
${smtp.map((s) => block("outgoingServer", "smtp", s)).join("")}
</emailProvider></clientConfig>`;
}

/** What the ISPDB really answers for gmail.com: one SMTP server, on 465. */
const GMAIL_XML = xmlWith(
  [{ host: "imap.gmail.com", port: 993, socket: "SSL" }],
  [{ host: "smtp.gmail.com", port: 465, socket: "SSL" }]
);

/**
 * Fake deps with a `reachable` that answers from `open` ("host:port" pairs)
 * and records every target it was asked about.
 */
function reachDeps(
  opts: FakeOptions & { open?: string[]; never?: boolean } = {}
): FakeDeps & { asked: string[] } {
  const base = fakeDeps(opts);
  const asked: string[] = [];
  return {
    ...base,
    asked,
    reachable(target) {
      asked.push(`${target.host}:${target.port}`);
      if (opts.never) return new Promise<boolean>(() => {});
      return Promise.resolve((opts.open ?? []).includes(`${target.host}:${target.port}`));
    },
  };
}

test("a Gmail address on a host with 465 blocked is offered 587, from the provider table", async () => {
  const deps = reachDeps({
    pages: { [GMAIL_ISPDB]: ok(GMAIL_XML) },
    open: ["imap.gmail.com:993", "smtp.gmail.com:587"],
  });
  const found = await lookupMailboxSettings(GMAIL, { deps });
  assert.deepEqual(found?.smtp, {
    host: "smtp.gmail.com",
    port: 587,
    tls: false,
    socketType: "STARTTLS",
    user: "anna@gmail.com",
  });
  assert.equal(found?.source, "ispdb", "the tier that answered is still the source");
});

test("where both answer, implicit TLS still wins: reachability breaks ties, it does not re-rank", async () => {
  const deps = reachDeps({
    pages: { [GMAIL_ISPDB]: ok(GMAIL_XML) },
    open: ["imap.gmail.com:993", "smtp.gmail.com:465", "smtp.gmail.com:587"],
  });
  assert.equal((await lookupMailboxSettings(GMAIL, { deps }))?.smtp.port, 465);
});

test("where nothing answers, the suggestion is exactly today's", async () => {
  // The probe at save time then reports the failure per service, as it always
  // has. The lookup never turns "SMTP did not answer" into something vaguer.
  const deps = reachDeps({ pages: { [GMAIL_ISPDB]: ok(GMAIL_XML) }, open: [] });
  const found = await lookupMailboxSettings(GMAIL, { deps });
  assert.equal(found?.smtp.port, 465);
  assert.equal(found?.imap.port, 993);
});

test("a domain in no table with one candidate per service is unchanged", async () => {
  const deps = reachDeps({ pages: { [T1]: ok(clientConfigXml()) }, open: [] });
  const found = await lookupMailboxSettings(EMAIL, { deps });
  assert.equal(found?.smtp.host, "smtp.example.com");
  assert.equal(found?.smtp.port, 465);
  // One candidate has nothing to choose between, so nothing is connected to.
  assert.deepEqual(deps.asked, []);
});

test("both RFC 6186 submission records are candidates, not the first that exists", async () => {
  const deps = reachDeps({
    srv: {
      "_imaps._tcp.example.com": [{ name: "imap.example.com", port: 993, priority: 10, weight: 1 }],
      "_submissions._tcp.example.com": [
        { name: "smtp.example.com", port: 465, priority: 10, weight: 1 },
      ],
      "_submission._tcp.example.com": [
        { name: "smtp.example.com", port: 587, priority: 10, weight: 1 },
      ],
    },
    open: ["smtp.example.com:587"],
  });
  const found = await lookupMailboxSettings(EMAIL, { deps });
  assert.equal(found?.smtp.port, 587);
  assert.equal(found?.smtp.socketType, "STARTTLS");
});

test("a candidate on a private address is never connected to at lookup", async () => {
  const deps = reachDeps({
    pages: {
      [T1]: ok(
        xmlWith(
          [{ host: "imap.example.com", port: 993, socket: "SSL" }],
          [
            { host: "smtp.internal.example.com", port: 465, socket: "SSL" },
            { host: "smtp.example.com", port: 587, socket: "STARTTLS" },
          ]
        )
      ),
    },
    addresses: { "smtp.internal.example.com": ["10.0.0.5"] },
    open: ["smtp.example.com:587"],
  });
  const found = await lookupMailboxSettings(EMAIL, { deps });
  assert.equal(deps.asked.includes("smtp.internal.example.com:465"), false, deps.asked.join());
  // Not known to be unreachable, so it keeps its place at the top of the ranking.
  assert.equal(found?.smtp.host, "smtp.internal.example.com");
});

test("at most four candidates per service are connected to", async () => {
  const smtp = [1, 2, 3, 4, 5].map((n) => ({
    host: `smtp${n}.example.com`,
    port: 465,
    socket: "SSL" as const,
  }));
  const deps = reachDeps({
    pages: { [T1]: ok(xmlWith([{ host: "imap.example.com", port: 993, socket: "SSL" }], smtp)) },
    open: [],
  });
  await lookupMailboxSettings(EMAIL, { deps });
  assert.equal(deps.asked.filter((t) => t.startsWith("smtp")).length, 4);
});

test("a check that never settles cannot hold the lookup past its reach budget", async () => {
  const deps = reachDeps({ pages: { [GMAIL_ISPDB]: ok(GMAIL_XML) }, never: true });
  const started = Date.now();
  const found = await lookupMailboxSettings(GMAIL, { deps, reachMs: 200 });
  assert.ok(Date.now() - started < 1_500, `took ${Date.now() - started}ms`);
  assert.equal(found?.smtp.port, 465, "unanswered is not reachable: today's suggestion");
});

test("IMAP gets the same treatment", async () => {
  const deps = reachDeps({
    pages: {
      [T1]: ok(
        xmlWith(
          [
            { host: "imap.example.com", port: 993, socket: "SSL" },
            { host: "imap.example.com", port: 143, socket: "STARTTLS" },
          ],
          [{ host: "smtp.example.com", port: 465, socket: "SSL" }]
        )
      ),
    },
    open: ["imap.example.com:143"],
  });
  const found = await lookupMailboxSettings(EMAIL, { deps });
  assert.equal(found?.imap.port, 143);
  assert.equal(found?.imap.tls, false);
});

test("the whole lookup budget is discovery plus one reach slice", () => {
  assert.equal(AUTOCONFIG_TOTAL_TIMEOUT_MS, AUTOCONFIG_DISCOVERY_TIMEOUT_MS + AUTOCONFIG_REACH_TIMEOUT_MS);
  assert.equal(AUTOCONFIG_DISCOVERY_TIMEOUT_MS, 10_000);
  assert.equal(AUTOCONFIG_REACH_TIMEOUT_MS, 3_000);
});

test("the choice is reported per service with host:port pairs only, for the log", async () => {
  const deps = reachDeps({
    pages: { [GMAIL_ISPDB]: ok(GMAIL_XML) },
    open: ["imap.gmail.com:993", "smtp.gmail.com:587"],
  });
  const choices: unknown[] = [];
  await lookupMailboxSettings(GMAIL, { deps, onChoice: (c) => choices.push(c) });
  // IMAP had no rival (the table's entry is the ISPDB's), so only SMTP chose.
  assert.deepEqual(choices, [
    {
      service: "smtp",
      candidates: ["smtp.gmail.com:465", "smtp.gmail.com:587"],
      verdicts: ["closed", "open"],
      chosen: "smtp.gmail.com:587",
    },
  ]);
  assert.equal(JSON.stringify(choices).includes("anna"), false, "never the address");
});

test("slow discovery and a check that never settles together stay inside both budgets", async () => {
  // The worst case the spec promises a test for: discovery spends its whole
  // budget (a hung subdomain tier, then a CalDAV probe that hangs as well) and
  // the reach check never answers. The two run side by side, so the bound is
  // discovery plus reach, never more.
  const hang = () => new Promise<HttpResponse>(() => {});
  const deps = reachDeps({
    pages: { [GMAIL_ISPDB]: ok(GMAIL_XML), "https://gmail.com/.well-known/caldav": hang },
    never: true,
  });
  const started = Date.now();
  const found = await lookupMailboxSettings(GMAIL, {
    deps,
    perAttemptMs: 300,
    discoveryMs: 600,
    reachMs: 300,
  });
  const elapsed = Date.now() - started;
  assert.equal(found?.smtp.port, 465);
  assert.ok(elapsed < 600 + 300 + 400, `took ${elapsed}ms`);
});
