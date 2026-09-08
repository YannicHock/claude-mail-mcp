/**
 * PKCE (RFC 7636) verification.
 *
 * Claude sends `code_challenge` with `code_challenge_method=S256` on every
 * authorization request, whichever registration mechanism it used, so `S256` is
 * the only method this service accepts. `plain` is refused rather than tolerated:
 * accepting it would let anyone who intercepts an authorization code redeem it,
 * which is the entire attack PKCE exists to stop, and no client this service
 * serves has a reason to ask for it.
 */

import { createHash, timingSafeEqual } from "node:crypto";

/** The only `code_challenge_method` this service accepts. */
export const CODE_CHALLENGE_METHOD = "S256";

/**
 * RFC 7636 section 4.1: the verifier is 43-128 characters from the unreserved set.
 * Enforced so a malformed verifier is a clean `invalid_grant` rather than a hash
 * comparison against arbitrary input.
 */
const VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/;

/** RFC 7636 section 4.2: a base64url-encoded SHA-256 digest is 43 characters. */
const CHALLENGE_PATTERN = /^[A-Za-z0-9\-_]{43}$/;

/** True when `value` is a syntactically valid S256 code challenge. */
export function isValidCodeChallenge(value: string): boolean {
  return CHALLENGE_PATTERN.test(value);
}

/** True when `value` is a syntactically valid code verifier. */
export function isValidCodeVerifier(value: string): boolean {
  return VERIFIER_PATTERN.test(value);
}

/** Derive the S256 challenge for a verifier: BASE64URL(SHA256(ASCII(verifier))). */
export function deriveChallenge(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

/**
 * Verify a code verifier against the challenge recorded at authorization time.
 *
 * Compared with {@link timingSafeEqual} rather than `===`. The challenge is not
 * secret, but the comparison is cheap to do properly and keeps the habit intact
 * for the token comparisons elsewhere in this service where it does matter.
 */
export function verifyChallenge(verifier: string, challenge: string): boolean {
  if (!isValidCodeVerifier(verifier) || !isValidCodeChallenge(challenge)) {
    return false;
  }
  const derived = Buffer.from(deriveChallenge(verifier));
  const expected = Buffer.from(challenge);
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}
