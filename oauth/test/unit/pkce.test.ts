import { strict as assert } from "node:assert";
import { randomBytes } from "node:crypto";
import { describe, it } from "node:test";

import {
  CODE_CHALLENGE_METHOD,
  deriveChallenge,
  isValidCodeChallenge,
  isValidCodeVerifier,
  verifyChallenge,
} from "../../src/pkce.js";

/** A verifier of the shape a spec-compliant client generates. */
function makeVerifier(): string {
  return randomBytes(32).toString("base64url");
}

describe("pkce", () => {
  it("only advertises S256", () => {
    assert.equal(CODE_CHALLENGE_METHOD, "S256");
  });

  it("matches the RFC 7636 appendix B test vector", () => {
    // RFC 7636 Appendix B: verifier "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
    // hashes to challenge "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM".
    assert.equal(
      deriveChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
    );
  });

  it("accepts a verifier that matches its challenge", () => {
    const verifier = makeVerifier();
    assert.equal(verifyChallenge(verifier, deriveChallenge(verifier)), true);
  });

  it("rejects a verifier that does not match", () => {
    const challenge = deriveChallenge(makeVerifier());
    assert.equal(verifyChallenge(makeVerifier(), challenge), false);
  });

  it("rejects a verifier differing in a single character", () => {
    const verifier = makeVerifier();
    const challenge = deriveChallenge(verifier);
    const tampered = (verifier[0] === "a" ? "b" : "a") + verifier.slice(1);
    assert.equal(verifyChallenge(tampered, challenge), false);
  });

  it("rejects the plain-method case where verifier equals challenge", () => {
    // The whole point of refusing `plain`: a client sending the verifier as the
    // challenge must not authenticate, even though the two strings match.
    const verifier = makeVerifier();
    assert.equal(verifyChallenge(verifier, verifier), false);
  });

  it("rejects an empty verifier and an empty challenge", () => {
    assert.equal(verifyChallenge("", deriveChallenge(makeVerifier())), false);
    assert.equal(verifyChallenge(makeVerifier(), ""), false);
  });

  it("enforces the RFC 7636 verifier length bounds", () => {
    assert.equal(isValidCodeVerifier("a".repeat(42)), false);
    assert.equal(isValidCodeVerifier("a".repeat(43)), true);
    assert.equal(isValidCodeVerifier("a".repeat(128)), true);
    assert.equal(isValidCodeVerifier("a".repeat(129)), false);
  });

  it("rejects verifier characters outside the unreserved set", () => {
    assert.equal(isValidCodeVerifier("+".repeat(43)), false);
    assert.equal(isValidCodeVerifier("/".repeat(43)), false);
    assert.equal(isValidCodeVerifier("=".repeat(43)), false);
  });

  it("requires a challenge to be a 43-character base64url digest", () => {
    assert.equal(isValidCodeChallenge("a".repeat(42)), false);
    assert.equal(isValidCodeChallenge("a".repeat(43)), true);
    assert.equal(isValidCodeChallenge("a".repeat(44)), false);
    // Standard base64 padding and alphabet must not be accepted.
    assert.equal(isValidCodeChallenge("a".repeat(42) + "="), false);
    assert.equal(isValidCodeChallenge("a".repeat(42) + "+"), false);
  });

  it("produces an unpadded base64url digest", () => {
    const challenge = deriveChallenge(makeVerifier());
    assert.equal(challenge.length, 43);
    assert.match(challenge, /^[A-Za-z0-9\-_]+$/);
  });
});
