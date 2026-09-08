/**
 * Dynamic client registration (RFC 7591).
 *
 * Claude registers a fresh client on every new connection, so this endpoint is
 * reachable by anyone who can reach the service. What keeps that from being an
 * open door is the redirect-URI allowlist: a registration whose `redirect_uris`
 * are not Claude's own callbacks is refused outright, so a registered client can
 * only ever send an authorization code to a place Claude controls. A registration
 * on its own also grants nothing — no token is issued until the operator has
 * signed in at /authorize.
 *
 * Clients are public: `token_endpoint_auth_method` is `none` and no client secret
 * is ever issued. A secret would be pointless here, since Claude's hosted surfaces
 * register dynamically and PKCE already binds the code to the requesting client.
 */

import { randomBytes } from "node:crypto";

import type { ClientRecord, Store } from "./store.js";
import { isTransportSafeRedirectUri, redirectUriAllowed } from "./urls.js";

export const SUPPORTED_GRANT_TYPES = ["authorization_code", "refresh_token"] as const;
export const SUPPORTED_RESPONSE_TYPES = ["code"] as const;

/** Maximum `redirect_uris` accepted in one registration. */
const MAX_REDIRECT_URIS = 10;

/** RFC 7591 section 3.2.2 error codes this service emits. */
export type RegistrationErrorCode =
  | "invalid_redirect_uri"
  | "invalid_client_metadata";

export interface RegistrationError {
  ok: false;
  error: RegistrationErrorCode;
  error_description: string;
}

export interface RegistrationSuccess {
  ok: true;
  client: ClientRecord;
}

export type RegistrationResult = RegistrationSuccess | RegistrationError;

function fail(
  error: RegistrationErrorCode,
  error_description: string
): RegistrationError {
  return { ok: false, error, error_description };
}

/**
 * Validate a registration request and, if it passes, persist and return the client.
 *
 * `allowlist` is the configured set of acceptable redirect URIs; every requested
 * URI must match it. The check runs before anything is written, so a rejected
 * registration leaves no trace in the store.
 */
export function registerClient(
  body: unknown,
  allowlist: readonly string[],
  store: Store
): RegistrationResult {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return fail("invalid_client_metadata", "Request body must be a JSON object.");
  }
  const metadata = body as Record<string, unknown>;

  const redirectUris = metadata.redirect_uris;
  if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
    return fail(
      "invalid_redirect_uri",
      "redirect_uris is required and must be a non-empty array."
    );
  }
  if (redirectUris.length > MAX_REDIRECT_URIS) {
    return fail(
      "invalid_redirect_uri",
      `At most ${MAX_REDIRECT_URIS} redirect_uris may be registered.`
    );
  }
  for (const uri of redirectUris) {
    if (typeof uri !== "string") {
      return fail("invalid_redirect_uri", "Every redirect_uri must be a string.");
    }
    if (!isTransportSafeRedirectUri(uri)) {
      return fail(
        "invalid_redirect_uri",
        "Every redirect_uri must use https, or http on a loopback address."
      );
    }
    if (!redirectUriAllowed(uri, allowlist)) {
      // Deliberately does not echo the allowlist: this endpoint is public, and
      // the operator can read the accepted values out of the service's config.
      return fail(
        "invalid_redirect_uri",
        "redirect_uri is not accepted by this authorization server."
      );
    }
  }

  const grantTypes = readStringArray(metadata.grant_types, [
    "authorization_code",
    "refresh_token",
  ]);
  if (grantTypes === null) {
    return fail(
      "invalid_client_metadata",
      "grant_types must be a non-empty array of strings."
    );
  }
  for (const grant of grantTypes) {
    if (!(SUPPORTED_GRANT_TYPES as readonly string[]).includes(grant)) {
      return fail(
        "invalid_client_metadata",
        `Unsupported grant_type: ${grant}. Supported: ${SUPPORTED_GRANT_TYPES.join(", ")}.`
      );
    }
  }

  const responseTypes = readStringArray(metadata.response_types, ["code"]);
  if (responseTypes === null) {
    return fail(
      "invalid_client_metadata",
      "response_types must be a non-empty array of strings."
    );
  }
  for (const responseType of responseTypes) {
    if (!(SUPPORTED_RESPONSE_TYPES as readonly string[]).includes(responseType)) {
      return fail(
        "invalid_client_metadata",
        `Unsupported response_type: ${responseType}. Supported: code.`
      );
    }
  }

  const authMethod = metadata.token_endpoint_auth_method;
  if (authMethod !== undefined && authMethod !== "none") {
    return fail(
      "invalid_client_metadata",
      "Only public clients are supported; token_endpoint_auth_method must be none."
    );
  }

  const clientName = metadata.client_name;
  if (clientName !== undefined && typeof clientName !== "string") {
    return fail("invalid_client_metadata", "client_name must be a string.");
  }

  const scope = metadata.scope;
  if (scope !== undefined && typeof scope !== "string") {
    return fail("invalid_client_metadata", "scope must be a string.");
  }

  const record: ClientRecord = {
    client_id: newClientId(),
    client_id_issued_at: Math.floor(Date.now() / 1000),
    redirect_uris: redirectUris as string[],
    grant_types: grantTypes,
    response_types: responseTypes,
    token_endpoint_auth_method: "none",
    // `client_name` is attacker-controlled: it is stored so it can be shown to the
    // operator on the consent screen, and escaped at render time, never trusted.
    ...(typeof clientName === "string" ? { client_name: clientName } : {}),
    ...(typeof scope === "string" ? { scope } : {}),
  };

  store.putClient(record);
  return { ok: true, client: record };
}

function newClientId(): string {
  return randomBytes(16).toString("base64url");
}

/**
 * Read an optional array-of-strings metadata field.
 *
 * Returns `fallback` when the field is absent, and `null` — meaning "reject the
 * registration" — for anything that is present but not a non-empty array of
 * strings. Silently filtering out the bad entries would let
 * `grant_types: ["client_credentials"]` register as if it had asked for the
 * defaults, which is the opposite of what the client said.
 */
function readStringArray(value: unknown, fallback: string[]): string[] | null {
  if (value === undefined) return fallback;
  if (!Array.isArray(value) || value.length === 0) return null;
  if (!value.every((entry) => typeof entry === "string")) return null;
  return value as string[];
}
