/**
 * The operator's browser session.
 *
 * Unlike the OAuth sign-in step, which carries its state in a signed hidden field,
 * the settings UI spans several requests and needs a cookie. It still keeps no
 * server-side session table: the cookie is a signed token and the only server state
 * is a single integer, `sessionEpoch`, which every token carries a copy of. Bumping
 * it invalidates every outstanding session at once — which is what makes sign-out
 * everywhere, and a password change, mean anything against a stateless token.
 *
 * The `__Host-` prefix is not decoration. It makes the browser refuse the cookie
 * unless it is Secure, has no Domain and is scoped to Path=/, so a sibling host
 * cannot set a cookie this service would read. Path=/ is the price: the cookie is
 * sent to /mcp and /token too, which ignore it, and proxy.ts strips it before
 * anything leaves for the connector.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";

/** Cookie name. The `__Host-` prefix is enforced by the browser, not by us. */
export const SESSION_COOKIE = "__Host-mailmcp_session";

/** Absolute lifetime. Re-issued on every authenticated GET, so it acts as idle timeout. */
export const SESSION_TTL_SECONDS = 60 * 60;

/** Name of the hidden CSRF field in every state-changing form. */
export const CSRF_FIELD = "_csrf";

const AUDIENCE = "settings-session";
const ALGORITHM = "HS256";

export interface SessionClaims {
  sub: string;
  sid: string;
  csrf: string;
  epoch: number;
}

// `res.locals` is otherwise untyped in this codebase, which leaves every read
// site relying on a cast that a middleware-ordering mistake would not catch.
// This is the one open interface @types/express ships specifically for this
// kind of augmentation (see express-serve-static-core's `declare global {
// namespace Express { interface Locals {} } }`) — declaring the field here
// means a route that reads `res.locals.session` before `requireSession` has
// run gets a compile-time `| undefined`, not a silent `any`. Mirrors the same
// augmentation for `res.locals.assertion` in src/settings-assertion.ts.
declare global {
  namespace Express {
    interface Locals {
      session?: SessionClaims;
    }
  }
}

/** Mint claims for a newly authenticated operator. Never called before sign-in succeeds. */
export function newSession(username: string, epoch: number): SessionClaims {
  return {
    sub: username,
    sid: randomBytes(16).toString("hex"),
    csrf: randomBytes(16).toString("hex"),
    epoch,
  };
}

export async function signSession(
  claims: SessionClaims,
  key: Uint8Array,
  issuer: string
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ sid: claims.sid, csrf: claims.csrf, epoch: claims.epoch })
    .setProtectedHeader({ alg: ALGORITHM, typ: "JWT" })
    .setIssuer(issuer)
    .setAudience(AUDIENCE)
    .setSubject(claims.sub)
    .setIssuedAt(now)
    .setExpirationTime(now + SESSION_TTL_SECONDS)
    .sign(key);
}

/**
 * Verify a session cookie. Returns null for anything that does not hold, including a
 * token whose epoch is behind the current one — that is the revocation path, and it
 * must be indistinguishable from an ordinary expiry to the caller.
 */
export async function verifySession(
  token: string,
  key: Uint8Array,
  issuer: string,
  currentEpoch: number
): Promise<SessionClaims | null> {
  let payload;
  try {
    ({ payload } = await jwtVerify(token, key, {
      algorithms: [ALGORITHM],
      issuer,
      audience: AUDIENCE,
    }));
  } catch {
    return null;
  }
  const { sub, sid, csrf, epoch } = payload;
  if (
    typeof sub !== "string" ||
    typeof sid !== "string" ||
    typeof csrf !== "string" ||
    typeof epoch !== "number"
  ) {
    return null;
  }
  if (epoch !== currentEpoch) return null;
  return { sub, sid, csrf, epoch };
}

export function sessionCookie(token: string): string {
  return [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${SESSION_TTL_SECONDS}`,
  ].join("; ");
}

export function clearedSessionCookie(): string {
  return [`${SESSION_COOKIE}=`, "Path=/", "HttpOnly", "Secure", "SameSite=Lax", "Max-Age=0"].join(
    "; "
  );
}

/**
 * Pull the session token out of a Cookie header.
 *
 * Hand-parsed rather than via a dependency: the grammar needed here is one pair per
 * `; ` and nothing else, and adding a package to this service to do it would be a
 * poor trade. Matching is on the whole name, so `not__Host-mailmcp_session` does not
 * pass for ours.
 */
export function readSessionCookie(header: string | undefined): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== SESSION_COOKIE) continue;
    const value = part.slice(separator + 1).trim();
    return value === "" ? null : value;
  }
  return null;
}

/** Constant-time comparison of a submitted CSRF field against the session's own. */
export function csrfMatches(claims: SessionClaims, submitted: unknown): boolean {
  if (typeof submitted !== "string" || submitted.length === 0) return false;
  const expected = Buffer.from(claims.csrf, "utf8");
  const presented = Buffer.from(submitted, "utf8");
  if (expected.length !== presented.length) {
    timingSafeEqual(expected, expected);
    return false;
  }
  return timingSafeEqual(expected, presented);
}
