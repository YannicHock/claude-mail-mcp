import assert from "node:assert/strict";
import { test } from "node:test";

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
