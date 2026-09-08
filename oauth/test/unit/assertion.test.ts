import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";

import { ASSERTION_TTL_SECONDS, signAssertion } from "../../src/assertion.js";

const KEY = new TextEncoder().encode("k".repeat(32));
const ISSUER = "https://mail-mcp.example.com";

function decode(token: string): Record<string, unknown> {
  const [encoded, mac] = token.split(".");
  const expected = createHmac("sha256", KEY).update(encoded).digest("base64url");
  assert.equal(mac, expected, "MAC must cover the encoded payload verbatim");
  return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
}

test("the minted assertion carries every claim the verifier checks", () => {
  const before = Math.floor(Date.now() / 1000);
  const token = signAssertion(
    { sub: "operator", sid: "s1", csrf: "c1", method: "post", path: "/settings/mailboxes" },
    KEY,
    ISSUER
  );
  const payload = decode(token);
  assert.equal(payload.v, 1);
  assert.equal(payload.iss, ISSUER);
  assert.equal(payload.aud, "mail-mcp-settings");
  assert.equal(payload.sub, "operator");
  assert.equal(payload.sid, "s1");
  assert.equal(payload.csrf, "c1");
  assert.equal(payload.htm, "POST", "method is upper-cased so the two sides agree");
  assert.equal(payload.htu, "/settings/mailboxes");
  assert.ok(
    (payload.exp as number) >= before + ASSERTION_TTL_SECONDS &&
      (payload.exp as number) <= before + ASSERTION_TTL_SECONDS + 2
  );
});

test("the payload carries no secret beyond the session identifiers", () => {
  const token = signAssertion(
    { sub: "operator", sid: "s1", csrf: "c1", method: "GET", path: "/settings/mailboxes" },
    KEY,
    ISSUER
  );
  assert.deepEqual(
    Object.keys(decode(token)).sort(),
    ["aud", "csrf", "exp", "htm", "htu", "iss", "sid", "sub", "v"]
  );
});
