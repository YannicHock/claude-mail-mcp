/**
 * Access and refresh tokens.
 *
 * Both are JWTs signed with HS256. Symmetric signing is the right choice here
 * because this service is its own resource server: it is the only thing that ever
 * verifies these tokens, so there is no second party needing a public key, and
 * publishing a JWKS document would add a moving part with no consumer. That is a
 * deliberate departure from the endpoint list this repository inherited, which
 * named /jwks.json — see docs/planning/specs/2026-09-08-oauth-layer.md.
 *
 * Two things here are load-bearing:
 *
 * 1. `algorithms: ["HS256"]` is pinned on every verification. Without it a token
 *    presenting `alg: none` — or any other algorithm — would be considered.
 * 2. Access and refresh tokens carry a `token_use` claim and are verified against
 *    the expected value. Otherwise a refresh token, which is long-lived by design,
 *    would be accepted as a bearer token at /mcp.
 */

import { randomUUID } from "node:crypto";

import { SignJWT, jwtVerify, type JWTPayload } from "jose";

import type { RefreshSession, Store } from "./store.js";

const ALGORITHM = "HS256";

/** Distinguishes the two token kinds so neither can be used as the other. */
export type TokenUse = "access" | "refresh";

export interface AccessTokenClaims {
  sub: string;
  clientId: string;
  scope: string;
  /** Canonical resource URI this token is valid for; becomes the `aud` claim. */
  resource: string;
}

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  scope: string;
}

export interface TokenIssuerOptions {
  issuer: string;
  signingKey: Uint8Array;
  accessTokenTtl: number;
  refreshTokenTtl: number;
  store: Store;
}

/** Why a presented token was rejected. Maps onto the OAuth error to return. */
export type TokenFailure =
  | "invalid_token"
  | "expired_token"
  | "wrong_audience"
  | "wrong_use";

export type VerifyResult<T> =
  | { ok: true; claims: T }
  | { ok: false; reason: TokenFailure };

export interface VerifiedAccessToken {
  sub: string;
  clientId: string;
  scope: string;
  resource: string;
  jti: string;
}

export interface VerifiedRefreshToken extends VerifiedAccessToken {
  sid: string;
}

export class TokenIssuer {
  readonly #issuer: string;
  readonly #key: Uint8Array;
  readonly #accessTtl: number;
  readonly #refreshTtl: number;
  readonly #store: Store;

  constructor(opts: TokenIssuerOptions) {
    this.#issuer = opts.issuer;
    this.#key = opts.signingKey;
    this.#accessTtl = opts.accessTokenTtl;
    this.#refreshTtl = opts.refreshTokenTtl;
    this.#store = opts.store;
  }

  /**
   * Issue a fresh access/refresh pair and open a new refresh session.
   *
   * Used by the authorization_code grant. The refresh grant goes through
   * {@link rotate} instead, so that the session identity survives.
   */
  async issue(claims: AccessTokenClaims): Promise<IssuedTokens> {
    const sid = randomUUID();
    return this.#mint(claims, sid);
  }

  /**
   * Redeem a refresh token, rotating it.
   *
   * OAuth 2.1 requires refresh tokens to be rotated for public clients, and
   * Anthropic asks for the new token to be returned in the same response that
   * invalidates the old one — which is what this does.
   *
   * Reuse detection: the store holds the single `jti` currently valid for the
   * session. A syntactically valid refresh token whose `jti` is not that one is a
   * token that was already rotated, which means it was captured. The whole session
   * is revoked rather than just refusing the request, because at that point one of
   * the two holders is an attacker and there is no way to tell which.
   */
  async rotate(
    presented: string
  ): Promise<
    | { ok: true; tokens: IssuedTokens }
    | { ok: false; reason: TokenFailure | "reused" | "unknown_session" }
  > {
    const verified = await this.verifyRefreshToken(presented);
    if (!verified.ok) return { ok: false, reason: verified.reason };

    const { sid, jti, sub, clientId, scope, resource } = verified.claims;
    const session = this.#store.getSession(sid);
    if (!session) return { ok: false, reason: "unknown_session" };

    if (session.jti !== jti) {
      this.#store.deleteSession(sid);
      return { ok: false, reason: "reused" };
    }

    const tokens = await this.#mint({ sub, clientId, scope, resource }, sid);
    return { ok: true, tokens };
  }

  async #mint(claims: AccessTokenClaims, sid: string): Promise<IssuedTokens> {
    const now = Math.floor(Date.now() / 1000);
    const refreshJti = randomUUID();

    const accessToken = await new SignJWT({
      token_use: "access" satisfies TokenUse,
      client_id: claims.clientId,
      scope: claims.scope,
      epoch: this.#store.tokenEpoch,
    })
      .setProtectedHeader({ alg: ALGORITHM, typ: "JWT" })
      .setIssuer(this.#issuer)
      .setAudience(claims.resource)
      .setSubject(claims.sub)
      .setIssuedAt(now)
      .setExpirationTime(now + this.#accessTtl)
      .setJti(randomUUID())
      .sign(this.#key);

    const refreshToken = await new SignJWT({
      token_use: "refresh" satisfies TokenUse,
      client_id: claims.clientId,
      scope: claims.scope,
      sid,
    })
      .setProtectedHeader({ alg: ALGORITHM, typ: "JWT" })
      .setIssuer(this.#issuer)
      .setAudience(claims.resource)
      .setSubject(claims.sub)
      .setIssuedAt(now)
      .setExpirationTime(now + this.#refreshTtl)
      .setJti(refreshJti)
      .sign(this.#key);

    const session: RefreshSession = {
      jti: refreshJti,
      sub: claims.sub,
      clientId: claims.clientId,
      scope: claims.scope,
      resource: claims.resource,
      exp: now + this.#refreshTtl,
    };
    this.#store.putSession(sid, session);

    return {
      accessToken,
      refreshToken,
      expiresIn: this.#accessTtl,
      scope: claims.scope,
    };
  }

  /** Verify an access token presented as a bearer credential at /mcp. */
  async verifyAccessToken(
    token: string,
    expectedAudience: string
  ): Promise<VerifyResult<VerifiedAccessToken>> {
    const result = await this.#verify(token, "access", expectedAudience);
    if (!result.ok) return result;

    // A stateless token cannot be withdrawn, so revocation is expressed as two
    // comparisons instead. Without them "revoke" would mean "stops refreshing, keeps
    // working for up to an hour", which is not what the button says.
    const epoch = Number.isFinite(result.payload.epoch)
      ? (result.payload.epoch as number)
      : 0;
    if (epoch < this.#store.tokenEpoch) {
      return { ok: false, reason: "invalid_token" };
    }
    const client = this.#store.getClient(result.claims.clientId);
    const issuedAt = result.payload.iat;
    if (
      client?.revokedAt !== undefined &&
      typeof issuedAt === "number" &&
      issuedAt < client.revokedAt
    ) {
      return { ok: false, reason: "invalid_token" };
    }

    return { ok: true, claims: result.claims };
  }

  /** Verify a refresh token presented at the token endpoint. */
  async verifyRefreshToken(
    token: string
  ): Promise<VerifyResult<VerifiedRefreshToken>> {
    // Audience is not constrained here: the refresh grant re-issues for whatever
    // resource the token was originally bound to, which is read back off the token.
    const result = await this.#verify(token, "refresh", null);
    if (!result.ok) return result;
    const sid = result.payload.sid;
    if (typeof sid !== "string" || sid === "") {
      return { ok: false, reason: "invalid_token" };
    }
    return { ok: true, claims: { ...result.claims, sid } };
  }

  async #verify(
    token: string,
    expectedUse: TokenUse,
    expectedAudience: string | null
  ): Promise<
    | { ok: true; claims: VerifiedAccessToken; payload: JWTPayload }
    | { ok: false; reason: TokenFailure }
  > {
    let payload: JWTPayload;
    try {
      const verified = await jwtVerify(token, this.#key, {
        // Pinning the algorithm is what stops a token claiming `alg: none`, or a
        // different algorithm, from being considered at all.
        algorithms: [ALGORITHM],
        issuer: this.#issuer,
        ...(expectedAudience !== null ? { audience: expectedAudience } : {}),
      });
      payload = verified.payload;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "ERR_JWT_EXPIRED") return { ok: false, reason: "expired_token" };
      if (code === "ERR_JWT_CLAIM_VALIDATION_FAILED") {
        const claim = (err as { claim?: string }).claim;
        if (claim === "aud") return { ok: false, reason: "wrong_audience" };
      }
      return { ok: false, reason: "invalid_token" };
    }

    if (payload.token_use !== expectedUse) {
      return { ok: false, reason: "wrong_use" };
    }

    const sub = payload.sub;
    const jti = payload.jti;
    const clientId = payload.client_id;
    const scope = payload.scope;
    const resource = normaliseAudience(payload.aud);
    if (
      typeof sub !== "string" ||
      typeof jti !== "string" ||
      typeof clientId !== "string" ||
      typeof scope !== "string" ||
      resource === null
    ) {
      return { ok: false, reason: "invalid_token" };
    }

    return {
      ok: true,
      claims: { sub, jti, clientId, scope, resource },
      payload,
    };
  }
}

/**
 * A JWT `aud` may be a string or an array. This service always issues a single
 * audience, so an array carrying exactly one entry is accepted and anything else
 * is refused rather than guessed at.
 */
function normaliseAudience(aud: JWTPayload["aud"]): string | null {
  if (typeof aud === "string") return aud;
  if (Array.isArray(aud) && aud.length === 1 && typeof aud[0] === "string") {
    return aud[0];
  }
  return null;
}
