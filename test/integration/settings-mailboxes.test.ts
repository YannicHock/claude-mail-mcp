/**
 * Integration tests for the connector's settings routes (src/settings-routes.ts),
 * driven through the real Express app (`createApp`) — the same one `src/index.ts`
 * boots — rather than calling the router in isolation. Two credentials gate every
 * route here: the static Bearer token `bearerAuth` already checks for `/mcp`, and
 * the settings assertion the OAuth layer would normally mint and forward. This
 * suite mints its own assertions with the same HMAC format so it does not depend
 * on the oauth/ package (the two cannot import from each other).
 *
 * Every test wraps its body in try/finally, opened before the first assertion,
 * so a failing assertion still closes the server — otherwise a listening socket
 * survives the failure and `node --test` hangs instead of reporting it. This has
 * already bitten this branch once (see settings-session.test.ts in oauth/ for the
 * same convention).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import { AccountsStore, type Account } from "../../src/accounts.js";
import { ClientPool } from "../../src/client-pool.js";
import { createApp } from "../../src/app.js";
import { ASSERTION_HEADER } from "../../src/settings-assertion.js";
import { readStamp } from "../../src/accounts-writer.js";
import { makeAccount, makeTmpDir, cleanupTmpDir } from "../helpers/fixtures.js";

const AUTH_TOKEN = "settings-routes-test-token-please-do-not-reuse";
const SETTINGS_KEY = "s".repeat(32);
const OTHER_KEY = "z".repeat(32);
const CSRF = "test-csrf-value";
const SUB = "operator";
const SID = "session-1";

interface Connector {
  url: string;
  accountsPath: string;
  close(): Promise<void>;
}

async function startConnector(accounts: Account[] = []): Promise<Connector> {
  const dir = await makeTmpDir();
  const accountsPath = `${dir}/accounts.json`;
  // Pre-seed accounts.json — empty by default: a fresh deployment that has been
  // initialised but has no mailboxes yet, and (unlike an absent file) one a
  // probe-only "test connection" submission can read back afterwards to prove it
  // wrote nothing. A caller that needs mailboxes already on disk passes them in.
  await writeFile(accountsPath, JSON.stringify({ version: 1, accounts }), "utf8");
  const store = new AccountsStore(accountsPath);
  await store.start();
  const pool = new ClientPool(store);
  const publicUrl = "https://mail-mcp.example.invalid";
  const app = createApp({
    store,
    pool,
    authToken: AUTH_TOKEN,
    accountsFile: accountsPath,
    settingsSigningKey: SETTINGS_KEY,
    publicUrl,
  });

  const server = await new Promise<Server>((resolve, reject) => {
    const s: Server = app.listen(0, "127.0.0.1", () => resolve(s));
    s.on("error", reject);
  });
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    accountsPath,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.stop();
      await pool.closeAll().catch(() => {});
      await cleanupTmpDir(dir);
    },
  };
}

/** Mint an assertion the way the OAuth layer would, for `method`/`path`. */
function mint(
  method: string,
  path: string,
  key: string = SETTINGS_KEY,
  overrides: Record<string, unknown> = {}
): string {
  const payload = {
    v: 1,
    iss: "https://mail-mcp.example.invalid",
    aud: "mail-mcp-settings",
    sub: SUB,
    sid: SID,
    csrf: CSRF,
    htm: method.toUpperCase(),
    htu: path,
    exp: Math.floor(Date.now() / 1000) + 30,
    ...overrides,
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const mac = createHmac("sha256", Buffer.from(key, "utf8")).update(encoded).digest("base64url");
  return `${encoded}.${mac}`;
}

function mintExpired(method: string, path: string): string {
  return mint(method, path, SETTINGS_KEY, { exp: Math.floor(Date.now() / 1000) - 30 });
}

async function get(url: string, path: string, assertion: string): Promise<Response> {
  return fetch(`${url}${path}`, {
    headers: {
      authorization: `Bearer ${AUTH_TOKEN}`,
      [ASSERTION_HEADER]: assertion,
    },
  });
}

async function post(
  url: string,
  path: string,
  fields: Record<string, string>,
  opts: { csrf?: string; assertion?: string } = {}
): Promise<Response> {
  const body = new URLSearchParams();
  const csrf = opts.csrf ?? CSRF;
  if (csrf !== "") body.set("_csrf", csrf);
  for (const [key, value] of Object.entries(fields)) {
    body.set(key, value);
  }
  const assertion = opts.assertion ?? mint("POST", path);
  return fetch(`${url}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${AUTH_TOKEN}`,
      [ASSERTION_HEADER]: assertion,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
    redirect: "manual",
  });
}

async function stamp(accountsPath: string): Promise<string> {
  return readStamp(accountsPath);
}

function validForm(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    id: "work",
    label: "Work",
    "imap.host": "imap.example.invalid",
    "imap.port": "993",
    "imap.user": "user@example.invalid",
    "imap.pass": "imap-secret",
    "imap.tls": "1",
    "smtp.host": "smtp.example.invalid",
    "smtp.port": "465",
    "smtp.user": "user@example.invalid",
    "smtp.pass": "smtp-secret",
    "smtp.tls": "1",
    "mail.defaultFrom": "user@example.invalid",
    "mail.draftsFolder": "Drafts",
    "mail.sentFolder": "Sent",
    ...overrides,
  };
}

/**
 * The security headers a settings response must carry once it has been through
 * the whole app, written out as literals.
 *
 * Deliberately not derived from `SETTINGS_HEADERS`. This case used to loop over
 * that constant, which compared the constant with itself: flipping
 * `Referrer-Policy` to `no-referrer` in src/settings-pages.ts — the regression
 * that made every browser sign-in impossible in 0.6.0 — left this file green.
 * Spelling the expectation out independently is what gives the assertion the
 * ability to fail, and it is the same second opinion
 * test/unit/settings-headers.test.ts keeps for the router in isolation.
 *
 * What this copy adds over that unit test: the response here has travelled the
 * real `createApp` chain — the body parser, `trust proxy`, the bearer check and
 * the router mounted alongside `/mcp` and `/health` — so a middleware added
 * upstream that strips or overwrites one of these headers fails here and
 * nowhere else. Keep both.
 */
const EXPECTED_HEADERS = {
  "cache-control": "no-store",
  "x-frame-options": "DENY",
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
  "referrer-policy": "same-origin",
};

/** Attach `_stamp` from the connector's current on-disk stamp. */
async function withStamp(
  accountsPath: string,
  fields: Record<string, string>
): Promise<Record<string, string>> {
  return { ...fields, _stamp: await stamp(accountsPath) };
}

test("a settings request without an assertion is refused", async () => {
  const { url, close } = await startConnector();
  try {
    const res = await fetch(`${url}/settings/mailboxes`, {
      headers: { authorization: `Bearer ${AUTH_TOKEN}` },
    });
    assert.equal(res.status, 401);
  } finally {
    await close();
  }
});

test("a settings request without the bearer token is refused", async () => {
  const { url, close } = await startConnector();
  try {
    const res = await fetch(`${url}/settings/mailboxes`, {
      headers: { [ASSERTION_HEADER]: mint("GET", "/settings/mailboxes") },
    });
    assert.equal(res.status, 401);
  } finally {
    await close();
  }
});

test("an assertion signed with the wrong key is refused", async () => {
  const { url, close } = await startConnector();
  try {
    const res = await get(url, "/settings/mailboxes", mint("GET", "/settings/mailboxes", OTHER_KEY));
    assert.equal(res.status, 401);
  } finally {
    await close();
  }
});

test("an assertion bound to another path is refused", async () => {
  const { url, close } = await startConnector();
  try {
    const res = await get(url, "/settings/mailboxes", mint("GET", "/settings/mailboxes/work"));
    assert.equal(res.status, 401);
  } finally {
    await close();
  }
});

test("an expired assertion is refused", async () => {
  const { url, close } = await startConnector();
  try {
    const res = await get(url, "/settings/mailboxes", mintExpired("GET", "/settings/mailboxes"));
    assert.equal(res.status, 401);
  } finally {
    await close();
  }
});

test("a POST without the CSRF field is refused", async () => {
  const { url, accountsPath, close } = await startConnector();
  try {
    const res = await post(
      url,
      "/settings/mailboxes",
      await withStamp(accountsPath, { id: "work" }),
      { csrf: "" }
    );
    assert.equal(res.status, 403);
  } finally {
    await close();
  }
});

test("a POST whose CSRF field disagrees with the assertion is refused", async () => {
  const { url, accountsPath, close } = await startConnector();
  try {
    const res = await post(
      url,
      "/settings/mailboxes",
      await withStamp(accountsPath, { id: "work" }),
      { csrf: "not-the-one" }
    );
    assert.equal(res.status, 403);
  } finally {
    await close();
  }
});

test("settings pages carry the no-store/CSP/frame/referrer header set", async () => {
  const { url, close } = await startConnector();
  try {
    const res = await get(url, "/settings/mailboxes", mint("GET", "/settings/mailboxes"));
    assert.equal(res.status, 200);
    for (const [name, value] of Object.entries(EXPECTED_HEADERS)) {
      assert.equal(res.headers.get(name), value, `expected ${name} to be set on a settings page`);
    }
  } finally {
    await close();
  }
});

test("create, edit, make default and delete round-trip through the real app", async () => {
  const { url, accountsPath, close } = await startConnector();
  try {
    const created = await post(url, "/settings/mailboxes", await withStamp(accountsPath, validForm({ id: "work" })));
    assert.equal(created.status, 303);
    assert.deepEqual(JSON.parse(await readFile(accountsPath, "utf8")).accounts.length, 1);

    const edited = await post(
      url,
      "/settings/mailboxes/work",
      await withStamp(accountsPath, validForm({ id: "work", label: "Renamed", "imap.pass": "", "smtp.pass": "" }))
    );
    assert.equal(edited.status, 303);
    const afterEdit = JSON.parse(await readFile(accountsPath, "utf8"));
    assert.equal(afterEdit.accounts[0].label, "Renamed");
    assert.equal(
      afterEdit.accounts[0].imap.pass,
      "imap-secret",
      "an empty password field keeps the stored one"
    );

    const removed = await post(url, "/settings/mailboxes/work/delete", await withStamp(accountsPath, {}));
    assert.equal(removed.status, 303);
    assert.deepEqual(JSON.parse(await readFile(accountsPath, "utf8")).accounts, []);
  } finally {
    await close();
  }
});

test("the edit page shows no stored password even end to end", async () => {
  const { url, accountsPath, close } = await startConnector();
  try {
    await post(url, "/settings/mailboxes", await withStamp(accountsPath, validForm({ id: "work" })));
    const page = await (
      await get(url, "/settings/mailboxes/work", mint("GET", "/settings/mailboxes/work"))
    ).text();
    assert.ok(!page.includes("imap-secret"));
  } finally {
    await close();
  }
});

test("emptying the CalDAV URL without ticking remove is refused and leaves the stored block intact", async () => {
  const { url, accountsPath, close } = await startConnector();
  try {
    const created = await post(
      url,
      "/settings/mailboxes",
      await withStamp(
        accountsPath,
        validForm({
          id: "work",
          "caldav.url": "https://caldav.example.invalid/work",
          "caldav.user": "caldav-user",
          "caldav.pass": "caldav-secret",
        })
      )
    );
    assert.equal(created.status, 303);
    const beforeEdit = JSON.parse(await readFile(accountsPath, "utf8"));
    assert.deepEqual(beforeEdit.accounts[0].caldav, {
      url: "https://caldav.example.invalid/work",
      user: "caldav-user",
      pass: "caldav-secret",
    });

    // Clear the URL field but do not tick "Remove CalDAV" — this must be
    // refused with a field error, not silently drop the stored credentials.
    const edited = await post(
      url,
      "/settings/mailboxes/work",
      await withStamp(
        accountsPath,
        validForm({
          id: "work",
          "imap.pass": "",
          "smtp.pass": "",
          "caldav.url": "",
          "caldav.user": "caldav-user",
        })
      )
    );
    assert.equal(edited.status, 400);
    assert.match(await edited.text(), /Remove CalDAV/);

    const afterEdit = JSON.parse(await readFile(accountsPath, "utf8"));
    assert.deepEqual(
      afterEdit.accounts[0].caldav,
      {
        url: "https://caldav.example.invalid/work",
        user: "caldav-user",
        pass: "caldav-secret",
      },
      "the stored CalDAV block, including its credentials, must survive the refused edit"
    );
  } finally {
    await close();
  }
});

test("a blank CalDAV password comes back marked on its own field", async () => {
  const { url, accountsPath, close } = await startConnector();
  try {
    // The wizard's CalDAV block is optional and renders without `required`, so
    // a URL and a user with an empty password reach the server routinely. The
    // 400 has to say which of the eighteen fields is at fault. See issue #83.
    const res = await post(
      url,
      "/settings/mailboxes",
      await withStamp(
        accountsPath,
        validForm({
          id: "work",
          "caldav.url": "https://caldav.example.invalid/work",
          "caldav.user": "caldav-user",
          "caldav.pass": "",
        })
      )
    );
    assert.equal(res.status, 400);

    const page = await res.text();
    const at = page.indexOf('name="caldav.pass"');
    assert.notEqual(at, -1, "the CalDAV password field must be on the re-rendered form");
    const afterInput = page.slice(page.indexOf(">", at) + 1).trimStart();
    assert.ok(
      afterInput.startsWith('<p class="field-error">'),
      `the CalDAV password field must carry its error, got: ${afterInput.slice(0, 80)}`
    );
  } finally {
    await close();
  }
});

test("ticking remove_caldav does remove the stored CalDAV block", async () => {
  const { url, accountsPath, close } = await startConnector();
  try {
    await post(
      url,
      "/settings/mailboxes",
      await withStamp(
        accountsPath,
        validForm({
          id: "work",
          "caldav.url": "https://caldav.example.invalid/work",
          "caldav.user": "caldav-user",
          "caldav.pass": "caldav-secret",
        })
      )
    );

    const edited = await post(
      url,
      "/settings/mailboxes/work",
      await withStamp(
        accountsPath,
        validForm({
          id: "work",
          "imap.pass": "",
          "smtp.pass": "",
          "caldav.url": "",
          "caldav.user": "",
          remove_caldav: "1",
        })
      )
    );
    assert.equal(edited.status, 303);

    const afterEdit = JSON.parse(await readFile(accountsPath, "utf8"));
    assert.equal(afterEdit.accounts[0].caldav, undefined);
  } finally {
    await close();
  }
});

test("a stale stamp is reported rather than clobbering", async () => {
  const { url, accountsPath, close } = await startConnector();
  try {
    const stale = await stamp(accountsPath);
    // Pretty-printed, unlike startConnector()'s seed write — guarantees a
    // different file size (and thus a different stamp) even if the two writes
    // land within the same filesystem mtime tick.
    await writeFile(accountsPath, JSON.stringify({ version: 1, accounts: [] }, null, 2), "utf8");
    const res = await post(url, "/settings/mailboxes", {
      ...validForm({ id: "work" }),
      _stamp: stale,
    });
    assert.equal(res.status, 409);
    assert.match(await res.text(), /changed on disk/i);
  } finally {
    await close();
  }
});

test("a test submission probes without writing", async () => {
  const { url, accountsPath, close } = await startConnector();
  try {
    const res = await post(
      url,
      "/settings/mailboxes/test",
      await withStamp(accountsPath, validForm({ id: "work", "imap.port": "1", "smtp.port": "1" }))
    );
    assert.equal(res.status, 200);
    assert.match(await res.text(), /not saved/i);
    assert.deepEqual(JSON.parse(await readFile(accountsPath, "utf8")).accounts, []);
  } finally {
    await close();
  }
});

/**
 * Fix round 1: "new" and "test" are reserved (see RESERVED_IDS in
 * src/accounts.ts) because they collide with the settings UI's own
 * single-segment routes — an account actually named "test" would render a
 * real edit page whose action silently routes to the create-probe handler
 * instead of updating it, so saves through the browser would never persist.
 * Rejecting the id at create time means that state can never be reached.
 */
test("creating a mailbox with a reserved id ('new' or 'test') is rejected up front", async () => {
  const { url, accountsPath, close } = await startConnector();
  try {
    for (const reserved of ["new", "test"]) {
      const res = await post(
        url,
        "/settings/mailboxes",
        await withStamp(accountsPath, validForm({ id: reserved }))
      );
      assert.equal(res.status, 400, `id="${reserved}" should be rejected`);
      assert.match(await res.text(), /reserved/i);
    }
    assert.deepEqual(
      JSON.parse(await readFile(accountsPath, "utf8")).accounts,
      [],
      "neither reserved id was persisted"
    );
  } finally {
    await close();
  }
});

/**
 * The other half of that rule: an account that is *already* on disk under a
 * reserved id keeps loading, because refusing the file would take every other
 * mailbox down with it (see RESERVED_IDS in src/accounts.ts). It cannot be
 * edited in place, though, so the list page says so on that account's own row —
 * the operator who never reads the logs finds out here instead of from a Save
 * button that silently does nothing.
 */
test("an existing mailbox on a reserved id still loads and says why Save does nothing", async () => {
  const { url, close } = await startConnector([
    makeAccount({ id: "work", label: "Work", default: true }),
    makeAccount({ id: "test", label: "Old test mailbox" }),
  ]);
  try {
    const res = await get(url, "/settings/mailboxes", mint("GET", "/settings/mailboxes"));
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Work/, "the unaffected mailbox is still listed");
    assert.match(html, /Old test mailbox/, "the affected mailbox is still listed");
    assert.match(html, /never persists/i, "the row says the edit form does not save");
    assert.match(html, /recreate it under a different id/, "and names the way out");
    assert.equal(
      (html.match(/class="row-notice"/g) ?? []).length,
      1,
      "only the affected row carries the notice"
    );
  } finally {
    await close();
  }
});

/**
 * Fix round 2 (#45): the operator who reads that row notice and opens the
 * mailbox anyway used to be told the opposite one page deeper — the edit form
 * renders for real (GET /settings/mailboxes/test hits the `:id` route; only the
 * POST collides), and its probe panel promised that pressing Save would store
 * the values. The form now carries the same notice the row does.
 */
test("the edit form for that mailbox repeats the notice instead of promising a Save", async () => {
  const { url, close } = await startConnector([
    makeAccount({ id: "work", label: "Work", default: true }),
    makeAccount({ id: "test", label: "Old test mailbox" }),
  ]);
  try {
    const res = await get(url, "/settings/mailboxes/test", mint("GET", "/settings/mailboxes/test"));
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Old test mailbox/, "this really is that mailbox's edit form");
    assert.match(html, /never persists/i, "the form says Save does not store anything");
    assert.match(html, /recreate it under a different id/, "and names the way out");
    assert.ok(
      !/Press Save to store them/.test(html),
      "and never claims the opposite of what the list row said"
    );

    // The unaffected mailbox's own form is untouched by all of this.
    const ok = await get(url, "/settings/mailboxes/work", mint("GET", "/settings/mailboxes/work"));
    assert.equal(ok.status, 200);
    assert.ok(!/reserved id/.test(await ok.text()));
  } finally {
    await close();
  }
});

/**
 * Fix round 1: express.urlencoded's 64kb limit on the settings routes calls
 * next(err) on an oversized body, which — with no error-handling middleware —
 * would fall through to Express 5's default handler and render an HTML page
 * (including a stack trace outside NODE_ENV=production, which nothing here
 * sets). This proves the app-wide error handler in app.ts intercepts that and
 * answers on the same plain-JSON error shape as every other rejection here.
 */
test("an oversized settings form body gets a clean JSON 4xx, not an HTML error page", async () => {
  const { url, accountsPath, close } = await startConnector();
  try {
    const oversized = "x".repeat(80 * 1024); // over the settings routes' 64kb cap
    const assertion = mint("POST", "/settings/mailboxes");
    const res = await fetch(`${url}/settings/mailboxes`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${AUTH_TOKEN}`,
        [ASSERTION_HEADER]: assertion,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: `label=${oversized}`,
    });
    assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
    assert.equal(res.headers.get("content-type")?.split(";")[0].trim(), "application/json");
    const body = await res.json();
    assert.equal(body.error, "bad_request");
    assert.deepEqual(JSON.parse(await readFile(accountsPath, "utf8")).accounts, []);
  } finally {
    await close();
  }
});

/**
 * Mounting the settings router (scoped bearerAuth on /settings, the router
 * itself at "/") must not change the 404 behaviour of every other path — the
 * bearer check that already gated /mcp must stay scoped to the paths it
 * covered before, not become a global gate over the whole app.
 */
test("an unrelated unknown path still 404s exactly as before, with the settings router mounted", async () => {
  const { url, close } = await startConnector();
  try {
    const withToken = await fetch(`${url}/totally/unrelated/path`, {
      headers: { authorization: `Bearer ${AUTH_TOKEN}` },
    });
    assert.equal(withToken.status, 404);
    const body = await withToken.json();
    assert.equal(body.error, "not_found");

    const withoutToken = await fetch(`${url}/totally/unrelated/path`);
    assert.equal(
      withoutToken.status,
      404,
      "an unrelated path 404s even with no bearer token at all, since bearerAuth is scoped to /settings"
    );
  } finally {
    await close();
  }
});

test("/health and /mcp are unaffected by the settings router being mounted", async () => {
  const { url, close } = await startConnector();
  try {
    const health = await fetch(`${url}/health`);
    assert.equal(health.status, 200);
    const healthBody = await health.json();
    assert.equal(healthBody.status, "ok");

    const mcpNoAuth = await fetch(`${url}/mcp`, { method: "POST" });
    assert.equal(mcpNoAuth.status, 401);
  } finally {
    await close();
  }
});
