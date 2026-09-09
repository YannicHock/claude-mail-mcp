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
`.trim();

/** The shared wizard shell: one heading, one `Step N of 3` line, one body. */
function wizardPage(step: SetupStep, body: string): string {
  const title = STEP_TITLES[step];
  const header = `Step ${stepNumber(step)} of ${SETUP_STEPS.length} · ${title}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(`Set up claude-mail-mcp — ${title}`)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<h1>Set up claude-mail-mcp</h1>
<p class="sub">${escapeHtml(header)}</p>
${body}
</main>
</body>
</html>`;
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

/**
 * A screen that is routed but not yet built — steps 2 and 3, which issues #23
 * and #24 fill in.
 *
 * It exists rather than 404ing because step 1 has to lead somewhere, and because
 * a placeholder that says plainly what is missing is what an operator who gets
 * here needs: their claim token is good, their credential is saved, and the rest
 * of the wizard is not written yet. The manual path out is named, the way the
 * claim-token placeholder named it before this.
 */
export function renderStepPlaceholder(data: { step: SetupStep; backHref: string }): string {
  const body = `
  <div class="notice">
    This screen is not built yet. Everything before it is: your operator account
    is saved, and this link keeps working across restarts until setup completes.
  </div>
  <p>
    Until the remaining screens land, add a mailbox and connect Claude the
    documented way, from the settings UI, once this instance is claimed.
  </p>
  <div class="actions"><a href="${escapeHtml(data.backHref)}">← Back</a><span></span></div>`;

  return wizardPage(data.step, body);
}
