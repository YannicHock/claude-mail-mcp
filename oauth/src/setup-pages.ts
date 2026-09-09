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
 * private. The response headers, which are the part that must not drift, are
 * not this module's business at all: setup-routes.ts sends every wizard page
 * through `sendPage()` in settings-pages.ts, the same function the settings
 * routes and the /authorize pages go through.
 *
 * `Step N of 3` is plain text on purpose. The existing pages have no stepper
 * component and do not need one for three screens.
 */

import { escapeHtml } from "./login.js";
import type { CredentialField, CredentialProblem } from "./operator.js";
import { MIN_PASSWORD_LENGTH } from "./operator.js";
import { CHECKBOX_ON, MAILBOX_FIELDS } from "./settings-api.js";
import { stepNumber, SETUP_STEPS, type SetupStep } from "./setup-state.js";

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
.choice { margin-bottom: .5rem; }
.choice .checkbox-row { margin-bottom: .15rem; }
.choice-note { margin: 0 0 .75rem 1.6rem; font-size: .85rem; }
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
  /** The screen before this one, for the Back link. */
  backHref: string;
  /**
   * Tiers 1 and 2, for the links §5.3 wants reachable from anywhere — the full
   * form is a fallback, not a one-way door. Both or neither: a screen that
   * offers one way out and not the other is worse than one that offers none.
   */
  addressHref?: string;
  providersHref?: string;
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
 * The keys are `MAILBOX_FIELDS`, not names of this screen's own: everything
 * collected here becomes a `MailboxDraft` and goes to the connector under
 * exactly these names.
 */
export const MAILBOX_DEFAULTS: Record<string, string> = {
  [MAILBOX_FIELDS.id]: "main",
  [MAILBOX_FIELDS.label]: "Main mailbox",
  [MAILBOX_FIELDS.imapPort]: "993",
  [MAILBOX_FIELDS.smtpPort]: "465",
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
  return values[key] === CHECKBOX_ON;
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
  <input id="${escapeHtml(opts.id)}" name="${escapeHtml(opts.name)}" type="checkbox" value="${CHECKBOX_ON}"${
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
 * The field names come from `MAILBOX_FIELDS` in settings-api.ts, which the
 * connector's own form and parser read too — one table of names, so a rename is
 * a compile error rather than a field that quietly fails to arrive. This screen
 * supplies the wizard's chrome, a Skip button and sensible ports; everything it
 * collects becomes a `MailboxDraft` for the same `/settings/mailboxes` routes
 * the settings UI posts to, and nothing about a mailbox is validated, probed or
 * written on this side of that hop.
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
    <input type="hidden" name="${MAILBOX_FIELDS.isDefault}" value="${CHECKBOX_ON}">
    ${textInput({
      id: "label",
      name: MAILBOX_FIELDS.label,
      label: "Name for this mailbox",
      values,
      errors,
      required: true,
    })}
    ${textInput({
      id: "mailbox_id",
      name: MAILBOX_FIELDS.id,
      label: "ID",
      values,
      errors,
      required: true,
      hint: "How the mail tools refer to this mailbox. Lowercase letters, digits, _ or -.",
    })}
    ${textInput({
      id: "mail_from",
      name: MAILBOX_FIELDS.mailDefaultFrom,
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
        name: MAILBOX_FIELDS.imapHost,
        label: "Host",
        values,
        errors,
        required: true,
      })}</div>
      <div class="narrow">${textInput({
        id: "imap_port",
        name: MAILBOX_FIELDS.imapPort,
        label: "Port",
        values,
        errors,
        type: "number",
        required: true,
      })}</div>
    </div>
    ${checkboxInput({ id: "imap_tls", name: MAILBOX_FIELDS.imapTls, label: "TLS", values })}
    ${textInput({
      id: "imap_user",
      name: MAILBOX_FIELDS.imapUser,
      label: "Username",
      values,
      errors,
      required: true,
    })}
    ${passwordInput({ id: "imap_pass", name: MAILBOX_FIELDS.imapPass, label: "Password", errors, required: true })}
    </fieldset>

    <fieldset>
    <legend>SMTP — sending mail</legend>
    <div class="row">
      <div>${textInput({
        id: "smtp_host",
        name: MAILBOX_FIELDS.smtpHost,
        label: "Host",
        values,
        errors,
        required: true,
      })}</div>
      <div class="narrow">${textInput({
        id: "smtp_port",
        name: MAILBOX_FIELDS.smtpPort,
        label: "Port",
        values,
        errors,
        type: "number",
        required: true,
      })}</div>
    </div>
    ${checkboxInput({ id: "smtp_tls", name: MAILBOX_FIELDS.smtpTls, label: "TLS", values })}
    ${textInput({
      id: "smtp_user",
      name: MAILBOX_FIELDS.smtpUser,
      label: "Username",
      values,
      errors,
      required: true,
    })}
    ${passwordInput({ id: "smtp_pass", name: MAILBOX_FIELDS.smtpPass, label: "Password", errors, required: true })}
    </fieldset>

    <fieldset>
    <legend>CalDAV — calendars (optional)</legend>
    <p class="muted">
      Leave blank to set up mail only. A CalDAV server that does not answer does
      not stop the mailbox being stored; the calendar tools stay unavailable
      until it does.
    </p>
    ${textInput({ id: "caldav_url", name: MAILBOX_FIELDS.caldavUrl, label: "URL", values, errors })}
    ${textInput({ id: "caldav_user", name: MAILBOX_FIELDS.caldavUser, label: "Username", values, errors })}
    ${passwordInput({ id: "caldav_pass", name: MAILBOX_FIELDS.caldavPass, label: "Password", errors })}
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
  ${
    data.addressHref === undefined || data.providersHref === undefined
      ? ""
      : otherWaysIn(
          {
            action: data.action,
            backHref: data.backHref,
            addressHref: data.addressHref,
            providersHref: data.providersHref,
            manualHref: "",
          },
          "manual"
        )
  }
  <p><a href="${escapeHtml(data.backHref)}">← Back</a></p>`;

  return wizardPage("mailbox", body);
}

// ---- Step 2, tiers 1 and 2 — find the settings before asking for them ------
//
// Three more screens, all of them step 2. The full form above is the last of
// them rather than the first: eighteen boxes is what this milestone exists to
// stop being the second thing a new operator sees, and each tier here exists so
// that the next one is not needed.
//
//   the address screen   →  a lookup, and what it found, for confirmation
//                        →  or, when it found nothing, the provider list
//                        →  or, from either, the full form above
//
// Every one of them carries the same Skip button, because "someone evaluating
// the thing should not need mail credentials to hand" has to be true of whatever
// screen they happen to be looking at.

/** The wizard's own name for the one password box tiers 1 and 2 have. */
export const SHARED_PASSWORD_FIELD = "password";

/** The name the address box submits: the connector's own, so it carries onward. */
export const ADDRESS_FIELD = MAILBOX_FIELDS.mailDefaultFrom;

/** The name the provider list submits. */
export const PROVIDER_FIELD = "provider";

/** What `Other (enter manually)` submits: no preset, straight to the full form. */
export const PROVIDER_OTHER = "other";

/** Which of step 2's screens is being looked at. Also the `view` query value. */
export type MailboxView = "address" | "providers" | "manual";

export interface StepTwoLinks {
  /** Where the form posts: this screen's own URL under the claim token. */
  action: string;
  /** Step 1, for the Back link. */
  backHref: string;
  /** Tier 1, the address screen. */
  addressHref: string;
  /** Tier 2, the provider list — reachable from anywhere, as §5.3 requires. */
  providersHref: string;
  /** Tier 3, the full form, for an operator who would rather just type it all. */
  manualHref: string;
}

/** Skip is on every one of these screens, and never validates the form first. */
function skipButton(): string {
  return `<button type="submit" name="_action" value="skip" class="secondary" formnovalidate>
        Skip for now
      </button>`;
}

/**
 * The other two tiers, as links.
 *
 * Every screen in step 2 offers both of the ones it is not, which is what makes
 * the cascade a cascade rather than a funnel: the lookup is a convenience, and
 * an operator who already knows their settings — or who has been sent round by a
 * failed probe — must never be made to walk through it to reach the form.
 */
function otherWaysIn(links: StepTwoLinks, current: MailboxView): string {
  const all: Array<{ view: MailboxView; href: string; text: string }> = [
    { view: "address", href: links.addressHref, text: "Look it up from the address" },
    { view: "providers", href: links.providersHref, text: "Choose provider manually" },
    { view: "manual", href: links.manualHref, text: "Enter all the settings myself" },
  ];
  const links_ = all
    .filter((entry) => entry.view !== current)
    .map((entry) => `<a href="${escapeHtml(entry.href)}">${escapeHtml(entry.text)}</a>`)
    .join(" · ");
  return `<p class="muted">${links_}</p>`;
}

export interface MailboxAddressPageData extends StepTwoLinks {
  /** What to put back in the address box after a rejected submission. */
  email: string;
  /** Keyed by field name, so the address's own rejection sits against its box. */
  errors: Record<string, string>;
  notice?: { kind: "error" | "info"; message: string };
}

/**
 * Tier 1 — an address and a password, and nothing else on the screen.
 *
 * On Continue the connector looks the domain up (autoconfig, then the ISPDB,
 * then RFC 6186 SRV records) and what it finds is shown for confirmation. A
 * lookup that finds nothing is not a failure and is never reported as one: the
 * next screen is simply the provider list.
 *
 * The password is asked for here rather than after the lookup because it is the
 * other half of the same thought — "this is my mailbox" — and because a screen
 * that asks for an address, goes away for up to ten seconds and then asks for a
 * password reads as two steps rather than one.
 */
export function renderMailboxAddressStep(data: MailboxAddressPageData): string {
  const emailError = data.errors[ADDRESS_FIELD] ?? "";
  const body = `
  <p class="lead">
    Start with the address. Most providers publish their own settings, so the
    servers, ports and encryption can usually be worked out from it.
  </p>
  ${noticeHtml(data.notice)}
  <form method="post" action="${escapeHtml(data.action)}" autocomplete="off">
    <label for="mail_from">Email address</label>
    <input id="mail_from" name="${escapeHtml(ADDRESS_FIELD)}" type="email"
           value="${escapeHtml(data.email)}" required autofocus
           autocapitalize="none" autocorrect="off" spellcheck="false"${invalid(emailError)}>
    ${fieldError(emailError)}
    <label for="mailbox_password">Password</label>
    <input id="mailbox_password" name="${escapeHtml(SHARED_PASSWORD_FIELD)}" type="password"
           value="" autocomplete="off" required>
    <p class="muted">
      The password for the mailbox itself. Some providers want an app password
      here rather than the one you sign in to their website with.
    </p>
    <div class="actions">
      ${skipButton()}
      <button type="submit" name="_action" value="lookup">Continue</button>
    </div>
  </form>
  ${otherWaysIn(data, "address")}
  <p><a href="${escapeHtml(data.backHref)}">← Back</a></p>`;

  return wizardPage("mailbox", body);
}

export interface MailboxSuggestionPageData extends StepTwoLinks {
  /** The domain the settings were found for, for the heading. */
  domain: string;
  /** Where the answer came from, in words the operator can act on. */
  sourceLabel: string;
  /**
   * The settings themselves, under `MAILBOX_FIELDS` names — both what the rows
   * are rendered from and what the hidden inputs carry into the save, so there
   * is one copy of them on the screen rather than two that could disagree.
   * Never contains a password.
   */
  values: Record<string, string>;
  errors: Record<string, string>;
  notice?: { kind: "error" | "info"; message: string };
}

/** `imap.example.com:993`, or "" when there is no host to show. */
function endpoint(values: Record<string, string>, hostKey: string, portKey: string): string {
  const host = values[hostKey] ?? "";
  const port = values[portKey] ?? "";
  if (host === "") return "";
  return port === "" ? host : `${host}:${port}`;
}

function suggestionRow(name: string, detail: string, encryption: string): string {
  const right = encryption === "" ? detail : `${detail} · ${encryption}`;
  return `<div class="probe-row ok"><strong>${escapeHtml(name)}</strong><span>${escapeHtml(
    right
  )}</span></div>`;
}

/**
 * What the lookup found, shown before any of it is used.
 *
 * The whole point of this screen is that it exists. Applying an autoconfig
 * answer silently would be less typing and much worse: a wrong host produces a
 * connection failure minutes later, on a screen that says nothing about where
 * the host came from, and an operator who never saw it has no reason to suspect
 * it. Here they read it once, and `Edit these` is one press away.
 *
 * CalDAV missing is stated as ordinary, because it is. Most mail providers
 * publish nothing for it, calendars are optional in the account model, and an
 * operator who reads "not found" as a problem will go looking for one.
 *
 * The password is asked for again rather than carried through the lookup. This
 * screen is rendered from a fresh request, and a password in a hidden input is a
 * password in the page source, in the browser's back-forward cache and in
 * whatever the operator screenshots when they ask someone for help — which is
 * exactly what every other form in this project refuses to do.
 */
export function renderMailboxSuggestionStep(data: MailboxSuggestionPageData): string {
  const { values } = data;
  const hidden = Object.entries(values)
    .map(
      ([name, v]) =>
        `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(v)}">`
    )
    .join("\n    ");

  const caldavUrl = values[MAILBOX_FIELDS.caldavUrl] ?? "";
  const caldavRow =
    caldavUrl === ""
      ? `<div class="probe-row"><strong>CalDAV</strong><span>not found — calendars can be added later</span></div>`
      : suggestionRow("CalDAV", caldavUrl, "");

  const body = `
  <h2>Found settings for ${escapeHtml(data.domain)}</h2>
  <p class="lead">
    Check these before they are used. Nothing has been stored, and nothing has
    been contacted with your password yet.
  </p>
  ${noticeHtml(data.notice)}
  <div class="notice">
${suggestionRow(
  "IMAP",
  endpoint(values, MAILBOX_FIELDS.imapHost, MAILBOX_FIELDS.imapPort),
  values[MAILBOX_FIELDS.imapTls] === CHECKBOX_ON ? "TLS" : "STARTTLS"
)}
${suggestionRow(
  "SMTP",
  endpoint(values, MAILBOX_FIELDS.smtpHost, MAILBOX_FIELDS.smtpPort),
  values[MAILBOX_FIELDS.smtpTls] === CHECKBOX_ON ? "TLS" : "STARTTLS"
)}
${caldavRow}
  </div>
  <p class="muted">${escapeHtml(data.sourceLabel)}</p>
  <form method="post" action="${escapeHtml(data.action)}" autocomplete="off">
    ${hidden}
    <label for="mailbox_password">Password</label>
    <input id="mailbox_password" name="${escapeHtml(SHARED_PASSWORD_FIELD)}" type="password"
           value="" autocomplete="off" required autofocus>
    <p class="muted">
      Passwords are never written back into this page, so it has to be typed
      again here. It is used to log in to the servers above, and stored only
      once they both answer.
    </p>
    <div class="actions">
      ${skipButton()}
      <span class="buttons">
        <button type="submit" name="_action" value="edit" class="secondary" formnovalidate>
          Edit these
        </button>
        <button type="submit" name="_action" value="save">Continue</button>
      </span>
    </div>
  </form>
  ${otherWaysIn(data, "address")}
  <p><a href="${escapeHtml(data.backHref)}">← Back</a></p>`;

  return wizardPage("mailbox", body);
}

/** One row of the provider list, as this screen needs it. */
export interface ProviderChoice {
  id: string;
  label: string;
  /** What the operator has to know before this preset works. "" for nothing. */
  note: string;
}

export interface MailboxProviderPageData extends StepTwoLinks {
  providers: readonly ProviderChoice[];
  /** The domain the lookup found nothing for, or "" when reached from the link. */
  domain: string;
  /** Carried across so the address is typed once, not once per screen. */
  email: string;
  /** Which radio is on, when a submission is being re-rendered. */
  selected: string;
  errors: Record<string, string>;
  notice?: { kind: "error" | "info"; message: string };
}

/**
 * Tier 2 — the list, when the lookup found nothing or the operator asked for it.
 *
 * The opening line is about the domain, not about the lookup: "we could not
 * detect settings for example.com" is a fact, where "the autoconfig lookup
 * failed" is a failure the operator can neither confirm nor act on. §7 is
 * explicit that no autoconfig failure is ever shown as an error, and this screen
 * is where that promise is kept.
 *
 * Radios rather than a `<select>`, because each entry has a caveat next to it
 * and a dropdown has nowhere to put one. Those caveats are the point of the
 * list: iCloud's IMAP login is not the whole address, Fastmail refuses the
 * account password outright, and an operator who meets either of those as a
 * bare "authentication failed" three screens later will conclude they typed
 * their password wrong.
 *
 * Continue leads to the full form with the preset already in it, rather than
 * straight to a save. The values are the whole reason to pick a provider and
 * this is the only screen that shows them — and for the entries whose hosts are
 * a pattern rather than a name, it is also where the host gets corrected.
 */
export function renderMailboxProviderStep(data: MailboxProviderPageData): string {
  const emailError = data.errors[ADDRESS_FIELD] ?? "";
  const providerError = data.errors[PROVIDER_FIELD] ?? "";

  const choice = (id: string, label: string, note: string): string => {
    const inputId = `provider_${id.replace(/[^a-z0-9]+/gi, "_")}`;
    return `<div class="choice">
      <div class="checkbox-row">
        <input id="${escapeHtml(inputId)}" name="${escapeHtml(PROVIDER_FIELD)}" type="radio"
               value="${escapeHtml(id)}"${data.selected === id ? " checked" : ""} required>
        <label for="${escapeHtml(inputId)}">${escapeHtml(label)}</label>
      </div>
      ${note === "" ? "" : `<p class="muted choice-note">${escapeHtml(note)}</p>`}
    </div>`;
  };

  const lead =
    data.domain === ""
      ? "Pick your provider and the servers, ports and encryption are filled in for you."
      : `We could not detect settings for ${data.domain}. Pick your provider and the ` +
        "servers, ports and encryption are filled in for you.";

  const body = `
  <p class="lead">${escapeHtml(lead)}</p>
  ${noticeHtml(data.notice)}
  <form method="post" action="${escapeHtml(data.action)}" autocomplete="off">
    <label for="mail_from">Email address</label>
    <input id="mail_from" name="${escapeHtml(ADDRESS_FIELD)}" type="email"
           value="${escapeHtml(data.email)}" required
           autocapitalize="none" autocorrect="off" spellcheck="false"${invalid(emailError)}>
    ${fieldError(emailError)}
    <fieldset>
      <legend>Provider</legend>
      ${data.providers.map((p) => choice(p.id, p.label, p.note)).join("\n      ")}
      ${choice(PROVIDER_OTHER, "Other — enter the settings myself", "")}
      ${fieldError(providerError)}
    </fieldset>
    <div class="actions">
      ${skipButton()}
      <button type="submit" name="_action" value="provider">Continue</button>
    </div>
  </form>
  ${otherWaysIn(data, "providers")}
  <p><a href="${escapeHtml(data.backHref)}">← Back</a></p>`;

  return wizardPage("mailbox", body);
}

// ---- Step 3 — PUBLIC_URL, the MCP URL, and Finish -------------------------

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
 * Step 3 — the one value the container cannot check itself, and the MCP URL.
 *
 * `PUBLIC_URL` is confirmed rather than merely displayed because a wrong one
 * breaks the OAuth redirect at claude.ai rather than here: the operator sees a
 * sign-in failure in someone else's product, with nothing in this service's log
 * to connect it to. Asking costs one radio button.
 *
 * The confirmation is `required` in the markup and checked again on the server,
 * because a browser that skips the first is not a reason to claim the instance
 * on an answer nobody gave.
 *
 * It is also asked *first*, before the MCP URL is offered for copying. The MCP
 * URL is derived from `PUBLIC_URL`, and an operator who follows this screen in
 * the order it is written must not have pasted the derived address into
 * claude.ai before being asked whether the source of it is right — which is
 * also why the No guidance sits above the address rather than below it. What
 * the first half does show is `PUBLIC_URL` itself: a confirmation of a value
 * the screen has not printed is not a confirmation.
 */
export function renderConnectStep(data: ConnectPageData): string {
  const body = `
  <p class="lead">
    One thing to check first, then the address to give claude.ai.
  </p>
  ${noticeHtml(data.notice)}

  <form method="post" action="${escapeHtml(data.action)}">
    <fieldset>
    <legend>Is this the address you reach this instance at?</legend>
    <p class="muted">
      PUBLIC_URL is currently <code>${escapeHtml(data.publicUrl)}</code>. That is the
      one value this container cannot check for itself, and a wrong one breaks the
      sign-in Claude does — with an error that surfaces at claude.ai, not here. The
      address below is built from it.
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

    <h2>Then add this instance to claude.ai</h2>
    ${urlField("mcp_url", "MCP URL", data.mcpUrl)}
    <p class="muted">
      Select the address above and copy it. In claude.ai: Settings → Connectors → Add
      custom connector, and paste it there. Claude signs in against this same
      instance, with the operator account you created in step 1.
    </p>
    ${mailboxSummary(data, {
      known: "The mailbox list is on the settings page once you are signed in.",
      unknown: "That does not stop you finishing, and it is not a sign of anything wrong here.",
    })}
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
