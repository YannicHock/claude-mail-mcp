/**
 * The assertion the OAuth layer attaches to a proxied settings request.
 *
 * Deliberately not a JWT. A JWT here would mean either adding `jose` to this
 * package — which depends on no crypto library at all — or hand-writing JWT
 * verification, which is where algorithm-confusion bugs live. This is an HMAC over
 * the literal transmitted string: there is no algorithm field to confuse and no
 * canonicalisation to disagree about, and it needs only node:crypto.
 *
 * Format: `<payload>.<mac>`, where `payload` is base64url-encoded JSON and `mac` is
 * HMAC-SHA256 over that exact string. Verification recomputes the MAC over what
 * arrived, compares in constant time, and only then parses the JSON — so no
 * attacker-controlled bytes reach JSON.parse until the signature has held.
 *
 * The format is mirrored in oauth/src/assertion.ts. The two packages have separate
 * Docker build contexts and cannot share a module; if you change one, change both.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/** Header the assertion travels in. Mirrored in oauth/src/assertion.ts. */
export const ASSERTION_HEADER = "x-settings-assertion";

/** Audience claim. Mirrored in oauth/src/assertion.ts. */
export const ASSERTION_AUDIENCE = "mail-mcp-settings";

const VERSION = 1;

export interface VerifiedAssertion {
  sub: string;
  sid: string;
  csrf: string;
}

/**
 * Verify an assertion. Returns null for anything that does not hold — a wrong key,
 * a tampered payload, an expired token, or one minted for a different method or
 * path. Never throws: a malformed header is a 401, not a 500.
 */
export function verifyAssertion(
  token: string,
  key: Uint8Array,
  issuer: string,
  method: string,
  path: string,
  now: number = Math.floor(Date.now() / 1000)
): VerifiedAssertion | null {
  const separator = token.indexOf(".");
  if (separator <= 0 || separator === token.length - 1) return null;
  const encoded = token.slice(0, separator);
  const presented = token.slice(separator + 1);
  if (encoded.includes(".") || presented.includes(".")) return null;

  const expected = createHmac("sha256", key).update(encoded).digest();
  let presentedMac: Buffer;
  try {
    presentedMac = Buffer.from(presented, "base64url");
  } catch {
    return null;
  }
  if (presentedMac.length !== expected.length) return null;
  if (!timingSafeEqual(presentedMac, expected)) return null;

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object") return null;

  if (payload.v !== VERSION) return null;
  if (payload.iss !== issuer) return null;
  if (payload.aud !== ASSERTION_AUDIENCE) return null;
  if (payload.htm !== method.toUpperCase()) return null;
  if (payload.htu !== path) return null;
  if (typeof payload.exp !== "number" || payload.exp <= now) return null;

  const { sub, sid, csrf } = payload;
  if (typeof sub !== "string" || typeof sid !== "string" || typeof csrf !== "string") {
    return null;
  }
  return { sub, sid, csrf };
}
