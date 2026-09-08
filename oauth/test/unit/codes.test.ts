import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { CODE_TTL_SECONDS, CodeStore } from "../../src/codes.js";

const DETAILS = {
  clientId: "client-1",
  redirectUri: "https://claude.ai/api/mcp/auth_callback",
  codeChallenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  scope: "mcp",
  resource: "https://mail.example.com/mcp",
  sub: "operator",
} as const;

describe("CodeStore", () => {
  it("redeems a code it issued and returns everything bound at issue time", () => {
    const codes = new CodeStore();
    const code = codes.issue(DETAILS);
    const redeemed = codes.redeem(code);
    assert.ok(redeemed);
    assert.equal(redeemed.clientId, DETAILS.clientId);
    assert.equal(redeemed.redirectUri, DETAILS.redirectUri);
    assert.equal(redeemed.codeChallenge, DETAILS.codeChallenge);
    assert.equal(redeemed.resource, DETAILS.resource);
    assert.equal(redeemed.sub, DETAILS.sub);
  });

  it("refuses a second redemption of the same code", () => {
    const codes = new CodeStore();
    const code = codes.issue(DETAILS);
    assert.ok(codes.redeem(code));
    assert.equal(codes.redeem(code), null);
  });

  it("does not leave a redeemed code behind", () => {
    const codes = new CodeStore();
    const code = codes.issue(DETAILS);
    codes.redeem(code);
    assert.equal(codes.size, 0);
  });

  it("refuses a code that was never issued", () => {
    const codes = new CodeStore();
    codes.issue(DETAILS);
    assert.equal(codes.redeem("made-up-code"), null);
  });

  it("refuses an empty code", () => {
    const codes = new CodeStore();
    codes.issue(DETAILS);
    assert.equal(codes.redeem(""), null);
  });

  it("expires a code after its TTL", () => {
    const codes = new CodeStore(60);
    const issuedAt = 1_000_000;
    const code = codes.issue(DETAILS, issuedAt);

    assert.ok(codes.redeem(code, issuedAt + 59_000));
  });

  it("refuses a code presented after it expired", () => {
    const codes = new CodeStore(60);
    const issuedAt = 1_000_000;
    const code = codes.issue(DETAILS, issuedAt);
    assert.equal(codes.redeem(code, issuedAt + 60_001), null);
  });

  it("refuses a code presented exactly at its expiry", () => {
    const codes = new CodeStore(60);
    const issuedAt = 1_000_000;
    const code = codes.issue(DETAILS, issuedAt);
    assert.equal(codes.redeem(code, issuedAt + 60_000), null);
  });

  it("issues distinct, high-entropy codes", () => {
    const codes = new CodeStore();
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) seen.add(codes.issue(DETAILS));
    assert.equal(seen.size, 200);
    for (const code of seen) {
      // 32 random bytes, base64url encoded.
      assert.equal(code.length, 43);
      assert.match(code, /^[A-Za-z0-9\-_]+$/);
    }
  });

  it("sweeps expired codes so the table does not grow unboundedly", () => {
    const codes = new CodeStore(60);
    const start = 1_000_000;
    for (let i = 0; i < 10; i += 1) codes.issue(DETAILS, start);
    assert.equal(codes.size, 10);
    codes.sweep(start + 61_000);
    assert.equal(codes.size, 0);
  });

  it("keeps unexpired codes while sweeping expired ones", () => {
    const codes = new CodeStore(60);
    const start = 1_000_000;
    codes.issue(DETAILS, start);
    const later = codes.issue(DETAILS, start + 50_000);
    codes.sweep(start + 61_000);
    assert.equal(codes.size, 1);
    assert.ok(codes.redeem(later, start + 61_000));
  });

  it("defaults to the documented TTL", () => {
    assert.equal(CODE_TTL_SECONDS, 60);
  });
});
