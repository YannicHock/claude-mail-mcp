/**
 * Minting side of the settings assertion.
 *
 * See src/settings-assertion.ts in the connector for the verifying side and for
 * why this is an HMAC rather than a JWT. The two halves stay separate on purpose
 * — minting and verifying are not the same code, and two independent
 * implementations of a security format are a cross-check — so this is not a
 * candidate for shared/ (#126). If you change the format here, change it there
 * in the same commit.
 */

import { createHmac } from "node:crypto";

/** Header the assertion travels in. Mirrored in src/settings-assertion.ts. */
export const ASSERTION_HEADER = "x-settings-assertion";

/** Audience claim. Mirrored in src/settings-assertion.ts. */
export const ASSERTION_AUDIENCE = "mail-mcp-settings";

/**
 * How long an assertion is good for. Long enough to survive a slow hop on the
 * container network, short enough that a captured one is worthless — it is minted
 * per request and never stored.
 */
export const ASSERTION_TTL_SECONDS = 30;

const VERSION = 1;

export interface AssertionInput {
  sub: string;
  sid: string;
  csrf: string;
  /** The HTTP method of the request being proxied. Case-insensitive. */
  method: string;
  /** The upstream path, query string excluded. */
  path: string;
}

export function signAssertion(
  input: AssertionInput,
  key: Uint8Array,
  issuer: string,
  now: number = Math.floor(Date.now() / 1000)
): string {
  const payload = {
    v: VERSION,
    iss: issuer,
    aud: ASSERTION_AUDIENCE,
    sub: input.sub,
    sid: input.sid,
    csrf: input.csrf,
    htm: input.method.toUpperCase(),
    htu: input.path,
    exp: now + ASSERTION_TTL_SECONDS,
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const mac = createHmac("sha256", key).update(encoded).digest("base64url");
  return `${encoded}.${mac}`;
}
