/**
 * Rendering for the setup wizard.
 *
 * Pure, like settings-pages.ts and for the same reasons: no I/O, no Express, no
 * client-side JavaScript, no build step. Every interaction is a plain form
 * submission back to the same origin.
 *
 * The design language is the settings UI's, unchanged — system colours
 * (`Canvas`, `CanvasText`, `AccentColor`) so the pages follow the operator's
 * light or dark preference with no theme switch, the same `min(40rem, …)`
 * column, the same `.error` and `.notice` boxes. The stylesheet below is a
 * trimmed copy rather than an import because settings-pages.ts keeps its shell
 * private; the response headers, which are the part that must not drift, *are*
 * imported from it.
 *
 * `Step N of 3` is plain text on purpose. The existing pages have no stepper
 * component and do not need one for three screens.
 */

import { escapeHtml } from "./login.js";
import type { CredentialField, CredentialProblem } from "./operator.js";
import { MIN_PASSWORD_LENGTH } from "./operator.js";
import { SETTINGS_HEADERS } from "./settings-pages.js";
import { stepNumber, SETUP_STEPS, type SetupStep } from "./setup-state.js";

/**
 * The headers every wizard page is served with — the settings pages' set,
 * imported rather than repeated.
 *
 * `Referrer-Policy: same-origin` is load-bearing here and not a copied habit.
 * Chrome sends no `Origin` header on a same-origin form POST, so `Referer` is
 * the only thing the origin check has left to read; `no-referrer` would refuse
 * every submission in this wizard, which is the failure 0.6.0 shipped.
 */
export const SETUP_HEADERS: Record<string, string> = SETTINGS_HEADERS;

/** The title of each screen, used in the header line and the document title. */
const STEP_TITLES: Record<SetupStep, string> = {
  credentials: "Create the operator account",
  mailbox: "Add your first mailbox",
  connect: "Connect Claude",
};

const STYLE = `
:root { color-scheme: light dark; }
body {
  font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
  margin: 0; min-height: 100vh;
  background: Canvas; color: CanvasText;
}
main { width: min(40rem, calc(100vw - 3rem)); margin: 0 auto; padding: 2rem 0; }
h1 { font-size: 1.25rem; margin: 0 0 .25rem; }
p.sub { margin: 0 0 1.5rem; opacity: .7; font-size: .9rem; }
p.lead { margin: 0 0 1.5rem; }
label { display: block; font-size: .85rem; margin-bottom: .35rem; }
input[type=text], input[type=password] {
  width: 100%; box-sizing: border-box; padding: .6rem .7rem; margin-bottom: 1rem;
  border: 1px solid color-mix(in srgb, CanvasText 30%, transparent);
  border-radius: 6px; background: Canvas; color: CanvasText; font: inherit;
}
input.invalid { border-color: #d33; margin-bottom: .25rem; }
button {
  padding: .5rem .9rem; border: 0; border-radius: 6px; font: inherit;
  font-weight: 600; background: AccentColor; color: AccentColorText; cursor: pointer;
}
.actions { display: flex; align-items: center; justify-content: space-between; margin-top: 1.5rem; }
.error {
  padding: .6rem .7rem; margin-bottom: 1rem; border-radius: 6px; font-size: .9rem;
  background: color-mix(in srgb, #d33 15%, Canvas); color: CanvasText;
}
.field-error { font-size: .85rem; margin: 0 0 1rem; color: #d33; }
.notice {
  padding: .6rem .7rem; margin-bottom: 1rem; border-radius: 6px; font-size: .9rem;
  background: color-mix(in srgb, AccentColor 15%, Canvas); color: CanvasText;
}
.muted { opacity: .7; }
a { color: LinkText; }
input[type=number] {
  width: 100%; box-sizing: border-box; padding: .6rem .7rem; margin-bottom: 1rem;
  border: 1px solid color-mix(in srgb, CanvasText 30%, transparent);
  border-radius: 6px; background: Canvas; color: CanvasText; font: inherit;
}
fieldset {
  border: 1px solid color-mix(in srgb, CanvasText 20%, transparent);
  border-radius: 6px; padding: 1rem 1rem .25rem; margin: 0 0 1.25rem;
}
legend { font-size: .85rem; font-weight: 600; padding: 0 .35rem; }
.row { display: flex; gap: 1rem; }
.row > * { flex: 1; }
.row > .narrow { flex: 0 0 8rem; }
.checkbox-row { display: flex; align-items: center; gap: .5rem; margin-bottom: 1rem; }
.checkbox-row input { margin: 0; }
.checkbox-row label { margin: 0; }
button.secondary {
  background: transparent; color: CanvasText;
  border: 1px solid color-mix(in srgb, CanvasText 35%, transparent);
}
.buttons { display: flex; gap: .5rem; }
.probe-row {
  display: flex; justify-content: space-between; gap: 1rem;
  padding: .4rem .6rem; margin-bottom: .35rem; border-radius: 4px;
  background: color-mix(in srgb, CanvasText 6%, Canvas);
  border-left: 3px solid color-mix(in srgb, CanvasText 30%, transparent);
}
.probe-row.ok { border-left-color: color-mix(in srgb, #2a2 60%, CanvasText); }
.probe-row.fail { border-left-color: color-mix(in srgb, #d33 60%, CanvasText); }
h2 { font-size: 1rem; margin: 1.75rem 0 .5rem; }
input.url {
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  font-size: .95rem;
}
code {
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  font-size: .9em;
}
pre {
  padding: .6rem .7rem; border-radius: 6px; overflow-x: auto; font-size: .9rem;
  background: color-mix(in srgb, CanvasText 8%, Canvas);
}
`.trim();

/** The page shell every screen shares: one heading, one subtitle, one body. */
function page(documentTitle: string, subtitle: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(documentTitle)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<h1>Set up claude-mail-mcp</h1>
<p class="sub">${escapeHtml(subtitle)}</p>
${body}
</main>
</body>
</html>`;
}

/** The shared wizard shell: the page shell plus a `Step N of 3` line. */
function wizardPage(step: SetupStep, body: string): string {
  const title = STEP_TITLES[step];
  return page(
    `Set up claude-mail-mcp — ${title}`,
    `Step ${stepNumber(step)} of ${SETUP_STEPS.length} · ${title}`,
    body
  );
}

/**
 * An address the operator has to get out of the page and into somewhere else.
 *
 * A readonly input rather than a `<code>` block, and rather than the copy button
 * the design sketch drew: this service ships no client-side JavaScript, and the
 * pages are served with `default-src 'none'`, so a copy button would be a script
 * the browser refuses to run. An input is what a browser already knows how to
 * select in one gesture, and readonly is what stops it being edited into
 * something that looks official and is not.
 */
function urlField(id: string, label: string, url: string): string {
  return `<label for="${escapeHtml(id)}">${escapeHtml(label)}</label>
<input id="${escapeHtml(id)}" class="url" type="text" value="${escapeHtml(url)}" readonly
       spellcheck="false" autocapitalize="none">`;
}

/** Pull the message for one field out of the list, or the empty string. */
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

export interface CredentialsPageData {
  /** Where the form posts, i.e. this screen's own URL under the claim token. */
  action: string;
  /** What to put back in the username box after a rejected submission. */
  username: string;
  problems: CredentialProblem[];
}

/**
 * Step 1 — the operator account.
 *
 * The subtitle is not filler. "Username and password" on a mail tool reads as
 * *mailbox credentials* to a first-time operator, and this is the one account
 * that is not one; saying what it is not is worth the line.
 *
 * The password fields are `new-password`, so a browser offers to generate one
 * rather than filling in something it already knows.
 */
export function renderCredentialsStep(data: CredentialsPageData): string {
  const usernameError = messageFor(data.problems, "username");
  const passwordError = messageFor(data.problems, "password");
  const confirmationError = messageFor(data.problems, "confirmation");

  const body = `
  <p class="lead">
    This is the account you will sign in with to manage mailboxes later.
    It is not a mailbox login.
  </p>
  <form method="post" action="${escapeHtml(data.action)}" autocomplete="on">
    <label for="username">Username</label>
    <input id="username" name="username" type="text" value="${escapeHtml(data.username)}"
           autocomplete="username" autocapitalize="none" autocorrect="off"
           spellcheck="false" required autofocus${invalid(usernameError)}>
    ${fieldError(usernameError)}
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="new-password"
           minlength="${MIN_PASSWORD_LENGTH}" required${invalid(passwordError)}>
    ${fieldError(passwordError)}
    <label for="confirmation">Repeat password</label>
    <input id="confirmation" name="confirmation" type="password"
           autocomplete="new-password" required${invalid(confirmationError)}>
    ${fieldError(confirmationError)}
    <p class="muted">At least ${MIN_PASSWORD_LENGTH} characters, and not the same as the username.</p>
    <div class="actions"><span></span><button type="submit">Continue</button></div>
  </form>`;

  return wizardPage("credentials", body);
}

// ---- Step 2 — the first mailbox -------------------------------------------

/**
 * One service's line in the connection report.
 *
 * `tested: false` is not a failure. It is what CalDAV gets when the operator
 * left the CalDAV fields blank, and saying so out loud is the difference between
 * "we did not look" and "we looked and it was fine".
 */
export interface MailboxProbeLine {
  tested: boolean;
  ok: boolean;
  /** What the connector reported. Empty when the service was not tested. */
  message: string;
}

/**
 * The three services, reported one by one.
 *
 * Deliberately not a single boolean. An operator whose IMAP works and whose
 * CalDAV does not has a usable mailbox and a calendar to fix later; collapsing
 * that into one pass/fail would hide both which half works and which half to go
 * and look at.
 */
export interface MailboxProbeView {
  imap: MailboxProbeLine;
  smtp: MailboxProbeLine;
  caldav: MailboxProbeLine;
}

export interface MailboxPageData {
  /** Where the form posts: this screen's own URL under the claim token. */
  action: string;
  /** Step 1, for the Back link. */
  backHref: string;
  /**
   * What to put back in the form after a rejected or failed submission.
   * Password fields are never among them — see {@link renderMailboxStep}.
   */
  values: Record<string, string>;
  /** Rejections from the connector, keyed by the field name it rejected. */
  errors: Record<string, string>;
  /** A message across the top of the screen: what happened, and to what. */
  notice?: { kind: "error" | "info"; message: string };
  /** The connection report, when one has been run. */
  probe?: MailboxProbeView;
  /**
   * True when this build cannot reach the connector's mailbox routes at all —
   * no settings signing key, so nothing here can be probed or stored. The form
   * is not rendered in that state; only the way past it is.
   */
  unavailable?: boolean;
}

/**
 * Pre-filled values, so the common case is a few boxes rather than a form.
 *
 * The keys are the connector's field names, not names of this screen's own:
 * everything collected here is posted to `/settings/mailboxes` unchanged.
 */
const MAILBOX_DEFAULTS: Record<string, string> = {
  id: "main",
  label: "Main mailbox",
  "imap.port": "993",
  "smtp.port": "465",
};

function value(values: Record<string, string>, key: string): string {
  const submitted = values[key];
  if (submitted !== undefined) return submitted;
  return MAILBOX_DEFAULTS[key] ?? "";
}

function checked(values: Record<string, string>, key: string): boolean {
  // An empty `values` is a first render, where TLS is on. Once the operator has
  // submitted anything, an absent checkbox means they unticked it — a browser
  // sends nothing at all for one that is off.
  if (Object.keys(values).length === 0) return true;
  return values[key] === "1";
}

function textInput(opts: {
  id: string;
  name: string;
  label: string;
  values: Record<string, string>;
  errors: Record<string, string>;
  type?: "text" | "number" | "email";
  required?: boolean;
  hint?: string;
}): string {
  const message = opts.errors[opts.name] ?? "";
  const attrs = [
    `id="${escapeHtml(opts.id)}"`,
    `name="${escapeHtml(opts.name)}"`,
    `type="${opts.type ?? "text"}"`,
    `value="${escapeHtml(value(opts.values, opts.name))}"`,
    opts.required ? "required" : "",
    'autocapitalize="none"',
    'spellcheck="false"',
  ]
    .filter(Boolean)
    .join(" ");
  return `<label for="${escapeHtml(opts.id)}">${escapeHtml(opts.label)}</label>
<input ${attrs}${invalid(message)}>
${fieldError(message)}${opts.hint === undefined ? "" : `<p class="muted">${escapeHtml(opts.hint)}</p>`}`;
}

/**
 * A password box that is always empty.
 *
 * The connector's own mailbox form does the same, and this screen must not
 * become the one place in the project that writes a mailbox password back into
 * a page. The cost is a retype after a failed connection test; the alternative
 * is a credential sitting in HTML, in the browser's back-forward cache, and in
 * whatever the operator screenshots when they ask someone for help.
 */
function passwordInput(opts: {
  id: string;
  name: string;
  label: string;
  errors: Record<string, string>;
  required?: boolean;
}): string {
  const message = opts.errors[opts.name] ?? "";
  return `<label for="${escapeHtml(opts.id)}">${escapeHtml(opts.label)}</label>
<input id="${escapeHtml(opts.id)}" name="${escapeHtml(opts.name)}" type="password" value=""
       autocomplete="off"${opts.required === true ? " required" : ""}${invalid(message)}>
${fieldError(message)}`;
}

function checkboxInput(opts: {
  id: string;
  name: string;
  label: string;
  values: Record<string, string>;
}): string {
  return `<div class="checkbox-row">
  <input id="${escapeHtml(opts.id)}" name="${escapeHtml(opts.name)}" type="checkbox" value="1"${
    checked(opts.values, opts.name) ? " checked" : ""
  }>
  <label for="${escapeHtml(opts.id)}">${escapeHtml(opts.label)}</label>
</div>`;
}

function probeRow(name: string, line: MailboxProbeLine): string {
  const status = !line.tested
    ? "not tested"
    : line.ok
      ? "ok"
      : `failed: ${line.message === "" ? "unknown error" : line.message}`;
  const kind = !line.tested ? "" : line.ok ? " ok" : " fail";
  return `<div class="probe-row${kind}"><strong>${escapeHtml(name)}</strong><span>${escapeHtml(
    status
  )}</span></div>`;
}

function probeSection(probe: MailboxProbeView | undefined): string {
  if (probe === undefined) return "";
  return `<div class="notice">
${probeRow("IMAP", probe.imap)}
${probeRow("SMTP", probe.smtp)}
${probeRow("CalDAV", probe.caldav)}
</div>`;
}

function noticeHtml(notice: MailboxPageData["notice"]): string {
  if (notice === undefined) return "";
  const cls = notice.kind === "error" ? "error" : "notice";
  return `<div class="${cls}" role="alert">${escapeHtml(notice.message)}</div>`;
}

/**
 * Step 2 — the first mailbox, verified before it is stored.
 *
 * The field names are the connector's own, verbatim, because the connector is
 * what parses, probes and stores them. This screen supplies the wizard's chrome,
 * a Skip button and sensible ports; everything it collects goes to the same
 * `/settings/mailboxes` routes the settings UI posts to, and nothing about a
 * mailbox is validated, probed or written on this side of that hop.
 *
 * Skip carries `formnovalidate` on purpose. Every credential field is
 * `required`, which is what catches an incomplete form in the browser rather
 * than a round trip later — and which would otherwise make "Skip for now"
 * impossible to press, because a browser will not submit an empty form at all.
 */
export function renderMailboxStep(data: MailboxPageData): string {
  const { values, errors } = data;

  if (data.unavailable === true) {
    const body = `
  ${noticeHtml(data.notice)}
  <p>
    This instance has no settings signing key, so the wizard cannot reach the
    connector to test or store a mailbox. Setup can still finish — add the
    mailbox from the settings UI once a key is configured.
  </p>
  <form method="post" action="${escapeHtml(data.action)}">
    <div class="actions">
      <a href="${escapeHtml(data.backHref)}">← Back</a>
      <button type="submit" name="_action" value="skip">Continue without a mailbox</button>
    </div>
  </form>`;
    return wizardPage("mailbox", body);
  }

  const body = `
  <p class="lead">
    These credentials are tested against your mail server before anything is
    stored. Nothing here is saved unless IMAP and SMTP both answer.
  </p>
  ${noticeHtml(data.notice)}
  ${probeSection(data.probe)}
  <form method="post" action="${escapeHtml(data.action)}" autocomplete="off">
    <input type="hidden" name="default" value="1">
    ${textInput({
      id: "label",
      name: "label",
      label: "Name for this mailbox",
      values,
      errors,
      required: true,
    })}
    ${textInput({
      id: "mailbox_id",
      name: "id",
      label: "ID",
      values,
      errors,
      required: true,
      hint: "How the mail tools refer to this mailbox. Lowercase letters, digits, _ or -.",
    })}
    ${textInput({
      id: "mail_from",
      name: "mail.defaultFrom",
      label: "Email address",
      values,
      errors,
      type: "email",
      required: true,
    })}

    <fieldset>
    <legend>IMAP — reading mail</legend>
    <div class="row">
      <div>${textInput({
        id: "imap_host",
        name: "imap.host",
        label: "Host",
        values,
        errors,
        required: true,
      })}</div>
      <div class="narrow">${textInput({
        id: "imap_port",
        name: "imap.port",
        label: "Port",
        values,
        errors,
        type: "number",
        required: true,
      })}</div>
    </div>
    ${checkboxInput({ id: "imap_tls", name: "imap.tls", label: "TLS", values })}
    ${textInput({
      id: "imap_user",
      name: "imap.user",
      label: "Username",
      values,
      errors,
      required: true,
    })}
    ${passwordInput({ id: "imap_pass", name: "imap.pass", label: "Password", errors, required: true })}
    </fieldset>

    <fieldset>
    <legend>SMTP — sending mail</legend>
    <div class="row">
      <div>${textInput({
        id: "smtp_host",
        name: "smtp.host",
        label: "Host",
        values,
        errors,
        required: true,
      })}</div>
      <div class="narrow">${textInput({
        id: "smtp_port",
        name: "smtp.port",
        label: "Port",
        values,
        errors,
        type: "number",
        required: true,
      })}</div>
    </div>
    ${checkboxInput({ id: "smtp_tls", name: "smtp.tls", label: "TLS", values })}
    ${textInput({
      id: "smtp_user",
      name: "smtp.user",
      label: "Username",
      values,
      errors,
      required: true,
    })}
    ${passwordInput({ id: "smtp_pass", name: "smtp.pass", label: "Password", errors, required: true })}
    </fieldset>

    <fieldset>
    <legend>CalDAV — calendars (optional)</legend>
    <p class="muted">
      Leave blank to set up mail only. A CalDAV server that does not answer does
      not stop the mailbox being stored; the calendar tools stay unavailable
      until it does.
    </p>
    ${textInput({ id: "caldav_url", name: "caldav.url", label: "URL", values, errors })}
    ${textInput({ id: "caldav_user", name: "caldav.user", label: "Username", values, errors })}
    ${passwordInput({ id: "caldav_pass", name: "caldav.pass", label: "Password", errors })}
    </fieldset>

    <p class="muted">
      Passwords are never written back into this page, so retype them if a test
      sends you round again. Folder names and the rest of the account settings
      can be changed once setup is finished.
    </p>

    <div class="actions">
      <button type="submit" name="_action" value="skip" class="secondary" formnovalidate>
        Skip for now
      </button>
      <span class="buttons">
        <button type="submit" name="_action" value="test" class="secondary">Test connection</button>
        <button type="submit" name="_action" value="save">Save and continue</button>
      </span>
    </div>
  </form>
  <p><a href="${escapeHtml(data.backHref)}">← Back</a></p>`;

  return wizardPage("mailbox", body);
}

// ---- Step 3 — the MCP URL, PUBLIC_URL, and Finish -------------------------

/** A mailbox the connector reports as configured. */
export interface ConfiguredMailbox {
  id: string;
  label: string;
}

export interface ConnectPageData {
  /** Where Finish posts: this screen's own URL under the claim token. */
  action: string;
  /** Step 2, for the Back link. */
  backHref: string;
  /** The address the operator pastes into claude.ai: `PUBLIC_URL` + `MCP_PATH`. */
  mcpUrl: string;
  /** `PUBLIC_URL` itself, which is the value being confirmed. */
  publicUrl: string;
  /** What the connector reports as configured, so a skipped step 2 is legible. */
  mailboxes: ConfiguredMailbox[];
  /** False when the connector did not answer. A remark, never a blocker. */
  connectorReachable: boolean;
  /** Show the "PUBLIC_URL is wrong" guidance, i.e. the operator answered No. */
  showPublicUrlHelp?: boolean;
  /** A message across the top of the screen: what happened, and to what. */
  notice?: { kind: "error" | "info"; message: string };
}

/**
 * What is configured on this instance, in one line.
 *
 * Step 2 hands over identically whether it saved a mailbox or was skipped —
 * both paths are a 303 to this screen with the same recorded progress — so the
 * answer is asked of the connector rather than inferred from the wizard's own
 * notes. An unreachable connector is reported as an unknown, not as "none":
 * telling an operator they have no mailbox when they may well have one is the
 * one wrong thing this line could say.
 */
function mailboxSummary(
  data: ConnectPageData | CompletePageData,
  asides: { known: string; unknown: string }
): string {
  if (!data.connectorReachable) {
    return `<p class="muted">The connector did not answer just now, so this screen cannot say
      which mailboxes are configured. ${escapeHtml(asides.unknown)}</p>`;
  }
  const lead =
    data.mailboxes.length === 0
      ? "No mailbox is configured."
      : `${data.mailboxes.length === 1 ? "One mailbox is" : `${data.mailboxes.length} mailboxes are`} ` +
        `configured: ${data.mailboxes.map((mailbox) => escapeHtml(mailbox.label)).join(", ")}.`;
  return `<p class="muted">${lead} ${escapeHtml(asides.known)}</p>`;
}

/**
 * What to do about a wrong `PUBLIC_URL`.
 *
 * It is an environment variable, so there is deliberately nothing to edit here —
 * offering a box would imply this page could change it. What the operator gets
 * instead is the line to change, the command to run, and the one reassurance
 * that matters: the link they are holding survives the restart, because the
 * claim token is read back off the data volume rather than regenerated.
 */
function publicUrlHelp(publicUrl: string): string {
  return `<div class="notice">
    <p>
      <strong>PUBLIC_URL is an environment variable and cannot be changed from here.</strong>
      Set it to the address the outside world reaches this instance at — scheme and
      host, no path, no trailing slash — then bring the stack back up:
    </p>
    <pre>PUBLIC_URL=${escapeHtml(publicUrl)}
docker compose up -d</pre>
    <p>
      This setup link keeps working across that restart and resumes on this screen,
      which will then show the new address. Nothing you have entered is lost.
    </p>
  </div>`;
}

/**
 * Step 3 — the MCP URL, and the one value the container cannot check itself.
 *
 * `PUBLIC_URL` is confirmed rather than merely displayed because a wrong one
 * breaks the OAuth redirect at claude.ai rather than here: the operator sees a
 * sign-in failure in someone else's product, with nothing in this service's log
 * to connect it to. Asking costs one radio button.
 *
 * The confirmation is `required` in the markup and checked again on the server,
 * because a browser that skips the first is not a reason to claim the instance
 * on an answer nobody gave.
 */
export function renderConnectStep(data: ConnectPageData): string {
  const body = `
  <p class="lead">
    Add this address as a custom connector in claude.ai — select it and copy it.
  </p>
  ${noticeHtml(data.notice)}
  ${urlField("mcp_url", "MCP URL", data.mcpUrl)}
  <p class="muted">
    In claude.ai: Settings → Connectors → Add custom connector, and paste it there.
    Claude signs in against this same instance, with the operator account you
    created in step 1.
  </p>
  ${mailboxSummary(data, {
    known: "The mailbox list is on the settings page once you are signed in.",
    unknown: "That does not stop you finishing, and it is not a sign of anything wrong here.",
  })}

  <form method="post" action="${escapeHtml(data.action)}">
    <fieldset>
    <legend>Is that the address you reach this instance at?</legend>
    <p class="muted">
      It is built from PUBLIC_URL, currently <code>${escapeHtml(data.publicUrl)}</code>.
      That is the one value this container cannot check for itself, and a wrong one
      breaks the sign-in Claude does — with an error that surfaces at claude.ai, not
      here.
    </p>
    <div class="checkbox-row">
      <input id="public_url_yes" type="radio" name="public_url_ok" value="yes" required>
      <label for="public_url_yes">Yes, that is correct</label>
    </div>
    <div class="checkbox-row">
      <input id="public_url_no" type="radio" name="public_url_ok" value="no">
      <label for="public_url_no">No — show me how to fix it</label>
    </div>
    </fieldset>
    ${data.showPublicUrlHelp === true ? publicUrlHelp(data.publicUrl) : ""}
    <div class="actions">
      <a href="${escapeHtml(data.backHref)}">← Back</a>
      <button type="submit">Finish</button>
    </div>
  </form>`;

  return wizardPage("connect", body);
}

// ---- The end of the wizard -------------------------------------------------

export interface CompletePageData {
  /** Repeated here so the last screen is enough on its own. */
  mcpUrl: string;
  /** Where the operator signs in with the account step 1 created. */
  settingsUrl: string;
  mailboxes: ConfiguredMailbox[];
  connectorReachable: boolean;
}

/**
 * The screen after Finish. Not a step, and it carries no `Step N of 3` line:
 * the wizard is over and there is nowhere left to go inside it.
 *
 * It is rendered as the answer to the POST rather than redirected to, because by
 * the time this is built there is no URL left to redirect to. `/setup/*` is 404
 * from this instant on — the whole point of the button — and `/settings` is not
 * mounted in this process yet, for the reason the second half of this page says
 * out loud. A reload cannot re-submit anything either: the token is gone, so the
 * gate answers the repeated POST with the same 404 as any other, which is a
 * stronger guarantee than the redirect-after-POST it replaces.
 */
export function renderSetupComplete(data: CompletePageData): string {
  const body = `
  <div class="notice">
    <strong>Setup is complete.</strong> The claim token has been deleted from the
    data volume. This setup link, and every other <code>/setup</code> path, answers
    404 from now on — on this boot and every one after it.
  </div>
  ${urlField("mcp_url", "MCP URL", data.mcpUrl)}
  <p class="muted">
    Add it as a custom connector in claude.ai. The MCP endpoint is answering
    already and needs no restart.
  </p>
  ${mailboxSummary(data, {
    known: "Mailboxes are managed from the settings page below.",
    unknown: "Setup is finished either way; the mailbox list is on the settings page below.",
  })}

  <h2>The settings UI needs one restart</h2>
  <p>
    Sign in at <a href="${escapeHtml(data.settingsUrl)}">${escapeHtml(data.settingsUrl)}</a>
    with the account you created in step 1. That page is mounted when the process
    starts, and this process started before there was an operator account to mount
    it against, so it answers 404 until the container comes back:
  </p>
  <pre>docker compose restart mail-oauth</pre>
  <p class="muted">
    Restarting is safe now: the instance is claimed, no new claim token is minted,
    and no setup URL is printed again.
  </p>`;

  return page("claude-mail-mcp — setup complete", "Setup is complete", body);
}
