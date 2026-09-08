import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";

import { verifyAssertion } from "../../src/settings-assertion.js";

const KEY = new TextEncoder().encode("k".repeat(32));
const ISSUER = "https://mail-mcp.example.com";

/** Build a token the way the OAuth layer will, so the test does not depend on it. */
function mint(overrides: Record<string, unknown> = {}, key = KEY): string {
  const payload = {
    v: 1,
    iss: ISSUER,
    aud: "mail-mcp-settings",
    sub: "operator",
    sid: "session-1",
    csrf: "csrf-1",
    htm: "POST",
    htu: "/settings/mailboxes/work",
    exp: Math.floor(Date.now() / 1000) + 30,
    ...overrides,
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const mac = createHmac("sha256", key).update(encoded).digest("base64url");
  return `${encoded}.${mac}`;
}

test("a well-formed assertion verifies", () => {
  const result = verifyAssertion(mint(), KEY, ISSUER, "POST", "/settings/mailboxes/work");
  assert.deepEqual(result, { sub: "operator", sid: "session-1", csrf: "csrf-1" });
});

test("a different key is rejected", () => {
  const other = new TextEncoder().encode("z".repeat(32));
  const token = mint({}, other);
  assert.equal(verifyAssertion(token, KEY, ISSUER, "POST", "/settings/mailboxes/work"), null);
});

test("a tampered payload is rejected", () => {
  const [encoded, mac] = mint().split(".");
  const decoded = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  decoded.sub = "someone-else";
  const forged = Buffer.from(JSON.stringify(decoded), "utf8").toString("base64url");
  assert.equal(
    verifyAssertion(`${forged}.${mac}`, KEY, ISSUER, "POST", "/settings/mailboxes/work"),
    null
  );
});

test("an expired assertion is rejected", () => {
  const token = mint({ exp: Math.floor(Date.now() / 1000) - 1 });
  assert.equal(verifyAssertion(token, KEY, ISSUER, "POST", "/settings/mailboxes/work"), null);
});

test("a GET assertion cannot be replayed as a POST", () => {
  const token = mint({ htm: "GET" });
  assert.equal(verifyAssertion(token, KEY, ISSUER, "POST", "/settings/mailboxes/work"), null);
});

test("an assertion for another path is rejected", () => {
  const token = mint({ htu: "/settings/mailboxes/personal" });
  assert.equal(verifyAssertion(token, KEY, ISSUER, "POST", "/settings/mailboxes/work"), null);
});

test("a wrong issuer or audience is rejected", () => {
  assert.equal(
    verifyAssertion(mint({ iss: "https://evil.example" }), KEY, ISSUER, "POST", "/settings/mailboxes/work"),
    null
  );
  assert.equal(
    verifyAssertion(mint({ aud: "something-else" }), KEY, ISSUER, "POST", "/settings/mailboxes/work"),
    null
  );
});

test("malformed input returns null rather than throwing", () => {
  for (const bad of ["", ".", "a.b.c", "not-base64.$$$", "onlyonepart"]) {
    assert.equal(verifyAssertion(bad, KEY, ISSUER, "POST", "/x"), null);
  }
});
