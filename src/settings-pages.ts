/**
 * Rendering for the mailbox settings pages — the list, the editor form, and the
 * three screens of the address-first *Add mailbox* cascade (#141).
 *
 * Pure functions: plain data in, an HTML string out. No I/O, no Express — that
 * lives in settings-routes.ts, which mounts these. Every interaction is a form
 * submission; nothing here emits a `<script>` tag, an inline `on…=` handler, or a
 * `javascript:` URL, matching the no-JavaScript, no-build-step rule that governs
 * every settings page.
 *
 * This is also the file that makes "no stored password ever reaches the browser"
 * true by construction rather than by care: a password input renders `value=""`
 * with `placeholder="unchanged"` and `autocomplete="new-password"` regardless of
 * what the underlying `Account` holds. The router applies the other half of that
 * rule on save — an empty submitted field keeps the stored value, a non-empty one
 * replaces it — but the browser never sees the old value either way. The one
 * value a password box may be rendered with is the operator's own submission on
 * its way through the cascade to the form that will send it (#120), which comes
 * from `carrying()` in settings-api.ts and never from an account.
 *
 * The mailbox form's field names are not written here. They come from
 * `MAILBOX_FIELDS` in settings-api.ts, which is also what `parseAccountForm`
 * reads them back under and what the setup wizard builds its own form and its
 * JSON drafts from — one table of names, so a rename is a compile error in
 * every place that spells one rather than a field that silently goes missing
 * (#69).
 *
 * `escapeHtml`, `pageHeaders` and `SETTINGS_CSP` used to be copied from
 * `oauth/src/login.ts` and `oauth/src/settings-pages.ts`, because the two
 * packages could not share a module. They can now: those three live in shared/
 * and are re-exported below (#126). The inline-CSS visual language — the
 * `STYLE` constant, using system colour keywords so both light and dark themes
 * work without a media query — is still a copy, and stays one: #72 is the issue
 * for the three stylesheets, and it is a design question rather than a move.
 */

import { escapeHtml } from "../shared/escape-html.js";
import { RESERVED_IDS, reservedIdNotice, type Account } from "./accounts.js";
import {
  ADDRESS_FIELD,
  CHECKBOX_ON,
  MAILBOX_FIELDS,
  MAILBOX_SECRET_FIELDS,
  SAVE_ANYWAY_FIELD,
  PROVIDER_FIELD,
  PROVIDER_OTHER,
  SHARED_PASSWORD_FIELD,
  type ProviderPreset,
} from "../shared/settings-api.js";

/**
 * Mirrors `ProbeReport` from `./probe.ts`, which is not present in this file's
 * dependency graph. Declared locally and structurally so this module compiles
 * standalone; settings-routes.ts, which imports both, passes a real
 * `ProbeReport` here because the shapes match.
 */
export interface ProbeResultView {
  ok: boolean;
  message?: string;
}

export interface ProbeReportView {
  imap: ProbeResultView;
  smtp: ProbeResultView;
  caldav: ProbeResultView | null;
}

export interface MailboxFormData {
  csrf: string;
  stamp: string;
  account: Account | null;
  values?: Record<string, string>;
  errors?: Record<string, string>;
  probe?: ProbeReportView;
  /**
   * A message across the top of the form: what happened, and to what. Used by
   * the cascade, which arrives here having filled the form in from a provider
   * preset or from a lookup the operator has just read.
   */
  notice?: string;
  /**
   * The save was refused, so the probe panel must not end with "Press Save to
   * store them" — pressing Save re-probes and refuses again.
   *
   * Stated by the caller rather than inferred. This used to be deduced from
   * `notice` being present, on the reasoning that a panel *and* a notice could
   * only mean a refusal; #148 then gave the /test routes a notice of their own
   * (the provider's credential advice) and the deduction started calling a
   * successful test a refusal. A field that carries two meanings answers the
   * wrong question eventually.
   */
  refused?: boolean;
}

export interface MailboxListData {
  csrf: string;
  stamp: string;
  accounts: Account[];
  notice?: string;
  /**
   * Per-account warnings, keyed by account id, rendered under that account's own
   * row. Passed in rather than derived here so this module stays plain data in,
   * HTML out — settings-routes.ts, which already knows which ids the routing
   * cannot serve, decides what a row has to say.
   */
  rowNotices?: Record<string, string>;
}

/**
 * The header set, the CSP and the escaper are re-exported rather than declared:
 * they live in shared/ now and the OAuth layer reads the same declarations
 * (#126). Every importer of this module keeps the names it always used.
 *
 * The connector's pages are served through the OAuth proxy and post to their
 * own origin, so nothing here needs a second CSP and nothing here should grow
 * one.
 *
 * The *senders* are deliberately not mirrored, and this is the note that says
 * so (#127). `oauth/src/settings-pages.ts` keeps `sendPage` and `sendRedirect`
 * beside its own `pageHeaders`; this package keeps `sendHtml`, `sendPlain`,
 * `sendJson` and `sendRedirect` together in settings-routes.ts. Splitting one
 * of the four out to sit next to a re-export would put the connector's senders
 * in two files to make them look like the OAuth layer's, and would give this
 * module — pure functions, plain data in, an HTML string out, no Express — its
 * first `Response` parameter. What actually has to hold across the packages is
 * the header set, and that already holds by import rather than by convention:
 * both sides get it from shared/page-headers.ts. That a redirect carries it is
 * pinned per package on a served response instead —
 * `test/unit/settings-headers.test.ts` here,
 * `oauth/test/integration/page-headers.test.ts` there.
 */
export { escapeHtml } from "../shared/escape-html.js";
export { pageHeaders, SETTINGS_CSP, SETTINGS_HEADERS } from "../shared/page-headers.js";

const STYLE = `
:root { color-scheme: light dark; }
body {
  font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
  margin: 0; min-height: 100vh;
  background: Canvas; color: CanvasText;
}
main { width: min(40rem, calc(100vw - 3rem)); margin: 0 auto; padding: 2rem 0; }
h1 { font-size: 1.25rem; margin: 0 0 .25rem; }
h2 { font-size: 1rem; margin: 1.75rem 0 .75rem; }
p.sub { margin: 0 0 1.5rem; opacity: .7; font-size: .9rem; }
label { display: block; font-size: .85rem; margin-bottom: .35rem; }
input[type=text], input[type=password], input[type=number] {
  width: 100%; box-sizing: border-box; padding: .6rem .7rem; margin-bottom: 1rem;
  border: 1px solid color-mix(in srgb, CanvasText 30%, transparent);
  border-radius: 6px; background: Canvas; color: CanvasText; font: inherit;
}
.row { display: flex; gap: 1rem; }
.row > div { flex: 1; }
.checkbox-row { display: flex; align-items: center; gap: .5rem; margin-bottom: 1rem; }
.checkbox-row label { margin-bottom: 0; }
fieldset { border: 1px solid color-mix(in srgb, CanvasText 20%, transparent);
  border-radius: 8px; padding: 1rem 1rem 0; margin: 0 0 1.5rem; }
legend { padding: 0 .4rem; font-weight: 600; font-size: .9rem; }
button {
  padding: .65rem 1.1rem; border: 0; border-radius: 6px; font: inherit;
  font-weight: 600; cursor: pointer; margin-right: .75rem;
}
button[name="_action"][value="save"],
button[name="_action"][value="lookup"],
button[name="_action"][value="provider"] { background: AccentColor; color: AccentColorText; }
button[name="_action"][value="test"],
button[name="_action"][value="edit"] {
  background: Canvas; color: CanvasText;
  border: 1px solid color-mix(in srgb, CanvasText 30%, transparent);
}
p.muted { font-size: .85rem; opacity: .75; margin: -.5rem 0 1.25rem; }
p.ways { font-size: .85rem; margin: 1.5rem 0 0; }
.choice { margin-bottom: .75rem; }
.choice .checkbox-row { margin-bottom: .25rem; }
.choice-note { margin: 0 0 .25rem 1.6rem; font-size: .8rem; opacity: .75; }
.error { padding: .6rem .7rem; margin-bottom: 1rem; border-radius: 6px; font-size: .9rem;
  background: color-mix(in srgb, #d33 15%, Canvas); color: CanvasText; }
.notice { padding: .6rem .7rem; margin-bottom: 1rem; border-radius: 6px; font-size: .9rem;
  background: color-mix(in srgb, AccentColor 15%, Canvas); color: CanvasText; }
.field-error { color: color-mix(in srgb, #d33 70%, CanvasText); font-size: .8rem;
  margin: -.75rem 0 1rem; }
table { width: 100%; border-collapse: collapse; margin-bottom: 1.5rem; }
th, td { text-align: left; padding: .5rem .4rem; border-bottom: 1px solid
  color-mix(in srgb, CanvasText 15%, transparent); font-size: .9rem; }
/* A row's notice belongs to the row above it, so the rule between the two is
   dropped where a browser can express that; where :has is unsupported the
   notice merely reads as its own row, which is still legible. */
tr:has(+ tr.row-notice) td { border-bottom: 0; }
tr.row-notice td { padding-top: 0; font-size: .8rem;
  color: color-mix(in srgb, #d33 60%, CanvasText); }
.probe-row { display: flex; justify-content: space-between; gap: 1rem;
  padding: .5rem .7rem; border-radius: 6px; margin-bottom: .5rem; font-size: .9rem;
  background: color-mix(in srgb, CanvasText 6%, Canvas); }
.probe-row.ok { border-left: 3px solid color-mix(in srgb, #2a2 60%, CanvasText); }
.probe-row.fail { border-left: 3px solid color-mix(in srgb, #d33 60%, CanvasText); }
a { color: LinkText; }
code { font-family: ui-monospace, monospace; }
`.trim();

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

/** Value to show in a text/number input: submitted value wins, else the stored one. */
function fieldValue(values: Record<string, string> | undefined, key: string, fallback: string): string {
  if (values && Object.prototype.hasOwnProperty.call(values, key)) return values[key] ?? "";
  return fallback;
}

function fieldErrorHtml(errors: Record<string, string> | undefined, key: string): string {
  const message = errors?.[key];
  return message ? `<p class="field-error">${escapeHtml(message)}</p>` : "";
}

function textField(opts: {
  id: string;
  name: string;
  label: string;
  value: string;
  type?: "text" | "number";
  readonly?: boolean;
  required?: boolean;
  errors?: Record<string, string>;
  errorKey?: string;
}): string {
  const type = opts.type ?? "text";
  const attrs = [
    `id="${escapeHtml(opts.id)}"`,
    `name="${escapeHtml(opts.name)}"`,
    `type="${type}"`,
    `value="${escapeHtml(opts.value)}"`,
    opts.readonly ? "readonly" : "",
    opts.required ? "required" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return `<label for="${escapeHtml(opts.id)}">${escapeHtml(opts.label)}</label>
<input ${attrs}>
${fieldErrorHtml(opts.errors, opts.errorKey ?? opts.name)}`;
}

/**
 * A password box — empty, unless the operator's own submission is being carried
 * into it.
 *
 * The rule this file has always kept is that no *stored* password reaches the
 * browser, and that is untouched: `values` on this form is never built out of an
 * `Account`. What it can hold is the one password typed on the address screen a
 * moment ago, on its way to the form that is about to send it — #120, and the
 * same carry the wizard makes. Every other path renders `value=""` because
 * `sanitize()` in settings-routes.ts strips the secret fields out of a
 * re-rendered submission before it ever gets here.
 *
 * `placeholder="unchanged"` goes with the empty box and not with a filled one:
 * on a new mailbox there is nothing to leave unchanged, and over a value the
 * operator can see it would be a caption contradicting the box it sits in.
 */
function passwordField(opts: {
  id: string;
  name: string;
  label: string;
  required?: boolean;
  errors?: Record<string, string>;
  /** Carried forward from the screen it was typed on. "" for every other path. */
  carried?: string;
}): string {
  const carried = opts.carried ?? "";
  const placeholder = carried === "" ? `placeholder="unchanged" ` : "";
  return `<label for="${escapeHtml(opts.id)}">${escapeHtml(opts.label)}</label>
<input id="${escapeHtml(opts.id)}" name="${escapeHtml(opts.name)}" type="password" value="${escapeHtml(carried)}"
       ${placeholder}autocomplete="new-password"${opts.required ? " required" : ""}>
${fieldErrorHtml(opts.errors, opts.name)}`;
}

function checkboxField(opts: { id: string; name: string; label: string; checked: boolean }): string {
  return `<div class="checkbox-row">
  <input id="${escapeHtml(opts.id)}" type="checkbox" name="${escapeHtml(opts.name)}" value="1"${
    opts.checked ? " checked" : ""
  }>
  <label for="${escapeHtml(opts.id)}">${escapeHtml(opts.label)}</label>
</div>`;
}

function probeRowHtml(name: string, result: ProbeResultView): string {
  const status = result.ok ? "ok" : `failed: ${escapeHtml(result.message ?? "unknown error")}`;
  return `<div class="probe-row ${result.ok ? "ok" : "fail"}"><strong>${escapeHtml(
    name
  )}</strong><span>${status}</span></div>`;
}

/**
 * *Save anyway* — the escape hatch in front of the probing save (#147).
 *
 * Written **after** Save in the DOM, and never given `formaction` or any other
 * way of being the form's first submit button. That ordering is the whole
 * constraint: a form submitted implicitly — Enter in a text box — is submitted
 * as if its *first* submit button had been pressed, which is how #140 turned
 * Enter in the wizard's address field into "skip this mailbox". Enter here
 * presses Save, which probes; reaching this one takes a deliberate click.
 *
 * It carries its own field name rather than an `_action` value, because that
 * name is the wire contract's — {@link SAVE_ANYWAY_FIELD} — and a
 * `<button name value>` contributes its pair only when it is the button that
 * was activated. So the field arrives exactly when the operator pressed this
 * and never otherwise, in the same body shape a JSON caller sends.
 *
 * Rendered whether or not there has been a refusal — the probe budget is 25
 * seconds, and an operator who already knows their server is in a maintenance
 * window should not have to sit through it to be shown the way past it — but
 * *not* on a form whose Save cannot store anything. `savable` is the same flag
 * {@link probeSectionHtml} is given, and for the same reason: on the edit form
 * of an account whose id is reserved, the submission goes to a route that is not
 * its own, so a button reading "Save anyway" promises the one thing that
 * definitely will not happen. It was rendered there unconditionally until #130.
 */
function saveAnywayButton(savable: boolean): string {
  if (!savable) return "";
  return `<button type="submit" name="${escapeHtml(SAVE_ANYWAY_FIELD)}" value="${escapeHtml(
    CHECKBOX_ON
  )}" title="Store this mailbox without testing the connection first">
    Save anyway
  </button>`;
}

/**
 * The probe panel, in one of three states.
 *
 * - `"savable"` — the ordinary case, after *Test connection*: nothing was
 *   stored, and Save is what stores it.
 * - `"unsavable"` — an account whose id is reserved. The form's Save posts to a
 *   route that is not its own (see RESERVED_IDS in accounts.ts), so "Press Save
 *   to store them" would be a lie, and one the operator has already been told
 *   the opposite of on the list row. The remedy is not repeated here — the
 *   notice above the panel carries it.
 * - `"refused"` — the panel is on a page that has *just refused a Save*. The
 *   third state exists because the first one was being used for it: under a
 *   failing IMAP row, on a 400, the panel said "Press Save to store them" — a
 *   step that cannot work, since pressing Save re-probes and refuses again, and
 *   one that contradicts the `saveRefusedNotice` a few lines above it. What is
 *   true on that page is the other button, so the footer says nothing and lets
 *   the notice do the talking.
 */
type ProbePanelState = "savable" | "unsavable" | "refused";

function probeSectionHtml(probe: ProbeReportView | undefined, state: ProbePanelState): string {
  if (!probe) return "";
  const rows = [
    probeRowHtml("IMAP", probe.imap),
    probeRowHtml("SMTP", probe.smtp),
    probe.caldav ? probeRowHtml("CalDAV", probe.caldav) : "",
  ]
    .filter(Boolean)
    .join("\n");
  const footer = {
    savable: "These values were not saved. Press Save to store them.",
    unsavable: "These values were not saved, and Save will not store them either.",
    refused: "",
  }[state];
  return `<div class="notice">
${rows}
${footer === "" ? "" : `<p>${escapeHtml(footer)}</p>`}
</div>`;
}

/** Render the mailbox list page: one row per configured account. */
export function renderMailboxList(opts: MailboxListData): string {
  const notice = opts.notice ? `<div class="notice">${escapeHtml(opts.notice)}</div>` : "";
  const rows = opts.accounts
    .map((account) => {
      const editHref = `/settings/mailboxes/${encodeURIComponent(account.id)}`;
      const rowNotice = opts.rowNotices?.[account.id];
      // A second row spanning the table rather than a cell inside the first
      // one: the notice is a sentence, and the four columns are all narrow.
      const noticeRow = rowNotice
        ? `\n<tr class="row-notice"><td colspan="4">${escapeHtml(rowNotice)}</td></tr>`
        : "";
      return `<tr>
  <td>${escapeHtml(account.label)}</td>
  <td><code>${escapeHtml(account.id)}</code></td>
  <td>${account.default ? "Yes" : ""}</td>
  <td>
    <a href="${escapeHtml(editHref)}">Edit</a>
    <form method="post" action="${escapeHtml(editHref)}/default" style="display:inline">
      <input type="hidden" name="_csrf" value="${escapeHtml(opts.csrf)}">
      <input type="hidden" name="_stamp" value="${escapeHtml(opts.stamp)}">
      ${account.default ? "" : `<button type="submit">Make default</button>`}
    </form>
    <form method="post" action="${escapeHtml(editHref)}/delete" style="display:inline">
      <input type="hidden" name="_csrf" value="${escapeHtml(opts.csrf)}">
      <input type="hidden" name="_stamp" value="${escapeHtml(opts.stamp)}">
      <button type="submit">Delete</button>
    </form>
  </td>
</tr>${noticeRow}`;
    })
    .join("\n");

  const body = `<h1>Mailboxes</h1>
<p class="sub">Accounts configured for this connector.</p>
${notice}
<table>
<thead><tr><th>Label</th><th>ID</th><th>Default</th><th></th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
<a href="/settings/mailboxes/new">Add mailbox</a>
<p><a href="/settings">Back to settings</a></p>`;

  return page("Mailboxes", body);
}

/** Render the create/edit form for a single mailbox account. */
export function renderMailboxForm(opts: MailboxFormData): string {
  const { account, values, errors } = opts;
  const isNew = account === null;
  const idValue = fieldValue(values, MAILBOX_FIELDS.id, account?.id ?? "");
  const labelValue = fieldValue(values, MAILBOX_FIELDS.label, account?.label ?? "");
  const defaultChecked = values
    ? values[MAILBOX_FIELDS.isDefault] === "1"
    : Boolean(account?.default);

  const imap = account?.imap;
  const smtp = account?.smtp;
  const mail = account?.mail;
  const caldav = account?.caldav;

  // The one password the operator typed on the address screen, on its way to
  // the boxes that are about to send it (#120). Never an account's: `values` on
  // this form is built either by `sanitize()`, which strips every secret field,
  // or by the cascade's `carrying()`, which puts back only what was just typed.
  const carried = (name: string): string => values?.[name] ?? "";
  // Over every secret field, not the two that were obvious. `withCarriedPasswords`
  // carries all of MAILBOX_SECRET_FIELDS, so a submission that filled only the
  // CalDAV password used to print "Password fields are always blank here"
  // directly above a visible, populated CalDAV box. Harmless while both create
  // forms mark IMAP and SMTP `required`; ordinary on the edit form, where
  // changing only the CalDAV password is a normal thing to do.
  const anyCarried = MAILBOX_SECRET_FIELDS.some((name) => carried(name) !== "");

  // An account already stored under a reserved id cannot be edited in place:
  // the form action built just below is a literal settings route, not this
  // account's own. The list page already says so on that account's row; the
  // form repeats it verbatim rather than letting the operator arrive here and
  // read the opposite from the probe panel. See RESERVED_IDS in accounts.ts.
  //
  // Derived here rather than handed in the way the list page's rowNotices are:
  // this function is the one that builds the colliding action, every route that
  // renders an edit form reaches it (save, probe and validation-error paths
  // included), and reservedIdNotice() is the same pure string builder the list
  // row and the startup warning already use, so the two can never drift apart.
  const reserved = account !== null && RESERVED_IDS.has(account.id);
  const reservedNotice = reserved
    ? `<div class="notice">${escapeHtml(reservedIdNotice(account.id))}</div>`
    : "";

  const actionPath = isNew ? "/settings/mailboxes" : `/settings/mailboxes/${encodeURIComponent(account.id)}`;
  const testPath = isNew ? "/settings/mailboxes/test" : `/settings/mailboxes/${encodeURIComponent(account.id)}/test`;

  const caldavGroup = `<fieldset>
<legend>CalDAV (optional)</legend>
${textField({
  id: "caldav_url",
  name: MAILBOX_FIELDS.caldavUrl,
  label: "URL",
  value: fieldValue(values, MAILBOX_FIELDS.caldavUrl, caldav?.url ?? ""),
  errors,
})}
${textField({
  id: "caldav_user",
  name: MAILBOX_FIELDS.caldavUser,
  label: "User",
  value: fieldValue(values, MAILBOX_FIELDS.caldavUser, caldav?.user ?? ""),
  errors,
})}
${passwordField({
  id: "caldav_pass",
  name: MAILBOX_FIELDS.caldavPass,
  label: "Password",
  errors,
  carried: carried(MAILBOX_FIELDS.caldavPass),
})}
${
  caldav
    ? checkboxField({
        id: "remove_caldav",
        name: "remove_caldav",
        label: "Remove CalDAV from this account",
        checked: values?.["remove_caldav"] === "1",
      })
    : ""
}
</fieldset>`;

  const sub = anyCarried
    ? "The password you entered has been carried over rather than asked for again. " +
      "Change it here if this mailbox takes a different one for IMAP and SMTP."
    : "Password fields are always blank here. Leave one blank to keep the stored value.";

  // Said by the caller, not deduced from what else is on the page. See
  // `probeSectionHtml` for what the three states are for.
  const panelState: ProbePanelState = reserved
    ? "unsavable"
    : opts.refused === true
      ? "refused"
      : "savable";

  const body = `<h1>${isNew ? "Add mailbox" : `Edit mailbox — ${escapeHtml(account.label)}`}</h1>
<p class="sub">${escapeHtml(sub)}</p>
${opts.notice === undefined ? "" : `<div class="notice">${escapeHtml(opts.notice)}</div>`}
${reservedNotice}
${probeSectionHtml(opts.probe, panelState)}
<form method="post" action="${escapeHtml(actionPath)}" autocomplete="off">
  <input type="hidden" name="_csrf" value="${escapeHtml(opts.csrf)}">
  <input type="hidden" name="_stamp" value="${escapeHtml(opts.stamp)}">

  ${textField({
    id: "id",
    name: MAILBOX_FIELDS.id,
    label: "ID",
    value: idValue,
    readonly: !isNew,
    required: true,
    errors,
  })}
  ${textField({ id: "label", name: MAILBOX_FIELDS.label, label: "Label", value: labelValue, required: true, errors })}
  ${checkboxField({ id: "default", name: MAILBOX_FIELDS.isDefault, label: "Default account", checked: defaultChecked })}

  <fieldset>
  <legend>IMAP</legend>
  <div class="row">
    <div>${textField({
      id: "imap_host",
      name: MAILBOX_FIELDS.imapHost,
      label: "Host",
      value: fieldValue(values, MAILBOX_FIELDS.imapHost, imap?.host ?? ""),
      required: true,
      errors,
    })}</div>
    <div>${textField({
      id: "imap_port",
      name: MAILBOX_FIELDS.imapPort,
      label: "Port",
      type: "number",
      value: fieldValue(values, MAILBOX_FIELDS.imapPort, imap ? String(imap.port) : "993"),
      required: true,
      errors,
    })}</div>
  </div>
  ${textField({
    id: "imap_user",
    name: MAILBOX_FIELDS.imapUser,
    label: "User",
    value: fieldValue(values, MAILBOX_FIELDS.imapUser, imap?.user ?? ""),
    required: true,
    errors,
  })}
  ${passwordField({
    id: "imap_pass",
    name: MAILBOX_FIELDS.imapPass,
    label: "Password",
    required: isNew,
    errors,
    carried: carried(MAILBOX_FIELDS.imapPass),
  })}
  ${checkboxField({
    id: "imap_tls",
    name: MAILBOX_FIELDS.imapTls,
    label: "Use TLS",
    checked: values ? values[MAILBOX_FIELDS.imapTls] === "1" : (imap?.tls ?? true),
  })}
  </fieldset>

  <fieldset>
  <legend>SMTP</legend>
  <div class="row">
    <div>${textField({
      id: "smtp_host",
      name: MAILBOX_FIELDS.smtpHost,
      label: "Host",
      value: fieldValue(values, MAILBOX_FIELDS.smtpHost, smtp?.host ?? ""),
      required: true,
      errors,
    })}</div>
    <div>${textField({
      id: "smtp_port",
      name: MAILBOX_FIELDS.smtpPort,
      label: "Port",
      type: "number",
      value: fieldValue(values, MAILBOX_FIELDS.smtpPort, smtp ? String(smtp.port) : "465"),
      required: true,
      errors,
    })}</div>
  </div>
  ${textField({
    id: "smtp_user",
    name: MAILBOX_FIELDS.smtpUser,
    label: "User",
    value: fieldValue(values, MAILBOX_FIELDS.smtpUser, smtp?.user ?? ""),
    required: true,
    errors,
  })}
  ${passwordField({
    id: "smtp_pass",
    name: MAILBOX_FIELDS.smtpPass,
    label: "Password",
    required: isNew,
    errors,
    carried: carried(MAILBOX_FIELDS.smtpPass),
  })}
  ${checkboxField({
    id: "smtp_tls",
    name: MAILBOX_FIELDS.smtpTls,
    label: "Use TLS",
    checked: values ? values[MAILBOX_FIELDS.smtpTls] === "1" : (smtp?.tls ?? true),
  })}
  </fieldset>

  <fieldset>
  <legend>Mail defaults</legend>
  ${textField({
    id: "mail_from",
    name: MAILBOX_FIELDS.mailDefaultFrom,
    label: "From address",
    value: fieldValue(values, MAILBOX_FIELDS.mailDefaultFrom, mail?.defaultFrom ?? ""),
    required: true,
    errors,
  })}
  ${textField({
    id: "mail_from_name",
    name: MAILBOX_FIELDS.mailDefaultFromName,
    label: "From name",
    value: fieldValue(values, MAILBOX_FIELDS.mailDefaultFromName, mail?.defaultFromName ?? ""),
    errors,
  })}
  ${textField({
    id: "mail_drafts",
    name: MAILBOX_FIELDS.mailDraftsFolder,
    label: "Drafts folder",
    value: fieldValue(values, MAILBOX_FIELDS.mailDraftsFolder, mail?.draftsFolder ?? "Drafts"),
    errors,
  })}
  ${textField({
    id: "mail_sent",
    name: MAILBOX_FIELDS.mailSentFolder,
    label: "Sent folder",
    value: fieldValue(values, MAILBOX_FIELDS.mailSentFolder, mail ? (mail.sentFolder ?? "") : "Sent"),
    errors,
  })}
  </fieldset>

  ${caldavGroup}

  <button type="submit" name="_action" value="save">Save</button>
  <button type="submit" formaction="${escapeHtml(testPath)}" name="_action" value="test">
    Test connection
  </button>
  ${saveAnywayButton(!reserved)}
</form>
${isNew ? otherWaysIn("manual") : ""}
<p><a href="/settings">Back to settings</a></p>`;

  return page(isNew ? "Add mailbox" : "Edit mailbox", body);
}

// ---- Add mailbox, address first --------------------------------------------
//
// Three more screens, all of them *Add mailbox*, and all of them served from
// `/settings/mailboxes/new`:
//
//   the address screen   →  a lookup, and what it found, for confirmation
//                        →  or, when it found nothing, the provider list
//                        →  or, from either, the full form above
//
// The full form is the last of them rather than the first. That is the whole of
// #141: the wizard has run this cascade since #70, but only once, for the
// mailbox an operator is most likely to know the settings for — and every
// mailbox after it got eighteen empty boxes.
//
// The branching between them is not here and is not the wizard's either. It is
// `stepFromLookup` / `stepFromProvider` / `stepFromEdit` in settings-api.ts,
// which both entry points call; these functions render one screen each from what
// those decided. What differs between the two entry points, and is why there are
// two sets of renderers rather than a mirrored one, is exactly the chrome: the
// wizard has a step counter and a Skip button on every screen, and these have a
// CSRF token, an accounts stamp and a way back to the mailbox list.

/** Which of the four screens is being looked at, for the links out of it. */
type AddMailboxView = "address" | "suggestion" | "providers" | "manual";

/** The three ways in, as URLs. `?view=` is how the last two are reached. */
const ADD_MAILBOX = "/settings/mailboxes/new";
const ADD_MAILBOX_PROVIDERS = `${ADD_MAILBOX}?view=providers`;
const ADD_MAILBOX_MANUAL = `${ADD_MAILBOX}?view=manual`;

/**
 * The other tiers, as links.
 *
 * Every screen offers the ones it is not, which is what makes this a cascade
 * rather than a funnel: the lookup is a convenience, and an operator who already
 * knows their settings must never have to walk through it to reach the form. The
 * confirmation screen counts as the address screen here — it is what that screen
 * turned into, and offering "look it up from the address" on it would be a link
 * back to where they just were.
 */
function otherWaysIn(current: AddMailboxView): string {
  const all: Array<{ view: AddMailboxView; href: string; text: string }> = [
    { view: "address", href: ADD_MAILBOX, text: "Look it up from the address" },
    { view: "providers", href: ADD_MAILBOX_PROVIDERS, text: "Choose provider manually" },
    { view: "manual", href: ADD_MAILBOX_MANUAL, text: "Enter all the settings myself" },
  ];
  const shown = current === "suggestion" ? "address" : current;
  const links = all
    .filter((entry) => entry.view !== shown)
    .map((entry) => `<a href="${escapeHtml(entry.href)}">${escapeHtml(entry.text)}</a>`)
    .join(" · ");
  return `<p class="ways">${links}</p>`;
}

function noticeHtml(notice: string | undefined): string {
  return notice === undefined ? "" : `<div class="notice">${escapeHtml(notice)}</div>`;
}

export interface MailboxAddressData {
  csrf: string;
  /** What to put back in the address box after a rejected submission. */
  email: string;
  /** Keyed by field name, so the address's own rejection sits against its box. */
  errors?: Record<string, string>;
  notice?: string;
}

/**
 * Tier 1 — an address and a password, and nothing else on the screen.
 *
 * On Continue the connector looks the domain up — autoconfig, then the ISPDB,
 * then RFC 6186 SRV records, all of it `src/autoconfig.ts` and none of it new
 * here — and what it finds is shown for confirmation. A lookup that finds
 * nothing is not a failure and is never reported as one: the next screen is
 * simply the provider list.
 *
 * The password is asked for here rather than after the lookup because it is the
 * other half of the same thought — "this is my mailbox" — and because a screen
 * that asks for an address, goes away for up to ten seconds and then asks for a
 * password reads as two steps rather than one.
 */
export function renderMailboxAddress(opts: MailboxAddressData): string {
  const emailError = opts.errors?.[ADDRESS_FIELD] ?? "";
  const body = `<h1>Add mailbox</h1>
<p class="sub">Start with the address. Most providers publish their own settings, so the
servers, ports and encryption can usually be worked out from it.</p>
${noticeHtml(opts.notice)}
<form method="post" action="${escapeHtml(ADD_MAILBOX)}" autocomplete="off">
  <input type="hidden" name="_csrf" value="${escapeHtml(opts.csrf)}">
  <label for="mail_from">Email address</label>
  <input id="mail_from" name="${escapeHtml(ADDRESS_FIELD)}" type="text"
         value="${escapeHtml(opts.email)}" required autofocus
         autocapitalize="none" autocorrect="off" spellcheck="false">
  ${fieldErrorHtml(opts.errors, ADDRESS_FIELD)}
  <label for="mailbox_password">Password</label>
  <input id="mailbox_password" name="${escapeHtml(SHARED_PASSWORD_FIELD)}" type="password"
         value="" autocomplete="new-password" required>
  <p class="muted">The password for the mailbox itself. Some providers want an app password
  here rather than the one you sign in to their website with.</p>
  <button type="submit" name="_action" value="lookup">Continue</button>
</form>
${otherWaysIn("address")}
<p><a href="/settings/mailboxes">Back to mailboxes</a></p>`;

  return page("Add mailbox", body);
}

export interface MailboxSuggestionData {
  csrf: string;
  /** The stamp the save must still be against, read when this page was built. */
  stamp: string;
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
  /**
   * The password the operator typed on the address screen, or "" when the
   * submission that triggered the lookup did not carry one.
   *
   * Not part of {@link MailboxSuggestionData.values}: those are the connector's
   * field names and the rows on the screen are rendered from them, which is the
   * last place a password belongs.
   */
  password: string;
  errors?: Record<string, string>;
  notice?: string;
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
 * The password, carried rather than asked for a second time.
 *
 * #120: the operator typed it on the address screen, that submission is what
 * produced this one, and asking again — on a screen that until now said nothing
 * about the first answer — is the page forgetting something the operator can
 * plainly see it was told.
 *
 * A hidden input is the shape, because that is how the rest of this screen
 * already travels: the settings it is confirming are hidden inputs too, and the
 * page is `Cache-Control: no-store`. It is stated in words as well — a screen
 * that has silently acquired a credential is one an operator cannot reason
 * about.
 *
 * The empty case is not hypothetical. `required` on the address screen is the
 * browser's promise, not this module's, and a POST that skipped it still has to
 * produce a screen the operator can finish on.
 */
function suggestionPassword(password: string): string {
  if (password === "") {
    return `<label for="mailbox_password">Password</label>
  <input id="mailbox_password" name="${escapeHtml(SHARED_PASSWORD_FIELD)}" type="password"
         value="" autocomplete="new-password" required autofocus>
  <p class="muted">Passwords are never written back into this page, so it has to be typed
  here. It is used to log in to the servers above, and stored with the mailbox.</p>`;
  }
  return `<input type="hidden" name="${escapeHtml(SHARED_PASSWORD_FIELD)}" value="${escapeHtml(
    password
  )}">
  <p class="muted">The password you entered is carried with this form, so there is nothing to
  type here — press Edit these to change it, or to give IMAP and SMTP different ones.</p>`;
}

/**
 * Tier 1's answer: what the lookup found, shown before any of it is used.
 *
 * The whole point of this screen is that it exists. Applying an autoconfig
 * answer silently would be less typing and much worse: a wrong host produces a
 * connection failure minutes later, on a screen that says nothing about where
 * the host came from, and an operator who never saw it has no reason to suspect
 * it. Here they read it once, and `Edit these` is one press away.
 *
 * The ID and the name are boxes rather than rows, unlike the wizard's version of
 * this screen. The wizard's first mailbox is `main` and there is nothing to
 * collide with; a second mailbox needs an id of its own, and one derived from
 * the address is a suggestion — shown, not applied — that the operator can
 * change here rather than meeting it as a rejection after pressing Save.
 *
 * CalDAV missing is stated as ordinary, because it is. Most mail providers
 * publish nothing for it, calendars are optional in the account model, and an
 * operator who reads "not found" as a problem will go looking for one.
 */
export function renderMailboxSuggestion(opts: MailboxSuggestionData): string {
  const { values, errors } = opts;

  // Everything except the two the operator is being shown as boxes, which the
  // form submits under the same names anyway — a hidden twin would send the
  // field twice and `draftFromFields` reads a repeated field as absent.
  const shown = new Set<string>([MAILBOX_FIELDS.id, MAILBOX_FIELDS.label]);
  const hidden = Object.entries(values)
    .filter(([name]) => !shown.has(name))
    .map(
      ([name, value]) =>
        `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`
    )
    .join("\n  ");

  const caldavUrl = values[MAILBOX_FIELDS.caldavUrl] ?? "";
  const caldavRow =
    caldavUrl === ""
      ? `<div class="probe-row"><strong>CalDAV</strong><span>not found — calendars can be added later</span></div>`
      : suggestionRow("CalDAV", caldavUrl, "");

  const body = `<h1>Add mailbox</h1>
<p class="sub">Found settings for ${escapeHtml(opts.domain)}. Check them before they are used —
nothing has been stored, and nothing has been contacted with your password yet.</p>
${noticeHtml(opts.notice)}
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
<p class="muted">${escapeHtml(opts.sourceLabel)}</p>
<form method="post" action="/settings/mailboxes" autocomplete="off">
  <input type="hidden" name="_csrf" value="${escapeHtml(opts.csrf)}">
  <input type="hidden" name="_stamp" value="${escapeHtml(opts.stamp)}">
  ${hidden}
  ${textField({
    id: "label",
    name: MAILBOX_FIELDS.label,
    label: "Name for this mailbox",
    value: values[MAILBOX_FIELDS.label] ?? "",
    required: true,
    errors,
  })}
  ${textField({
    id: "id",
    name: MAILBOX_FIELDS.id,
    label: "ID",
    value: values[MAILBOX_FIELDS.id] ?? "",
    required: true,
    errors,
  })}
  <p class="muted">How the mail tools refer to this mailbox. Lowercase letters, digits, _ or -.</p>
  ${suggestionPassword(opts.password)}
  <button type="submit" name="_action" value="save">Save mailbox</button>
  <button type="submit" name="_action" value="edit"
          formaction="${escapeHtml(ADD_MAILBOX)}" formnovalidate>
    Edit these
  </button>
</form>
${otherWaysIn("suggestion")}
<p><a href="/settings/mailboxes">Back to mailboxes</a></p>`;

  return page("Add mailbox", body);
}

export interface MailboxProvidersData {
  csrf: string;
  /** The table, as the connector's own `providerPresets` produced it. */
  providers: readonly ProviderPreset[];
  /** The domain the lookup found nothing for, or "" when reached from the link. */
  domain: string;
  /** Carried across so the address is typed once, not once per screen. */
  email: string;
  /** Which radio is on, when a submission is being re-rendered. */
  selected: string;
  /**
   * The password the operator typed on the address screen, or "" when this
   * screen was reached from its own link and nobody has typed one yet.
   */
  password: string;
  errors?: Record<string, string>;
  notice?: string;
}

/**
 * The password on the way through tier 2, on the one route that has one.
 *
 * This screen is reached two ways, and #120 is only about one of them. From a
 * lookup that found nothing, the operator typed a password a moment ago and this
 * screen is on the way to the form that will use it. From the `Choose provider
 * manually` link, nobody has typed anything, so there is nothing to carry and
 * nothing to say about it — and a note claiming otherwise would be the worse
 * half of the bug.
 */
function providerPassword(password: string): string {
  if (password === "") return "";
  return `<input type="hidden" name="${escapeHtml(SHARED_PASSWORD_FIELD)}" value="${escapeHtml(
    password
  )}">
  <p class="muted">The password you entered is carried with this form, so the next screen has
  it already.</p>`;
}

/**
 * Tier 2 — the list, when the lookup found nothing or the operator asked for it.
 *
 * The opening line is about the domain, not about the lookup: "we could not
 * detect settings for example.com" is a fact, where "the autoconfig lookup
 * failed" is a failure the operator can neither confirm nor act on, and no
 * autoconfig failure is ever shown as an error.
 *
 * Radios rather than a `<select>`, because each entry has a caveat next to it
 * and a dropdown has nowhere to put one. Those caveats are the point of the
 * list: iCloud's IMAP login is not the whole address, Fastmail refuses the
 * account password outright, and an operator who meets either of those as a bare
 * "authentication failed" two screens later will conclude they typed their
 * password wrong.
 */
export function renderMailboxProviders(opts: MailboxProvidersData): string {
  const choice = (id: string, label: string, note: string): string => {
    const inputId = `provider_${id.replace(/[^a-z0-9]+/gi, "_")}`;
    return `<div class="choice">
    <div class="checkbox-row">
      <input id="${escapeHtml(inputId)}" name="${escapeHtml(PROVIDER_FIELD)}" type="radio"
             value="${escapeHtml(id)}"${opts.selected === id ? " checked" : ""} required>
      <label for="${escapeHtml(inputId)}">${escapeHtml(label)}</label>
    </div>
    ${note === "" ? "" : `<p class="choice-note">${escapeHtml(note)}</p>`}
  </div>`;
  };

  const lead =
    opts.domain === ""
      ? "Pick your provider and the servers, ports and encryption are filled in for you."
      : `We could not detect settings for ${opts.domain}. Pick your provider and the ` +
        "servers, ports and encryption are filled in for you.";

  const body = `<h1>Add mailbox</h1>
<p class="sub">${escapeHtml(lead)}</p>
${noticeHtml(opts.notice)}
<form method="post" action="${escapeHtml(ADD_MAILBOX)}" autocomplete="off">
  <input type="hidden" name="_csrf" value="${escapeHtml(opts.csrf)}">
  <label for="mail_from">Email address</label>
  <input id="mail_from" name="${escapeHtml(ADDRESS_FIELD)}" type="text"
         value="${escapeHtml(opts.email)}" required
         autocapitalize="none" autocorrect="off" spellcheck="false">
  ${fieldErrorHtml(opts.errors, ADDRESS_FIELD)}
  <fieldset>
  <legend>Provider</legend>
  ${opts.providers.map((p) => choice(p.id, p.label, p.note)).join("\n  ")}
  ${choice(PROVIDER_OTHER, "Other — enter the settings myself", "")}
  ${fieldErrorHtml(opts.errors, PROVIDER_FIELD)}
  </fieldset>
  ${providerPassword(opts.password)}
  <button type="submit" name="_action" value="provider">Continue</button>
</form>
${otherWaysIn("providers")}
<p><a href="/settings/mailboxes">Back to mailboxes</a></p>`;

  return page("Add mailbox", body);
}
