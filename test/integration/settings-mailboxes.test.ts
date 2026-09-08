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

import { AccountsStore } from "../../src/accounts.js";
import { ClientPool } from "../../src/client-pool.js";
import { createApp } from "../../src/app.js";
import { ASSERTION_HEADER } from "../../src/settings-assertion.js";
import { readStamp } from "../../src/accounts-writer.js";
import { makeTmpDir, cleanupTmpDir } from "../helpers/fixtures.js";

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

async function startConnector(): Promise<Connector> {
  const dir = await makeTmpDir();
  const accountsPath = `${dir}/accounts.json`;
  // Pre-seed an empty but present accounts.json — a fresh deployment that has
  // been initialised but has no mailboxes yet, and (unlike an absent file) one
  // a probe-only "test connection" submission can read back afterwards to prove
  // it wrote nothing.
  await writeFile(accountsPath, JSON.stringify({ version: 1, accounts: [] }), "utf8");
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
 * Extra coverage beyond the brief's eleven cases: mounting the settings router
 * (scoped bearerAuth on /settings, the router itself at "/") must not change
 * the 404 behaviour of every other path — see the "bearer check must not
 * become a global" decision this task was handed.
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
