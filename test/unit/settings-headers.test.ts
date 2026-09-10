/**
 * The security headers the connector's own settings pages serve, pinned.
 *
 * The set lives once, in shared/page-headers.ts, compiled into both images and
 * re-exported by both packages' settings-pages.ts. It used to live twice, and
 * this file used to carry a second test that pulled the two declarations out of
 * the two files with a regex and compared the extracted text; #126 deleted that
 * along with the second copy. Every copy that could be removed by an import had
 * already been removed (#61), so that pair was the last one.
 *
 * `Referrer-Policy` is the entry that matters most and the one with a history.
 * `no-referrer` here is not a lint-level nit: these pages are served through the
 * OAuth proxy, whose POST handlers verify submissions with `isSameOrigin()`,
 * which reads `Origin` and falls back to `Referer`. Chrome sends no `Origin` on
 * a same-origin form POST, so `no-referrer` leaves that check with neither
 * header — which is exactly what made every browser sign-in impossible in 0.6.0
 * (fixed in 0.6.1, and this copy corrected in 0.6.3).
 *
 * The guarantee, therefore: the values are asserted on a *served response* — a
 * real request through a real Express server — and against literal strings, not
 * against `SETTINGS_HEADERS` itself. A test that loops over the constant passes
 * just as happily when the constant is wrong; the integration suite's existing
 * header check does exactly that, on purpose, since its subject is the wiring
 * rather than the values.
 *
 * Offline like every other unit test: the server binds 127.0.0.1:0 and the
 * accounts store lives in a temp directory.
 */

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
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
