import assert from "node:assert/strict";
import { test } from "node:test";

import { MIN_PASSWORD_LENGTH, validateNewCredentials } from "../../src/operator.js";
import {
  SETTINGS_CSP,
  SETTINGS_HEADERS,
  pageHeaders,
  renderClients,
  renderOverview,
  renderPasswordChange,
  renderSettingsSignIn,
} from "../../src/settings-pages.js";

// These two cases read the constant, which proves only what the constant says.
// That the values reach a browser is the subject of
// test/integration/page-headers.test.ts, and the two are not interchangeable.

test("every page declares the strict content security policy and no framing", () => {
  assert.equal(
    SETTINGS_HEADERS["Content-Security-Policy"],
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'"
  );
  assert.equal(SETTINGS_HEADERS["X-Frame-Options"], "DENY");
  assert.equal(SETTINGS_HEADERS["Cache-Control"], "no-store");
  // Not no-referrer: these pages submit forms whose handlers call isSameOrigin(),
  // and Chrome sends no Origin header on a same-origin form POST. no-referrer
  // removed the only remaining signal and made browser sign-in impossible.
  assert.equal(SETTINGS_HEADERS["Referrer-Policy"], "same-origin");
});

test("pageHeaders varies the CSP and nothing else", () => {
  // The property the consent screen depends on: it passes a wider form-action
  // and must still get the same cache, framing and referrer rules as every
  // other page. A `pageHeaders` that quietly relaxed one of those for a
  // non-default CSP would be invisible to the case above.
  const consent = pageHeaders("default-src 'none'; form-action 'self' https://claude.ai");

  assert.equal(consent["Content-Security-Policy"], "default-src 'none'; form-action 'self' https://claude.ai");
  for (const name of ["Cache-Control", "X-Frame-Options", "Referrer-Policy"]) {
    assert.equal(consent[name], SETTINGS_HEADERS[name], `${name} must not depend on the CSP`);
  }
  assert.deepEqual(Object.keys(consent), Object.keys(SETTINGS_HEADERS));
  assert.deepEqual(pageHeaders(SETTINGS_CSP), SETTINGS_HEADERS);
});

test("no page carries a script tag or an inline handler", () => {
  const pages = [
    renderSettingsSignIn({}),
    renderOverview({
      csrf: "c",
      username: "operator",
      connectorReachable: true,
      connectorVersion: "0.5.0",
      mailboxes: [{ id: "work", label: "Work", isDefault: true }],
      clientCount: 1,
      sessionCount: 1,
      canChangePassword: true,
    }),
    renderClients({ csrf: "c", clients: [], sessions: [] }),
    renderPasswordChange({ csrf: "c" }),
  ];
  for (const page of pages) {
    assert.ok(!/<script/i.test(page), "no script element");
    assert.ok(!/\son[a-z]+\s*=/i.test(page), "no inline event handler");
    assert.ok(!/javascript:/i.test(page), "no javascript: URL");
  }
});

test("state-changing forms carry the CSRF field", () => {
  const page = renderClients({
    csrf: "csrf-value",
    clients: [
      { id: "c1", name: "Claude", issuedAt: 1757000000, redirectHosts: ["claude.ai"], revoked: false },
    ],
    sessions: [{ sid: "s1", clientId: "c1", scope: "mcp", expiresAt: 1757600000 }],
  });
  const forms = page.match(/<form[\s\S]*?<\/form>/g) ?? [];
  assert.ok(forms.length >= 2, "a revoke form per client and per session");
  for (const form of forms) {
    assert.match(form, /name="_csrf" value="csrf-value"/);
    assert.match(form, /method="post"/i);
  }
});

test("client-supplied names are escaped, not interpreted", () => {
  const page = renderClients({
    csrf: "c",
    clients: [
      {
        id: "c1",
        name: '<img src=x onerror="alert(1)">',
        issuedAt: 1757000000,
        redirectHosts: ["claude.ai"],
        revoked: false,
      },
    ],
    sessions: [],
  });
  assert.ok(!page.includes("<img src=x"), "the tag must not survive as markup");
  assert.match(page, /&lt;img src=x/);
});

test("the sign-in page shows an error without echoing it as markup", () => {
  const page = renderSettingsSignIn({ error: "<b>nope</b>" });
  assert.match(page, /&lt;b&gt;nope/);
  assert.ok(!page.includes("<b>nope</b>"));
});

test("the overview says plainly when the connector is unreachable", () => {
  const page = renderOverview({
    csrf: "c",
    username: "operator",
    connectorReachable: false,
    connectorVersion: null,
    mailboxes: [],
    clientCount: 0,
    sessionCount: 0,
    canChangePassword: true,
  });
  assert.match(page, /unreachable/i);
});

test("the password form is rendered disabled with a reason when changes are off", () => {
  const page = renderPasswordChange({ csrf: "c", disabledReason: "OPERATOR_FILE is set to none" });
  assert.match(page, /OPERATOR_FILE is set to none/);
  assert.ok(!/<input[^>]*type="password"[^>]*name="new_password"/.test(page));
});

test("the password form states the minimum rather than repeating the number", () => {
  // The route used to compare against a literal 12 with the figure written out
  // in prose beside it, so raising MIN_PASSWORD_LENGTH would have moved neither.
  const page = renderPasswordChange({ csrf: "c" });
  assert.match(page, new RegExp(`minlength="${MIN_PASSWORD_LENGTH}"`));
  assert.match(page, new RegExp(`At least ${MIN_PASSWORD_LENGTH} characters`));
});

test("each credential problem is rendered next to the field it is about", () => {
  const page = renderPasswordChange({
    csrf: "c",
    problems: validateNewCredentials({
      username: "operator",
      password: "short",
      confirmation: "different",
    }),
  });

  assert.match(page, /new_password[^>]*aria-invalid="true"/);
  assert.match(page, /confirm_password[^>]*aria-invalid="true"/);
  assert.match(page, new RegExp(`Use at least ${MIN_PASSWORD_LENGTH} characters\\.`));
  assert.match(page, /The two passwords do not match\./);
  // The current-password box was not the one at fault and must not be flagged.
  assert.ok(!/current_password[^>]*aria-invalid/.test(page));
});

test("a problem this form has no input for still reaches the operator", () => {
  // The username is fixed on this page, so a username problem can only come
  // from a stored record that itself breaks a rule. Rare is not the same as
  // never, and silently dropping it would leave a 400 with no stated reason.
  const page = renderPasswordChange({
    csrf: "c",
    problems: [{ field: "username", message: "A username cannot contain spaces." }],
  });
  assert.match(page, /class="error" role="alert">A username cannot contain spaces\./);
});

test("a problem message is escaped rather than echoed as markup", () => {
  const page = renderPasswordChange({
    csrf: "c",
    problems: [{ field: "password", message: "<b>no</b>" }],
    error: "<i>also no</i>",
  });
  assert.ok(!page.includes("<b>no</b>"));
  assert.ok(!page.includes("<i>also no</i>"));
  assert.match(page, /&lt;b&gt;no/);
  assert.match(page, /&lt;i&gt;also no/);
});
