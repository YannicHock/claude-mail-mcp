/**
 * The connector's mailbox pages, as the setup wizard sees them.
 *
 * Step 2 asks the connector to probe and to store a mailbox over HTTP, and the
 * connector answers those routes in HTML — it has no JSON form of them. The
 * readers in `src/setup-routes.ts` are written against that markup, so the tests
 * have to feed them the real thing rather than something shaped roughly like it.
 *
 * **Copied verbatim from `probeRowHtml`, `textField` and `renderMailboxForm` in
 * the connector's `src/settings-pages.ts`.** The two packages have separate
 * Docker build contexts and cannot share a module, the same reason
 * `oauth/src/assertion.ts` and `src/settings-assertion.ts` mirror one format in
 * two places. If the connector's markup changes, change this file and the
 * readers in the same commit; these tests are what will notice.
 */

export type StubProbeResult = { ok: true } | { ok: false; message: string };

export interface StubProbeReport {
  imap: StubProbeResult;
  smtp: StubProbeResult;
  /** Omitted entirely by the connector when no CalDAV URL was submitted. */
  caldav?: StubProbeResult;
}

/** `escapeHtml` in src/settings-pages.ts, which both packages define identically. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** `probeRowHtml()`. */
function probeRow(name: string, result: StubProbeResult): string {
  const status = result.ok ? "ok" : `failed: ${escapeHtml(result.message)}`;
  return `<div class="probe-row ${result.ok ? "ok" : "fail"}"><strong>${escapeHtml(
    name
  )}</strong><span>${status}</span></div>`;
}

/** `probeSectionHtml()`. */
function probeSection(probe: StubProbeReport | undefined): string {
  if (probe === undefined) return "";
  const rows = [
    probeRow("IMAP", probe.imap),
    probeRow("SMTP", probe.smtp),
    probe.caldav ? probeRow("CalDAV", probe.caldav) : "",
  ]
    .filter(Boolean)
    .join("\n");
  return `<div class="notice">
${rows}
<p>These values were not saved. Press Save to store them.</p>
</div>`;
}

/** `textField()`: the input, then the field's own error line. */
function textField(name: string, value: string, errors: Record<string, string>): string {
  const message = errors[name];
  return `<label for="${escapeHtml(name)}">${escapeHtml(name)}</label>
<input id="${escapeHtml(name)}" name="${escapeHtml(name)}" type="text" value="${escapeHtml(
    value
  )}" required>
${message ? `<p class="field-error">${escapeHtml(message)}</p>` : ""}`;
}

export interface StubFormOptions {
  /** What `AccountsStore.stamp()` reported when the page was rendered. */
  stamp?: string;
  probe?: StubProbeReport;
  /** Per-field rejections from `parseAccountForm`, keyed by field name. */
  errors?: Record<string, string>;
}

/**
 * `renderMailboxForm()` for a new account, trimmed to the parts the wizard
 * reads: the stamp, the probe panel and the per-field errors.
 */
export function mailboxFormPage(opts: StubFormOptions = {}): string {
  const errors = opts.errors ?? {};
  const fields = ["id", "label", "imap.host", "imap.port", "imap.user", "smtp.host"]
    .map((name) => textField(name, "", errors))
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Add mailbox</title></head>
<body>
<main>
<h1>Add mailbox</h1>
${probeSection(opts.probe)}
<form method="post" action="/settings/mailboxes" autocomplete="off">
  <input type="hidden" name="_csrf" value="a-csrf-token">
  <input type="hidden" name="_stamp" value="${escapeHtml(opts.stamp ?? "absent")}">
${fields}
  <button type="submit" name="_action" value="save">Save</button>
</form>
</main>
</body>
</html>`;
}
