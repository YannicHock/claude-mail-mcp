/**
 * Discovery documents.
 *
 * These two documents are the entire reason this service exists: without them
 * Claude cannot find out where to send the operator, and the connection fails as
 * "Couldn't reach the MCP server" with nothing useful in it.
 *
 * The endpoint list this repository inherited from the upstream project named
 * /.well-known/oauth-authorization-server, /authorize, /token, /register and
 * /jwks.json. It omitted protected resource metadata (RFC 9728), which the MCP
 * specification makes a MUST for the resource server, and it named /jwks.json,
 * which nothing consumes. See docs/superpowers/specs/2026-09-08-oauth-layer-design.md.
 */

import { CODE_CHALLENGE_METHOD } from "./pkce.js";

/**
 * The single scope this service issues.
 *
 * One scope, because there is one thing to authorize: reaching the connector.
 * Splitting it into read/write would imply an enforcement boundary that does not
 * exist — the connector behind this layer has one static token and no notion of
 * partial access, so a finer scope would be decoration.
 */
export const MCP_SCOPE = "mcp";

/**
 * Requesting this scope makes Claude ask for a refresh token. Advertised in the
 * authorization server metadata only: RFC 9728 guidance is that a protected
 * resource should not list `offline_access` in its own `scopes_supported`,
 * because a refresh token is not a requirement of the resource.
 */
export const OFFLINE_ACCESS_SCOPE = "offline_access";

export interface MetadataOptions {
  /** Issuer and base URL of this service, canonical, no trailing slash. */
  issuer: string;
  /** Canonical URI of the protected MCP endpoint — the RFC 8707 resource. */
  resource: string;
}

export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  bearer_methods_supported: string[];
  scopes_supported: string[];
}

export interface AuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
  scopes_supported: string[];
  response_types_supported: string[];
  response_modes_supported: string[];
  grant_types_supported: string[];
  token_endpoint_auth_methods_supported: string[];
  code_challenge_methods_supported: string[];
  authorization_response_iss_parameter_supported: boolean;
}

/**
 * RFC 9728 protected resource metadata.
 *
 * `resource` must equal the MCP server URL as the operator enters it in Claude,
 * including its path component — Anthropic's documentation is explicit about
 * this, and a mismatch surfaces as an audience failure much later in the flow.
 * Only the first entry of `authorization_servers` is read by Claude; there is no
 * fallback to later entries, so this service lists exactly one.
 */
export function protectedResourceMetadata(
  opts: MetadataOptions
): ProtectedResourceMetadata {
  return {
    resource: opts.resource,
    authorization_servers: [opts.issuer],
    bearer_methods_supported: ["header"],
    scopes_supported: [MCP_SCOPE],
  };
}

/**
 * RFC 8414 authorization server metadata.
 *
 * `code_challenge_methods_supported: ["S256"]` is required by the MCP
 * authorization specification so a client can confirm PKCE support before
 * starting; Claude sends an S256 challenge on every authorization request
 * regardless, and this service accepts nothing else.
 *
 * `token_endpoint_auth_methods_supported: ["none"]` is accurate rather than
 * aspirational: clients here are public and no secret is ever issued.
 *
 * `client_id_metadata_document_supported` is deliberately absent. Claude selects
 * CIMD only when a server advertises it together with `"none"` above, and falls
 * back to the `registration_endpoint` otherwise — which is the path this service
 * implements.
 */
export function authorizationServerMetadata(
  opts: MetadataOptions
): AuthorizationServerMetadata {
  return {
    issuer: opts.issuer,
    authorization_endpoint: `${opts.issuer}/authorize`,
    token_endpoint: `${opts.issuer}/token`,
    registration_endpoint: `${opts.issuer}/register`,
    scopes_supported: [MCP_SCOPE, OFFLINE_ACCESS_SCOPE],
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: [CODE_CHALLENGE_METHOD],
    // RFC 9207: clients validate the `iss` returned on the authorization
    // response against the issuer from this document. Advertising it is what
    // makes a client treat a missing `iss` as an error rather than proceeding.
    authorization_response_iss_parameter_supported: true,
  };
}

/**
 * The `WWW-Authenticate` value returned with a 401 from the MCP endpoint.
 *
 * The 401 status and this header are the whole protocol signal — a 200 carrying
 * an error body produces no authentication prompt in Claude at all, only a tool
 * error passed to the model. The `scope` parameter is included so Claude requests
 * exactly what is needed rather than everything the metadata advertises.
 */
export function wwwAuthenticate(opts: {
  resourceMetadataUrl: string;
  error?: string;
  errorDescription?: string;
}): string {
  const params = [`Bearer realm="mcp"`];
  if (opts.error) params.push(`error="${escapeQuoted(opts.error)}"`);
  if (opts.errorDescription) {
    params.push(`error_description="${escapeQuoted(opts.errorDescription)}"`);
  }
  params.push(`resource_metadata="${escapeQuoted(opts.resourceMetadataUrl)}"`);
  params.push(`scope="${MCP_SCOPE}"`);
  return params.join(", ");
}

/**
 * Escape a value for an HTTP quoted-string. Backslash first, then the quote, or
 * the escaping would double-escape its own output. Header values are otherwise
 * constructed from configuration and fixed strings, but the error description can
 * carry a reason derived from a request, so this is not decorative.
 */
function escapeQuoted(value: string): string {
  return value
    .replace(/[\r\n]/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
}
