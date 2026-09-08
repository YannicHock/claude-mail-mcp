/**
 * The operator sign-in step, and the CSRF protection around it.
 *
 * There is no session cookie anywhere in this service. `GET /authorize` validates
 * the authorization request, signs it into a short-lived JWT, and renders that
 * token in a hidden field; `POST /authorize` accepts only a request it signed
 * itself. That single mechanism does three jobs:
 *
 * - it is the CSRF token, because an attacker cannot mint one;
 * - it stops the parameters being tampered with between the two requests, so the
 *   redirect URI a code is issued to is the one that was validated;
 * - it removes the need for server-side login state entirely.
 *
 * An Origin/Referer check runs alongside it, which is what docs/HARDENING.md asks
 * for on state-changing endpoints. The signed request already defeats the classic
 * attack; the header check costs nothing and covers the case where a token leaks
 * into a page an attacker controls.
 */

import { SignJWT, jwtVerify } from "jose";

/** How long the operator has to complete the sign-in form. */
export const REQUEST_TOKEN_TTL_SECONDS = 10 * 60;

const REQUEST_TOKEN_USE = "authorization_request";

/** The parts of an authorization request carried across the sign-in step. */
export interface AuthorizationRequest {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  resource: string;
  state?: string;
  /** Shown on the consent screen. Client-supplied, escaped at render time. */
  clientName?: string;
}

/** Sign an authorization request into the hidden form field. */
export async function signAuthorizationRequest(
  request: AuthorizationRequest,
  key: Uint8Array,
  issuer: string
): Promise<string> {
  return new SignJWT({
    token_use: REQUEST_TOKEN_USE,
    client_id: request.clientId,
    redirect_uri: request.redirectUri,
    code_challenge: request.codeChallenge,
    scope: request.scope,
    resource: request.resource,
    ...(request.state !== undefined ? { state: request.state } : {}),
    ...(request.clientName !== undefined ? { client_name: request.clientName } : {}),
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(issuer)
    .setAudience(issuer)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + REQUEST_TOKEN_TTL_SECONDS)
    .sign(key);
}

/** Verify a submitted request token. Returns null for anything not ours. */
export async function verifyAuthorizationRequest(
  token: string,
  key: Uint8Array,
  issuer: string
): Promise<AuthorizationRequest | null> {
  try {
    const { payload } = await jwtVerify(token, key, {
      algorithms: ["HS256"],
      issuer,
      audience: issuer,
    });
    if (payload.token_use !== REQUEST_TOKEN_USE) return null;

    const clientId = payload.client_id;
    const redirectUri = payload.redirect_uri;
    const codeChallenge = payload.code_challenge;
    const scope = payload.scope;
    const resource = payload.resource;
    if (
      typeof clientId !== "string" ||
      typeof redirectUri !== "string" ||
      typeof codeChallenge !== "string" ||
      typeof scope !== "string" ||
      typeof resource !== "string"
    ) {
      return null;
    }
    return {
      clientId,
      redirectUri,
      codeChallenge,
      scope,
      resource,
      ...(typeof payload.state === "string" ? { state: payload.state } : {}),
      ...(typeof payload.client_name === "string"
        ? { clientName: payload.client_name }
        : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Check that a state-changing POST came from this service's own form.
 *
 * `Origin` is preferred; `Referer` is the fallback for the rare client that omits
 * it. A request carrying neither is refused rather than allowed: every browser
 * that can render the sign-in form sends at least one on a form POST, so an
 * absent header means something other than that form is submitting.
 */
export function isSameOrigin(
  headers: { origin?: string; referer?: string },
  issuer: string
): boolean {
  const expected = safeOrigin(issuer);
  if (expected === null) return false;

  if (headers.origin !== undefined && headers.origin !== "") {
    return safeOrigin(headers.origin) === expected;
  }
  if (headers.referer !== undefined && headers.referer !== "") {
    return safeOrigin(headers.referer) === expected;
  }
  return false;
}

function safeOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/** Escape text for interpolation into HTML element content or an attribute. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const STYLE = `
:root { color-scheme: light dark; }
body {
  font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
  margin: 0; min-height: 100vh; display: grid; place-items: center;
  background: Canvas; color: CanvasText;
}
main { width: min(24rem, calc(100vw - 3rem)); padding: 2rem 0; }
h1 { font-size: 1.25rem; margin: 0 0 .25rem; }
p.sub { margin: 0 0 1.5rem; opacity: .7; font-size: .9rem; }
label { display: block; font-size: .85rem; margin-bottom: .35rem; }
input[type=text], input[type=password] {
  width: 100%; box-sizing: border-box; padding: .6rem .7rem; margin-bottom: 1rem;
  border: 1px solid color-mix(in srgb, CanvasText 30%, transparent);
  border-radius: 6px; background: Canvas; color: CanvasText; font: inherit;
}
button {
  width: 100%; padding: .65rem; border: 0; border-radius: 6px; font: inherit;
  font-weight: 600; background: AccentColor; color: AccentColorText; cursor: pointer;
}
.error {
  padding: .6rem .7rem; margin-bottom: 1rem; border-radius: 6px; font-size: .9rem;
  background: color-mix(in srgb, #d33 15%, Canvas); color: CanvasText;
}
.client { font-size: .85rem; opacity: .7; margin-top: 1.25rem; }
code { font-family: ui-monospace, monospace; }
`.trim();

export interface LoginPageOptions {
  requestToken: string;
  /** Host of the redirect URI, shown so the operator can see where this goes. */
  redirectHost: string;
  clientName?: string;
  error?: string;
}

/**
 * Render the sign-in form.
 *
 * The redirect URI's host is shown, not the client-supplied `client_name`. The
 * MCP authorization specification requires the redirect hostname to be displayed
 * clearly, precisely because a self-asserted client name can claim to be anyone;
 * the name appears too, but labelled as what the client calls itself.
 */
export function renderLoginPage(opts: LoginPageOptions): string {
  const error = opts.error
    ? `<div class="error" role="alert">${escapeHtml(opts.error)}</div>`
    : "";
  const client = opts.clientName
    ? `<p class="client">The application calls itself
         &ldquo;${escapeHtml(opts.clientName)}&rdquo;.</p>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Sign in</title>
<style>${STYLE}</style>
</head>
<body>
<main>
  <h1>Sign in to continue</h1>
  <p class="sub">Authorizing access to your mail connector.
     You will be returned to <code>${escapeHtml(opts.redirectHost)}</code>.</p>
  ${error}
  <form method="post" action="/authorize" autocomplete="on">
    <input type="hidden" name="request" value="${escapeHtml(opts.requestToken)}">
    <label for="username">Username</label>
    <input id="username" name="username" type="text" autocomplete="username"
           autocapitalize="none" autocorrect="off" spellcheck="false" required autofocus>
    <label for="password">Password</label>
    <input id="password" name="password" type="password"
           autocomplete="current-password" required>
    <button type="submit">Sign in and authorize</button>
  </form>
  ${client}
</main>
</body>
</html>`;
}

/**
 * Render a terminal error page.
 *
 * Used only where redirecting would itself be the vulnerability — an unknown
 * client or an unregistered redirect URI. Everything else is reported to the
 * client as an OAuth error on the redirect, per RFC 6749 section 4.1.2.1.
 */
export function renderErrorPage(title: string, detail: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
  <h1>${escapeHtml(title)}</h1>
  <p class="sub">${escapeHtml(detail)}</p>
</main>
</body>
</html>`;
}
