/**
 * Rendering for the operator settings UI.
 *
 * Every page here is server-rendered HTML with inline CSS. There is no client-side
 * JavaScript anywhere in this service, and none is added by these pages: every
 * interaction is a plain form submission. That is a deliberate choice, not an
 * oversight — see docs/HARDENING.md — and it is why these functions take plain data
 * and return a string, with no DOM, no template engine and no build step involved.
 *
 * The render functions here are pure: no I/O, no state. The routes in
 * settings-routes.ts that call them are responsible for authentication, CSRF
 * verification and talking to the connector; those functions only ever turn
 * already-validated data into markup.
 *
 * The exception, and the only one, is the pair at the top — `sendPage` and
 * `sendRedirect`. They exist because "send an HTML page with this service's
 * headers" had no home: the header set was chained onto `res` by hand at every
 * send site in three route modules, and the one site that forgot was invisible
 * (#80). They take Express's `Response` as a type only, so this module still
 * imports nothing at runtime beyond its siblings.
 */

import type { Response } from "express";

import {
  pageHeaders,
  SETTINGS_CSP,
  SETTINGS_HEADERS,
} from "../../shared/page-headers.js";
import { escapeHtml } from "./login.js";
import {
  MIN_PASSWORD_LENGTH,
  type CredentialField,
  type CredentialProblem,
} from "./operator.js";
import { CSRF_FIELD } from "./session.js";

/**
 * The header set is declared in shared/page-headers.ts and re-exported here,
 * where every page in this service already imports it from. Until #126 it was
 * one of two copies — the connector's src/settings-pages.ts held the other —
 * pinned by a drift test that pulled both declarations out with a regex and
 * compared the extracted text. Inside this service the settings pages, the
 * setup wizard and the /authorize consent screen all go through `pageHeaders`
 * already, so that was the last pair left.
 */
export { pageHeaders, SETTINGS_CSP, SETTINGS_HEADERS } from "../../shared/page-headers.js";

/**
 * Send an HTML page with this service's headers. The only way to send one.
 *
 * `pageHeaders()` gave the *values* one home in #61 and the defect it was aimed
 * at survived it: `respondWithErrorPage()` in app.ts sat two lines above the
 * function #61 fixed, chained `.status().type().send()` without the `.set()`,
 * and served all six /authorize error pages with no cache, framing, CSP or
 * referrer rule at all. A constant cannot be forgotten *at the send site*; a
 * function that does the sending can only be forgotten by not calling it, which
 * is a route that renders nothing.
 *
 * The CSP defaults to {@link SETTINGS_CSP}, the strict one. A page that needs a
 * wider `form-action` passes it — today that is the /authorize consent screen
 * and nothing else, because it is the only page whose form submits somewhere
 * other than back here.
 */
export function sendPage(
  res: Response,
  status: number,
  html: string,
  csp: string = SETTINGS_CSP
): void {
  res.status(status).type("html").set(pageHeaders(csp)).send(html);
}

/**
 * Send a redirect with the same headers, and with no body.
 *
 * **The empty body is the contract, not a property of the status code.** That
 * is the half of #136 that mattered. `res.redirect()` content-negotiates a
 * courtesy `<p>See Other. Redirecting to …</p>` into the response and describes
 * it with a `Content-Type`; `.end()` sends nothing. Anyone tidying this file who
 * "simplifies" `.set().end()` back into `res.redirect()` reintroduces #136 —
 * hence this sentence, in the place they would be standing.
 *
 * It matters most on the two 302s the `/authorize` path sends, whose `Location`
 * carries a one-time authorization code: a body is one more copy of a URL that
 * must be used once, written where a referrer, an error page or a proxy log can
 * pick it up. Those two have no `Set-Cookie` at all. The other three do — a
 * session issued, a session cleared — and there `Cache-Control: no-store` is the
 * reason a shared cache cannot replay the response. Five callers, two distinct
 * reasons, one helper.
 *
 * There is deliberately **no `csp` parameter**, unlike {@link sendPage}. That is
 * not an oversight: a response with no body has no document for a CSP to govern,
 * so the strict `SETTINGS_HEADERS` is the only correct choice and a caller has
 * nothing to say about it. The header goes out anyway so that the set which must
 * not drift stays one set — `oauth/test/integration/page-headers.test.ts` pins
 * that, which is why the asymmetry needs explaining rather than fixing.
 *
 * Anything else the route wants on the response (`Set-Cookie`, `Retry-After`)
 * goes on with its own `res.set()` before this call; `.set()` merges, so order
 * does not matter.
 */
export function sendRedirect(res: Response, status: number, location: string): void {
  res.status(status).set(SETTINGS_HEADERS).set("Location", location).end();
}

/** Hidden CSRF input. Every state-changing form gets exactly this. */
function csrfField(csrf: string): string {
  return `<input type="hidden" name="${CSRF_FIELD}" value="${escapeHtml(csrf)}">`;
}

/**
 * Pull the message for one field out of the list, or the empty string.
 *
 * These three helpers are deliberately the same three the setup wizard renders
 * its credentials step with, class names included, so that a rejected password
 * looks and reads the same whichever page it was set from. They are duplicated
 * rather than shared because setup-pages.ts owns the wizard's copy; a third
 * page needing them is the moment to lift them into one module.
 */
function messageFor(problems: CredentialProblem[], field: CredentialField): string {
  return problems.find((problem) => problem.field === field)?.message ?? "";
}

function fieldError(message: string): string {
  return message === ""
    ? ""
    : `<p class="field-error" role="alert">${escapeHtml(message)}</p>`;
}

function invalid(message: string): string {
  return message === "" ? "" : ` class="invalid" aria-invalid="true"`;
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
input.invalid { border-color: #d33; margin-bottom: .25rem; }
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
.field-error { font-size: .85rem; margin: 0 0 1rem; color: #d33; }
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

/**
 * Render the password-change form, or the reason it is unavailable.
 *
 * Two kinds of rejection reach this page and they are not interchangeable.
 * `error` is about the request as a whole — a wrong current password, a
 * throttle lockout — and belongs in a banner. `problems` comes back from
 * `validateNewCredentials`, the same function the setup wizard's first step
 * calls, and belongs next to the input it is about: an operator who mistyped
 * the confirmation should not have to work out which of three boxes to look at.
 *
 * A problem whose field this form has no input for — `username`, which is
 * fixed here and only reachable if the stored record itself breaks a rule —
 * falls back to the banner rather than being dropped on the floor.
 */
export function renderPasswordChange(opts: {
  csrf: string;
  error?: string;
  problems?: CredentialProblem[];
  disabledReason?: string;
}): string {
  const problems = opts.problems ?? [];
  const passwordError = messageFor(problems, "password");
  const confirmationError = messageFor(problems, "confirmation");
  const unplaced = problems
    .filter((problem) => problem.field !== "password" && problem.field !== "confirmation")
    .map((problem) => problem.message);
  const banner = [opts.error, ...unplaced].filter((line) => Boolean(line)).join(" ");
  const error = banner
    ? `<div class="error" role="alert">${escapeHtml(banner)}</div>`
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
           autocomplete="new-password" minlength="${MIN_PASSWORD_LENGTH}"
           required${invalid(passwordError)}>
    ${fieldError(passwordError)}
    <label for="confirm_password">Confirm new password</label>
    <input id="confirm_password" name="confirm_password" type="password"
           autocomplete="new-password" required${invalid(confirmationError)}>
    ${fieldError(confirmationError)}
    <p class="muted">At least ${MIN_PASSWORD_LENGTH} characters, and not the same as the username.</p>
    <label>
      <input type="checkbox" name="disconnect_clients" value="1">
      Also disconnect every connected Claude client
    </label>
    <button type="submit">Change password</button>
  </form>
  <p><a href="/settings">Back to settings</a></p>`;

  return page("Change password", body);
}
