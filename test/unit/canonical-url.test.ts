/**
 * The one canonicalisation both services apply to `PUBLIC_URL`.
 *
 * What is asserted here:
 *
 *  1. **The spellings the issue names canonicalise to one string.** Host case
 *     and an explicit default port are the two that used to 401.
 *  2. **The rule still refuses what it always refused.** Canonicalising is not
 *     the same as being lenient: a non-URL, a foreign scheme and a fragment are
 *     still errors, and a different host is still a different resource.
 *
 * There used to be a third: a byte-for-byte comparison of the connector's copy
 * of the module against the OAuth layer's. #126 deleted it along with the
 * second copy — there is one shared/canonical-url.ts now, compiled into both
 * images, so "the two services canonicalise identically" is a property of the
 * build and there is nothing left to compare.
 *
 * The end-to-end half of #110 — a connector configured with one spelling
 * accepting an assertion issued under the other — lives in
 * test/integration/settings-mailboxes.test.ts, because a unit test of the
 * normaliser cannot fail the way the deployment failed.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  canonicalResource,
  normalisePublicUrl,
  sameResource,
} from "../../shared/canonical-url.js";

describe("canonicalResource", () => {
  it("lowercases the scheme and the host", () => {
    assert.equal(
      canonicalResource("HTTPS://Mail.Example.COM/mcp"),
      "https://mail.example.com/mcp"
    );
  });

  it("elides an explicit default port", () => {
    assert.equal(canonicalResource("https://mail.example.com:443"), "https://mail.example.com");
    assert.equal(canonicalResource("http://mail.example.com:80"), "http://mail.example.com");
  });

  it("keeps a non-default port", () => {
    assert.equal(
      canonicalResource("https://mail.example.com:8443"),
      "https://mail.example.com:8443"
    );
  });

  it("drops a trailing slash and a query", () => {
    assert.equal(canonicalResource("https://mail.example.com/"), "https://mail.example.com");
    assert.equal(canonicalResource("https://mail.example.com/mcp/"), "https://mail.example.com/mcp");
    assert.equal(canonicalResource("https://mail.example.com/mcp?x=1"), "https://mail.example.com/mcp");
  });

  it("ignores whitespace an .env file may have left on the value", () => {
    // No explicit trim in the function: the WHATWG URL parser strips leading and
    // trailing spaces itself, and this pins that so the trim the connector used
    // to do by hand is not quietly lost with it.
    assert.equal(canonicalResource("  https://mail.example.com/  "), "https://mail.example.com");
  });

  it("refuses what it always refused", () => {
    assert.throws(() => canonicalResource("mail.example.com"), /absolute URI/);
    assert.throws(() => canonicalResource("ftp://mail.example.com"), /http/);
    assert.throws(() => canonicalResource("https://mail.example.com#frag"), /fragment/);
  });
});

describe("sameResource", () => {
  it("accepts the two spellings that used to 401", () => {
    assert.equal(
      sameResource("https://Mail.example.com", "https://mail.example.com"),
      true
    );
    assert.equal(
      sameResource("https://mail.example.com:443", "https://mail.example.com"),
      true
    );
  });

  it("is still not lenient about the host itself", () => {
    assert.equal(sameResource("https://mail.example.com", "https://evil.example.com"), false);
    assert.equal(sameResource("https://mail.example.com", "http://mail.example.com"), false);
  });

  it("reads an unparseable value as no match rather than throwing", () => {
    assert.equal(sameResource("not a url", "https://mail.example.com"), false);
  });
});

describe("normalisePublicUrl", () => {
  it("is the same rule, under the name config.ts calls it by", () => {
    assert.equal(
      normalisePublicUrl("HTTPS://Mail.Example.com:443/"),
      canonicalResource("https://mail.example.com")
    );
  });

  it("leaves the connector's own default alone", () => {
    // 3220 is not http's default port, so it survives — config.defaults.test.ts
    // asserts the same string from the other end.
    assert.equal(normalisePublicUrl("http://localhost:3220"), "http://localhost:3220");
  });
});
