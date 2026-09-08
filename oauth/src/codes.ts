/**
 * Authorization codes.
 *
 * Held in memory only. A code lives for sixty seconds and is redeemed exactly
 * once; persisting that across a restart would buy nothing — the client is
 * mid-redirect and will simply start over.
 *
 * Everything the token endpoint must check later is captured at issue time and
 * compared on redemption: the PKCE challenge, the redirect URI, the client id and
 * the resource. Re-deriving any of them from the token request would let the
 * client change its mind between the two calls, which is exactly the substitution
 * PKCE and RFC 8707 exist to prevent.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";

/** How long an issued code stays redeemable. */
export const CODE_TTL_SECONDS = 60;

export interface AuthorizationCode {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  resource: string;
  /** The authenticated operator this code was issued for. */
  sub: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

export class CodeStore {
  readonly #codes = new Map<string, AuthorizationCode>();
  readonly #ttlMs: number;

  constructor(ttlSeconds: number = CODE_TTL_SECONDS) {
    this.#ttlMs = ttlSeconds * 1000;
  }

  /** Issue a code for an authorized request. Returns the opaque code value. */
  issue(
    details: Omit<AuthorizationCode, "expiresAt">,
    now: number = Date.now()
  ): string {
    this.sweep(now);
    const code = randomBytes(32).toString("base64url");
    this.#codes.set(code, { ...details, expiresAt: now + this.#ttlMs });
    return code;
  }

  /**
   * Redeem a code. Returns its details and removes it, so a second redemption of
   * the same code finds nothing — OAuth 2.1 requires single use, and a replayed
   * code must not produce a second token.
   *
   * The lookup is a constant-time scan rather than a map hit. The codes are
   * high-entropy random values, so this is belt-and-braces, but it costs nothing
   * at this table size and removes any argument about timing on the one lookup
   * that turns a guess into an access token.
   */
  redeem(code: string, now: number = Date.now()): AuthorizationCode | null {
    this.sweep(now);
    const candidate = Buffer.from(code, "utf8");
    let matched: string | null = null;
    for (const known of this.#codes.keys()) {
      const knownBuffer = Buffer.from(known, "utf8");
      if (
        knownBuffer.length === candidate.length &&
        timingSafeEqual(knownBuffer, candidate)
      ) {
        matched = known;
      }
    }
    if (matched === null) return null;

    const entry = this.#codes.get(matched)!;
    this.#codes.delete(matched);
    if (entry.expiresAt <= now) return null;
    return entry;
  }

  /** Drop expired codes. Called on every issue and redeem. */
  sweep(now: number = Date.now()): void {
    for (const [code, entry] of this.#codes) {
      if (entry.expiresAt <= now) this.#codes.delete(code);
    }
  }

  /** Number of codes currently outstanding. Test and diagnostics only. */
  get size(): number {
    return this.#codes.size;
  }
}
