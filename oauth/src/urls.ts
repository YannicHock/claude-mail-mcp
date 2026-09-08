/**
 * URL canonicalisation and redirect-URI matching.
 *
 * Two comparisons in this service must not be plain string equality, and both
 * fail in ways that are hard to read from the client side:
 *
 * 1. The RFC 8707 `resource` value. Claude sends the canonical form of the URL
 *    the operator typed into the connector dialog — lowercase scheme and host,
 *    no default port, no fragment, no trailing slash. The operator may well have
 *    typed `HTTPS://Mail.Example.com/mcp/`. Anthropic's troubleshooting guidance
 *    is explicit that the server should "accept the canonical value when checking
 *    `aud` rather than doing a strict byte-for-byte comparison against what the
 *    user typed", so both sides are canonicalised before comparison.
 *
 * 2. Loopback redirect URIs. RFC 8252 section 7.3 requires the port to be ignored
 *    when matching `127.0.0.1`, because a native client binds an ephemeral port at
 *    runtime. Claude Code declares `http://localhost/callback` and
 *    `http://127.0.0.1/callback` and binds a fresh port per session, so the same
 *    port-agnostic match has to apply to `localhost` too — RFC 8252 section 8.3
 *    discourages that hostname, but the client uses it regardless.
 */

/** Redirect URIs Claude's hosted surfaces use: claude.ai web, Desktop, mobile, Cowork. */
export const HOSTED_CLAUDE_REDIRECT_URIS = [
  "https://claude.ai/api/mcp/auth_callback",
  // Anthropic documents that the callback may move to this host and asks that
  // it be allowlisted ahead of time so connectors keep working across the change.
  "https://claude.com/api/mcp/auth_callback",
] as const;

/** Loopback redirect URIs Claude Code declares; matched with the port ignored. */
export const LOOPBACK_REDIRECT_URIS = [
  "http://127.0.0.1/callback",
  "http://localhost/callback",
] as const;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/**
 * Canonicalise a resource identifier per RFC 8707 section 2: lowercase scheme and
 * host, drop a default port, drop any fragment, and drop a bare trailing slash.
 *
 * Throws for input that is not a usable absolute URI — a fragment is rejected
 * outright rather than silently stripped, because a `resource` carrying one is a
 * client bug worth surfacing, not something to paper over.
 */
export function canonicalResource(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Not an absolute URI: ${value}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Resource URI must be http or https: ${value}`);
  }
  if (url.hash !== "") {
    throw new Error(`Resource URI must not contain a fragment: ${value}`);
  }
  // `new URL` already lowercases scheme and host and elides the default port.
  url.search = "";
  const path = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
  return `${url.protocol}//${url.host}${path}`;
}

/** True when two resource identifiers denote the same resource. */
export function sameResource(a: string, b: string): boolean {
  try {
    return canonicalResource(a) === canonicalResource(b);
  } catch {
    return false;
  }
}

/**
 * Normalise a configured public base URL: no trailing slash, no query, no fragment.
 * Used as the OAuth issuer, so it must be stable and byte-identical everywhere it
 * appears — clients compare the `iss` in an authorization response against the
 * issuer from metadata with simple string comparison (RFC 9207 section 2.4).
 */
export function normalisePublicUrl(value: string): string {
  return canonicalResource(value);
}

/**
 * Match a requested redirect URI against the allowlist.
 *
 * Non-loopback entries are compared exactly. Loopback entries are compared on
 * scheme, host and path with the port ignored, per RFC 8252 section 7.3.
 */
export function redirectUriAllowed(
  requested: string,
  allowlist: readonly string[]
): boolean {
  let candidate: URL;
  try {
    candidate = new URL(requested);
  } catch {
    return false;
  }
  if (candidate.hash !== "") return false;

  for (const entry of allowlist) {
    let allowed: URL;
    try {
      allowed = new URL(entry);
    } catch {
      continue;
    }
    if (isLoopback(allowed)) {
      if (
        isLoopback(candidate) &&
        candidate.protocol === allowed.protocol &&
        candidate.hostname === allowed.hostname &&
        candidate.pathname === allowed.pathname &&
        candidate.search === allowed.search
      ) {
        return true;
      }
      continue;
    }
    if (requested === entry) return true;
  }
  return false;
}

function isLoopback(url: URL): boolean {
  return LOOPBACK_HOSTS.has(url.hostname);
}

/**
 * Reject redirect URIs OAuth 2.1 forbids regardless of allowlist: every redirect
 * target must be HTTPS or a loopback address. Checked at registration so a bad
 * entry is refused when it is written, not when it is first used.
 */
export function isTransportSafeRedirectUri(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && isLoopback(url);
}
