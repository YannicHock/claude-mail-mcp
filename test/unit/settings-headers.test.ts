/**
 * The security headers the connector's own settings pages serve, pinned.
 *
 * `SETTINGS_HEADERS` lives twice — once here in src/settings-pages.ts and once in
 * oauth/src/settings-pages.ts — because the two packages have separate Docker
 * build contexts and cannot share a module. The OAuth layer's copy has been
 * pinned by a header matrix since #14; this copy was pinned by nothing but a
 * comment saying "change one, change both".
 *
 * `Referrer-Policy` is the entry that matters most and the one with a history.
 * `no-referrer` here is not a lint-level nit: these pages are served through the
 * OAuth proxy, whose POST handlers verify submissions with `isSameOrigin()`,
 * which reads `Origin` and falls back to `Referer`. Chrome sends no `Origin` on
 * a same-origin form POST, so `no-referrer` leaves that check with neither
 * header — which is exactly what made every browser sign-in impossible in 0.6.0
 * (fixed in 0.6.1, and this copy corrected in 0.6.3).
 *
 * Two guarantees, therefore:
 *
 *  1. The values are asserted on a *served response* — a real request through a
 *     real Express server — and against literal strings, not against
 *     `SETTINGS_HEADERS` itself. A test that loops over the constant passes just
 *     as happily when the constant is wrong; the integration suite's existing
 *     header check does exactly that, on purpose, since its subject is the
 *     wiring rather than the values.
 *  2. The two copies of the constant are compared directly, so "byte-for-byte
 *     identical" stops being a claim in a comment. Same shape as the drift test
 *     over the two copies of secrets.ts in secrets.test.ts.
 *
 * Offline like every other unit test: the server binds 127.0.0.1:0 and the
 * accounts store lives in a temp directory.
 */

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import express from "express";

import { createSettingsRouter } from "../../src/settings-routes.js";
import { ASSERTION_HEADER } from "../../src/settings-assertion.js";
import { makeAccount, withAccountsStore } from "../helpers/fixtures.js";

const ISSUER = "https://mail-mcp.example.invalid";
const SETTINGS_KEY = "s".repeat(32);

/**
 * What a settings response must carry on the wire, written out as literals.
 *
 * Deliberately not derived from `SETTINGS_HEADERS`: this is the second opinion
 * that catches a change to the constant, and it only works while it is spelled
 * out independently.
 */
const EXPECTED_HEADERS = {
  "cache-control": "no-store",
  "x-frame-options": "DENY",
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
  "referrer-policy": "same-origin",
};

/** Mint an assertion the way the OAuth layer would, for `method`/`path`. */
function mint(method: string, path: string): string {
  const payload = {
    v: 1,
    iss: ISSUER,
    aud: "mail-mcp-settings",
    sub: "operator",
    sid: "session-1",
    csrf: "csrf-1",
    htm: method.toUpperCase(),
    htu: path,
    exp: Math.floor(Date.now() / 1000) + 30,
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const mac = createHmac("sha256", Buffer.from(SETTINGS_KEY, "utf8"))
    .update(encoded)
    .digest("base64url");
  return `${encoded}.${mac}`;
}

/**
 * GET `path` off the settings router, mounted at `/` as
 * {@link requireSettingsAssertion} requires, over one mailbox.
 *
 * The server is closed in a `finally` opened before the caller's assertions run:
 * a failing assertion would otherwise leave a listening socket behind and
 * `node --test` hangs instead of reporting the failure.
 */
async function getSettings(path: string): Promise<Response> {
  return withAccountsStore([makeAccount({ id: "work", label: "Work", default: true })], async (store) => {
    const app = express();
    app.use(
      createSettingsRouter({
        store,
        issuer: ISSUER,
        settingsKey: SETTINGS_KEY,
        log: () => {},
      })
    );
    const server = await new Promise<Server>((resolve, reject) => {
      const s: Server = app.listen(0, "127.0.0.1", () => resolve(s));
      s.on("error", reject);
    });
    try {
      const { port } = server.address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        headers: { [ASSERTION_HEADER]: mint("GET", path) },
      });
      // Drain the body so the socket does not keep the server from closing.
      await res.text();
      return res;
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
}

test("a settings page serves Referrer-Policy: same-origin, never no-referrer", async () => {
  // The single assertion this whole file exists for. `no-referrer` costs the
  // OAuth layer's isSameOrigin() its only remaining signal on a Chrome form POST.
  const res = await getSettings("/settings/mailboxes");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("referrer-policy"), "same-origin");
});

test("a settings page serves the whole no-store/CSP/frame/referrer set", async () => {
  const res = await getSettings("/settings/mailboxes");
  assert.equal(res.status, 200);
  for (const [name, value] of Object.entries(EXPECTED_HEADERS)) {
    assert.equal(res.headers.get(name), value, `expected ${name} on the mailbox list page`);
  }
});

test("the mailbox form serves the same set", async () => {
  // The page that actually carries a password field, so its headers are the ones
  // a cache or a frame would hurt most.
  const res = await getSettings("/settings/mailboxes/new");
  assert.equal(res.status, 200);
  for (const [name, value] of Object.entries(EXPECTED_HEADERS)) {
    assert.equal(res.headers.get(name), value, `expected ${name} on the mailbox form`);
  }
});

test("a plain-text settings response carries them too", async () => {
  // sendPlain() is a second, separate call site in settings-routes.ts — the 404s
  // and the 403 a failed CSRF check produces all go through it.
  const res = await getSettings("/settings/mailboxes/no-such-mailbox");
  assert.equal(res.status, 404);
  for (const [name, value] of Object.entries(EXPECTED_HEADERS)) {
    assert.equal(res.headers.get(name), value, `expected ${name} on a plain-text response`);
  }
});

test("the two copies of SETTINGS_HEADERS are identical", () => {
  // Nothing in the build stops this copy and the OAuth layer's from drifting,
  // and both are served on pages of the same browser session: a header the two
  // disagree about is a header whose effect depends on which service answered.
  const literal = (url: URL): string => {
    const source = readFileSync(url, "utf8")
      // Line endings first — on a CRLF checkout every regex below would
      // otherwise be matching against `\r\n` and the comparison fails on
      // whitespace rather than on drift.
      .replace(/\r\n/g, "\n");
    const match = /export const SETTINGS_HEADERS: Record<string, string> = \{[\s\S]*?\n\};/.exec(
      source
    );
    assert.ok(match, `no SETTINGS_HEADERS literal found in ${url.pathname}`);
    // The comments inside differ on purpose: each one explains the rule in the
    // terms of its own package. The header values are what must match.
    return match[0].replace(/^[ \t]*\/\/.*\n/gm, "");
  };

  assert.equal(
    literal(new URL("../../src/settings-pages.ts", import.meta.url)),
    literal(new URL("../../oauth/src/settings-pages.ts", import.meta.url)),
    "SETTINGS_HEADERS in src/settings-pages.ts and oauth/src/settings-pages.ts have drifted — change one, change the other"
  );
});
