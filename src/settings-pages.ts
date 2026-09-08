/**
 * Rendering for the mailbox settings pages — the list and the editor form.
 *
 * Pure functions: plain data in, an HTML string out. No I/O, no Express — that
 * lives in settings-routes.ts, which mounts these. Every interaction is a form
 * submission; nothing here emits a `<script>` tag, an inline `on…=` handler, or a
 * `javascript:` URL, matching the no-JavaScript, no-build-step rule that governs
 * every settings page.
 *
 * This is also the file that makes "no stored password ever reaches the browser"
 * true by construction rather than by care: password inputs always render
 * `value=""` with `placeholder="unchanged"` and `autocomplete="new-password"`,
 * regardless of what the underlying `Account` holds. The router applies the other
 * half of that rule on save — an empty submitted field keeps the stored value, a
 * non-empty one replaces it — but the browser never sees the old value either way.
 *
 * `escapeHtml` and the inline-CSS visual language (the `STYLE` constant, using
 * system colour keywords so both light and dark themes work without a media
 * query) are copied from `oauth/src/login.ts`. The two packages cannot share a
 * module — nothing under `src/` may import from `oauth/` — so this duplication is
 * deliberate, not an oversight.
 */

import type { Account } from "./accounts.js";

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
}

export interface MailboxListData {
  csrf: string;
  stamp: string;
  accounts: Account[];
  notice?: string;
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

/**
 * Response headers every settings page sets.
 *
 * Mirrors `SETTINGS_HEADERS` in oauth/src/settings-pages.ts byte-for-byte. The
 * two packages have separate Docker build contexts and cannot share a module,
 * so this duplication is required, not an oversight — if you change one,
 * change both. These pages carry a CSRF token and a mailbox password field,
 * must not be cached anywhere, and have no reason to be framed; the CSP
 * allows inline styles and nothing else, matching the no-JavaScript rule
 * that governs every settings page.
 */
export const SETTINGS_HEADERS: Record<string, string> = {
  "Cache-Control": "no-store",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy":
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
  // same-origin, mirroring the OAuth layer. These pages' forms resolve relative
  // to the browser's own origin, and the OAuth layer's own guards read Referer as
  // a fallback when Chrome omits Origin on a same-origin form POST. Keeping this
  // at no-referrer would be a trap for anyone who later adds such a check here.
  "Referrer-Policy": "same-origin",
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
button[name="_action"][value="save"] { background: AccentColor; color: AccentColorText; }
button[name="_action"][value="test"] {
  background: Canvas; color: CanvasText;
  border: 1px solid color-mix(in srgb, CanvasText 30%, transparent);
}
.error { padding: .6rem .7rem; margin-bottom: 1rem; border-radius: 6px; font-size: .9rem;
  background: color-mix(in srgb, #d33 15%, Canvas); color: CanvasText; }
.notice { padding: .6rem .7rem; margin-bottom: 1rem; border-radius: 6px; font-size: .9rem;
  background: color-mix(in srgb, AccentColor 15%, Canvas); color: CanvasText; }
.field-error { color: color-mix(in srgb, #d33 70%, CanvasText); font-size: .8rem;
  margin: -.75rem 0 1rem; }
table { width: 100%; border-collapse: collapse; margin-bottom: 1.5rem; }
th, td { text-align: left; padding: .5rem .4rem; border-bottom: 1px solid
  color-mix(in srgb, CanvasText 15%, transparent); font-size: .9rem; }
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

function passwordField(opts: { id: string; name: string; label: string; required?: boolean }): string {
  return `<label for="${escapeHtml(opts.id)}">${escapeHtml(opts.label)}</label>
<input id="${escapeHtml(opts.id)}" name="${escapeHtml(opts.name)}" type="password" value=""
       placeholder="unchanged" autocomplete="new-password"${opts.required ? " required" : ""}>`;
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

function probeSectionHtml(probe: ProbeReportView | undefined): string {
  if (!probe) return "";
  const rows = [
    probeRowHtml("IMAP", probe.imap),
    probeRowHtml("SMTP", probe.smtp),
    probe.caldav ? probeRowHtml("CalDAV", probe.caldav) : "",
  ]
    .filter(Boolean)
    .join("\n");
  return `<div class="notice">
${rows}
<p>These values were not saved. Press Save to store them.</p>
</div>`;
}

/** Render the mailbox list page: one row per configured account. */
export function renderMailboxList(opts: MailboxListData): string {
  const notice = opts.notice ? `<div class="notice">${escapeHtml(opts.notice)}</div>` : "";
  const rows = opts.accounts
    .map((account) => {
      const editHref = `/settings/mailboxes/${encodeURIComponent(account.id)}`;
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
</tr>`;
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
  const idValue = fieldValue(values, "id", account?.id ?? "");
  const labelValue = fieldValue(values, "label", account?.label ?? "");
  const defaultChecked = values
    ? values["default"] === "1"
    : Boolean(account?.default);

  const imap = account?.imap;
  const smtp = account?.smtp;
  const mail = account?.mail;
  const caldav = account?.caldav;

  const actionPath = isNew ? "/settings/mailboxes" : `/settings/mailboxes/${encodeURIComponent(account.id)}`;
  const testPath = isNew ? "/settings/mailboxes/test" : `/settings/mailboxes/${encodeURIComponent(account.id)}/test`;

  const caldavGroup = `<fieldset>
<legend>CalDAV (optional)</legend>
${textField({
  id: "caldav_url",
  name: "caldav.url",
  label: "URL",
  value: fieldValue(values, "caldav.url", caldav?.url ?? ""),
  errors,
})}
${textField({
  id: "caldav_user",
  name: "caldav.user",
  label: "User",
  value: fieldValue(values, "caldav.user", caldav?.user ?? ""),
  errors,
})}
${passwordField({ id: "caldav_pass", name: "caldav.pass", label: "Password" })}
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

  const body = `<h1>${isNew ? "Add mailbox" : `Edit mailbox — ${escapeHtml(account.label)}`}</h1>
<p class="sub">Password fields are always blank here. Leave one blank to keep the stored value.</p>
${probeSectionHtml(opts.probe)}
<form method="post" action="${escapeHtml(actionPath)}" autocomplete="off">
  <input type="hidden" name="_csrf" value="${escapeHtml(opts.csrf)}">
  <input type="hidden" name="_stamp" value="${escapeHtml(opts.stamp)}">

  ${textField({
    id: "id",
    name: "id",
    label: "ID",
    value: idValue,
    readonly: !isNew,
    required: true,
    errors,
  })}
  ${textField({ id: "label", name: "label", label: "Label", value: labelValue, required: true, errors })}
  ${checkboxField({ id: "default", name: "default", label: "Default account", checked: defaultChecked })}

  <fieldset>
  <legend>IMAP</legend>
  <div class="row">
    <div>${textField({
      id: "imap_host",
      name: "imap.host",
      label: "Host",
      value: fieldValue(values, "imap.host", imap?.host ?? ""),
      required: true,
      errors,
    })}</div>
    <div>${textField({
      id: "imap_port",
      name: "imap.port",
      label: "Port",
      type: "number",
      value: fieldValue(values, "imap.port", imap ? String(imap.port) : "993"),
      required: true,
      errors,
    })}</div>
  </div>
  ${textField({
    id: "imap_user",
    name: "imap.user",
    label: "User",
    value: fieldValue(values, "imap.user", imap?.user ?? ""),
    required: true,
    errors,
  })}
  ${passwordField({ id: "imap_pass", name: "imap.pass", label: "Password", required: isNew })}
  ${checkboxField({
    id: "imap_tls",
    name: "imap.tls",
    label: "Use TLS",
    checked: values ? values["imap.tls"] === "1" : (imap?.tls ?? true),
  })}
  </fieldset>

  <fieldset>
  <legend>SMTP</legend>
  <div class="row">
    <div>${textField({
      id: "smtp_host",
      name: "smtp.host",
      label: "Host",
      value: fieldValue(values, "smtp.host", smtp?.host ?? ""),
      required: true,
      errors,
    })}</div>
    <div>${textField({
      id: "smtp_port",
      name: "smtp.port",
      label: "Port",
      type: "number",
      value: fieldValue(values, "smtp.port", smtp ? String(smtp.port) : "465"),
      required: true,
      errors,
    })}</div>
  </div>
  ${textField({
    id: "smtp_user",
    name: "smtp.user",
    label: "User",
    value: fieldValue(values, "smtp.user", smtp?.user ?? ""),
    required: true,
    errors,
  })}
  ${passwordField({ id: "smtp_pass", name: "smtp.pass", label: "Password", required: isNew })}
  ${checkboxField({
    id: "smtp_tls",
    name: "smtp.tls",
    label: "Use TLS",
    checked: values ? values["smtp.tls"] === "1" : (smtp?.tls ?? true),
  })}
  </fieldset>

  <fieldset>
  <legend>Mail defaults</legend>
  ${textField({
    id: "mail_from",
    name: "mail.defaultFrom",
    label: "From address",
    value: fieldValue(values, "mail.defaultFrom", mail?.defaultFrom ?? ""),
    required: true,
    errors,
  })}
  ${textField({
    id: "mail_from_name",
    name: "mail.defaultFromName",
    label: "From name",
    value: fieldValue(values, "mail.defaultFromName", mail?.defaultFromName ?? ""),
    errors,
  })}
  ${textField({
    id: "mail_drafts",
    name: "mail.draftsFolder",
    label: "Drafts folder",
    value: fieldValue(values, "mail.draftsFolder", mail?.draftsFolder ?? "Drafts"),
    errors,
  })}
  ${textField({
    id: "mail_sent",
    name: "mail.sentFolder",
    label: "Sent folder",
    value: fieldValue(values, "mail.sentFolder", mail ? (mail.sentFolder ?? "") : "Sent"),
    errors,
  })}
  </fieldset>

  ${caldavGroup}

  <button type="submit" name="_action" value="save">Save</button>
  <button type="submit" formaction="${escapeHtml(testPath)}" name="_action" value="test">
    Test connection
  </button>
</form>
<p><a href="/settings">Back to settings</a></p>`;

  return page(isNew ? "Add mailbox" : "Edit mailbox", body);
}
