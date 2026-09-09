/**
 * Rendering for the operator settings UI.
 *
 * Every page here is server-rendered HTML with inline CSS. There is no client-side
 * JavaScript anywhere in this service, and none is added by these pages: every
 * interaction is a plain form submission. That is a deliberate choice, not an
 * oversight — see docs/HARDENING.md — and it is why these functions take plain data
 * and return a string, with no DOM, no template engine and no build step involved.
 *
 * These functions are pure: no I/O, no Express. The routes in settings-routes.ts
 * that call them are responsible for authentication, CSRF verification and
 * talking to the connector; this file only ever turns already-validated data
 * into markup.
 */

import { escapeHtml } from "./login.js";
import { CSRF_FIELD } from "./session.js";

/**
 * The response headers every operator-facing HTML page in this service sets.
 *
 * One function rather than one literal per page, because these pages differ in
 * exactly one header and agree on the other three. The settings pages, the setup
 * wizard and the /authorize consent screen all carry a CSRF token or a request
 * token, all take a password, must none of them be cached anywhere, and have
 * none of them any reason to be framed. Only the CSP differs — the consent
 * screen has to widen `form-action` to the redirect allowlist, because
 * submitting it hands off to the client — so the CSP is the parameter and the
 * rest is fixed.
 *
 * Before this was a function the set was written out three times: here, in the
 * connector's own src/settings-pages.ts, and inline in `sendLoginPage()` in
 * app.ts. The consent screen's copy was outside every test, which is how it
 * came to be the page 0.6.1 and 0.6.2 were both about.
 */
export function pageHeaders(csp: string): Record<string, string> {
  return {
    "Cache-Control": "no-store",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": csp,
    // same-origin, not no-referrer. These pages submit forms back to this origin,
    // and the POST handlers verify the request came from here with isSameOrigin(),
    // which reads Origin and falls back to Referer. Chrome does not send Origin on
    // a same-origin form POST, so no-referrer left the check with neither header
    // and refused every browser sign-in. same-origin still withholds the referrer
    // from any cross-origin destination, which is the property that matters.
    "Referrer-Policy": "same-origin",
  };
}

/**
 * The CSP for a page whose forms only ever post back here.
 *
 * Allows inline styles and nothing else — in particular no script, which is why
 * every interaction on these pages is a form submission. The consent screen
 * builds its own instead; see `loginCsp` in app.ts.
 */
export const SETTINGS_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'";

/** The header set the settings pages, and by extension the wizard, are served with. */
export const SETTINGS_HEADERS: Record<string, string> = pageHeaders(SETTINGS_CSP);

/** Hidden CSRF input. Every state-changing form gets exactly this. */
function csrfField(csrf: string): string {
  return `<input type="hidden" name="${CSRF_FIELD}" value="${escapeHtml(csrf)}">`;
}

/** Render a timestamp, in seconds since the epoch, as an ISO string. */
function renderTimestamp(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

const STYLE = `
:root { color-scheme: light dark; }
body {
  font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
  margin: 0; min-height: 100vh;
  background: Canvas; color: CanvasText;
}
main { width: min(40rem, calc(100vw - 3rem)); margin: 0 auto; padding: 2rem 0; }
h1 { font-size: 1.25rem; margin: 0 0 .25rem; }
h2 { font-size: 1rem; margin: 1.75rem 0 .5rem; }
p.sub { margin: 0 0 1.5rem; opacity: .7; font-size: .9rem; }
label { display: block; font-size: .85rem; margin-bottom: .35rem; }
input[type=text], input[type=password] {
  width: 100%; box-sizing: border-box; padding: .6rem .7rem; margin-bottom: 1rem;
  border: 1px solid color-mix(in srgb, CanvasText 30%, transparent);
  border-radius: 6px; background: Canvas; color: CanvasText; font: inherit;
}
input[type=checkbox] { margin-right: .4rem; }
button {
  padding: .5rem .9rem; border: 0; border-radius: 6px; font: inherit;
  font-weight: 600; background: AccentColor; color: AccentColorText; cursor: pointer;
}
form.inline { display: inline; }
.error {
  padding: .6rem .7rem; margin-bottom: 1rem; border-radius: 6px; font-size: .9rem;
  background: color-mix(in srgb, #d33 15%, Canvas); color: CanvasText;
}
.notice {
  padding: .6rem .7rem; margin-bottom: 1rem; border-radius: 6px; font-size: .9rem;
  background: color-mix(in srgb, AccentColor 15%, Canvas); color: CanvasText;
}
table { width: 100%; border-collapse: collapse; margin-bottom: 1.5rem; font-size: .9rem; }
th, td { text-align: left; padding: .5rem .5rem .5rem 0; border-bottom: 1px solid color-mix(in srgb, CanvasText 15%, transparent); vertical-align: top; }
ul.mailboxes { padding-left: 1.2rem; }
.muted { opacity: .7; }
a { color: LinkText; }
`.trim();

/** Wrap a page body in the shared document shell. */
function page(title: string, body: string): string {
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
${body}
</main>
</body>
</html>`;
}

/** Render the settings sign-in form. */
export function renderSettingsSignIn(opts: { error?: string }): string {
  const error = opts.error
    ? `<div class="error" role="alert">${escapeHtml(opts.error)}</div>`
    : "";

  const body = `
  <h1>Sign in to settings</h1>
  <p class="sub">Manage your connected clients and account.</p>
  ${error}
  <form method="post" action="/settings/login" autocomplete="on">
    <label for="username">Username</label>
    <input id="username" name="username" type="text" autocomplete="username"
           autocapitalize="none" autocorrect="off" spellcheck="false" required autofocus>
    <label for="password">Password</label>
    <input id="password" name="password" type="password"
           autocomplete="current-password" required>
    <button type="submit">Sign in</button>
  </form>`;

  return page("Sign in", body);
}

interface OverviewData {
  csrf: string;
  username: string;
  connectorReachable: boolean;
  connectorVersion: string | null;
  mailboxes: Array<{ id: string; label: string; isDefault: boolean }>;
  clientCount: number;
  sessionCount: number;
  canChangePassword: boolean;
  notice?: string;
}

/** Render the settings landing page: connector status, mailboxes, counts, sign-out. */
export function renderOverview(opts: OverviewData): string {
  const notice = opts.notice
    ? `<div class="notice">${escapeHtml(opts.notice)}</div>`
    : "";

  const connectorStatus = opts.connectorReachable
    ? `Reachable${opts.connectorVersion ? ` (version ${escapeHtml(opts.connectorVersion)})` : ""}`
    : "Unreachable";

  const mailboxItems = opts.mailboxes
    .map(
      (mailbox) =>
        `<li>${escapeHtml(mailbox.label)}${mailbox.isDefault ? " <span class=\"muted\">(default)</span>" : ""}</li>`
    )
    .join("\n    ");
  const mailboxList =
    opts.mailboxes.length > 0
      ? `<ul class="mailboxes">\n    ${mailboxItems}\n  </ul>`
      : `<p class="muted">No mailboxes configured.</p>`;

  const passwordLink = opts.canChangePassword
    ? `<p><a href="/settings/password">Change password</a></p>`
    : "";

  const body = `
  <h1>Settings</h1>
  <p class="sub">Signed in as ${escapeHtml(opts.username)}.</p>
  ${notice}

  <h2>Connector</h2>
  <p>${connectorStatus}</p>

  <h2>Mailboxes</h2>
  <p><a href="/settings/mailboxes">Manage mailboxes</a></p>
  ${mailboxList}

  <h2>Connected clients</h2>
  <p><a href="/settings/clients">${opts.clientCount} client(s), ${opts.sessionCount} session(s)</a></p>

  <h2>Account</h2>
  ${passwordLink}
  <form method="post" action="/settings/logout">
    ${csrfField(opts.csrf)}
    <button type="submit">Sign out</button>
  </form>
  <form method="post" action="/settings/logout">
    ${csrfField(opts.csrf)}
    <input type="hidden" name="all" value="1">
    <button type="submit">Sign out everywhere</button>
  </form>`;

  return page("Settings", body);
}

interface ClientsData {
  csrf: string;
  clients: Array<{
    id: string;
    name: string | null;
    issuedAt: number;
    redirectHosts: string[];
    revoked: boolean;
  }>;
  sessions: Array<{ sid: string; clientId: string; scope: string; expiresAt: number }>;
  notice?: string;
}

/** Render the connected-clients and active-sessions page, each row with a revoke form. */
export function renderClients(opts: ClientsData): string {
  const notice = opts.notice
    ? `<div class="notice">${escapeHtml(opts.notice)}</div>`
    : "";

  const clientRows = opts.clients
    .map((client) => {
      const name = client.name ? escapeHtml(client.name) : `<span class="muted">(unnamed)</span>`;
      const hosts = client.redirectHosts.map((host) => escapeHtml(host)).join(", ");
      const status = client.revoked ? "Revoked" : "Active";
      const action = client.revoked
        ? `<span class="muted">Revoked</span>`
        : `<form class="inline" method="post" action="/settings/clients/${encodeURIComponent(client.id)}/revoke">
        ${csrfField(opts.csrf)}
        <button type="submit">Revoke</button>
      </form>`;
      return `<tr>
      <td>${name}<br><span class="muted">${escapeHtml(client.id)}</span></td>
      <td>${renderTimestamp(client.issuedAt)}</td>
      <td>${hosts}</td>
      <td>${status}</td>
      <td>${action}</td>
    </tr>`;
    })
    .join("\n    ");
  const clientsTable =
    opts.clients.length > 0
      ? `<table>
    <tr><th>Client</th><th>Issued</th><th>Redirect hosts</th><th>Status</th><th></th></tr>
    ${clientRows}
  </table>`
      : `<p class="muted">No connected clients.</p>`;

  const sessionRows = opts.sessions
    .map(
      (session) => `<tr>
      <td>${escapeHtml(session.sid)}</td>
      <td>${escapeHtml(session.clientId)}</td>
      <td>${escapeHtml(session.scope)}</td>
      <td>${renderTimestamp(session.expiresAt)}</td>
      <td>
        <form class="inline" method="post" action="/settings/sessions/${encodeURIComponent(session.sid)}/revoke">
          ${csrfField(opts.csrf)}
          <button type="submit">Revoke</button>
        </form>
      </td>
    </tr>`
    )
    .join("\n    ");
  const sessionsTable =
    opts.sessions.length > 0
      ? `<table>
    <tr><th>Session</th><th>Client</th><th>Scope</th><th>Expires</th><th></th></tr>
    ${sessionRows}
  </table>`
      : `<p class="muted">No active sessions.</p>`;

  const body = `
  <h1>Connected clients</h1>
  <p class="sub">Revoking is immediate for both refresh and access tokens,
     whether you revoke a whole client or a single session.</p>
  ${notice}

  <h2>Clients</h2>
  ${clientsTable}

  <h2>Sessions</h2>
  ${sessionsTable}

  <h2>Everything</h2>
  <form method="post" action="/settings/clients/revoke-all">
    ${csrfField(opts.csrf)}
    <button type="submit">Revoke everything</button>
  </form>
  <p><a href="/settings">Back to settings</a></p>`;

  return page("Connected clients", body);
}

/** Render the password-change form, or the reason it is unavailable. */
export function renderPasswordChange(opts: {
  csrf: string;
  error?: string;
  disabledReason?: string;
}): string {
  const error = opts.error
    ? `<div class="error" role="alert">${escapeHtml(opts.error)}</div>`
    : "";

  if (opts.disabledReason) {
    const body = `
  <h1>Change password</h1>
  <p class="sub">Password changes are not available.</p>
  <p>${escapeHtml(opts.disabledReason)}</p>
  <p><a href="/settings">Back to settings</a></p>`;
    return page("Change password", body);
  }

  const body = `
  <h1>Change password</h1>
  ${error}
  <form method="post" action="/settings/password">
    ${csrfField(opts.csrf)}
    <label for="current_password">Current password</label>
    <input id="current_password" name="current_password" type="password"
           autocomplete="current-password" required>
    <label for="new_password">New password</label>
    <input id="new_password" name="new_password" type="password"
           autocomplete="new-password" required>
    <label for="confirm_password">Confirm new password</label>
    <input id="confirm_password" name="confirm_password" type="password"
           autocomplete="new-password" required>
    <label>
      <input type="checkbox" name="disconnect_clients" value="1">
      Also disconnect every connected Claude client
    </label>
    <button type="submit">Change password</button>
  </form>
  <p><a href="/settings">Back to settings</a></p>`;

  return page("Change password", body);
}
