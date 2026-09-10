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
 *    That canonicalisation no longer lives here. It moved out for #110, because
 *    the connector needs the identical rule for its own `PUBLIC_URL`; it was a
 *    module mirrored in both packages and held byte-identical by a drift test
 *    until #126 gave the two builds one context, and it is now the single
 *    `shared/canonical-url.ts` both images compile. The three functions are
 *    re-exported below so this file stays the one place in this package that URL
 *    comparison is imported from, and so the rule exists exactly once.
 *
 * 2. Loopback redirect URIs. RFC 8252 section 7.3 requires the port to be ignored
 *    when matching `127.0.0.1`, because a native client binds an ephemeral port at
 *    runtime. Claude Code declares `http://localhost/callback` and
 *    `http://127.0.0.1/callback` and binds a fresh port per session, so the same
 *    port-agnostic match has to apply to `localhost` too — RFC 8252 section 8.3
 *    discourages that hostname, but the client uses it regardless.
 */

export {
  canonicalResource,
  normalisePublicUrl,
  sameResource,
} from "../../shared/canonical-url.js";

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
