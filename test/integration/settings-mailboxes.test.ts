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
import { MAIL_PROVIDERS } from "../../src/providers.js";
import {
  CHECKBOX_ON,
  draftFromFields,
  MAILBOX_FIELDS,
  parseCreatedAnswer,
  parseErrorAnswer,
  parseProbeAnswer,
  parseProvidersAnswer,
  SAVE_ANYWAY_FIELD,
  type MailboxDraft,
  type MailboxProbeReport,
} from "../../shared/settings-api.js";
import { startRejectingImapServer } from "../helpers/fake-imap.js";
import { readStamp } from "../../src/accounts-writer.js";
import { makeAccount, makeTmpDir, cleanupTmpDir } from "../helpers/fixtures.js";

const AUTH_TOKEN = "settings-routes-test-token-please-do-not-reuse";
const SETTINGS_KEY = "s".repeat(32);
const OTHER_KEY = "z".repeat(32);
const CSRF = "test-csrf-value";
const SUB = "operator";
const SID = "session-1";

/**
 * The canonical spelling of this connector's `PUBLIC_URL` — what the OAuth layer
 * puts in every assertion's `iss`, because its own config canonicalises before
 * minting. The connector is configured with this by default; the two cases below
 * hand `startConnector` a different *spelling* of the same URL, which is the
 * whole of #110.
 */
const PUBLIC_URL = "https://mail-mcp.example.invalid";

interface Connector {
  url: string;
  accountsPath: string;
  close(): Promise<void>;
}

async function startConnector(
  accounts: Account[] = [],
  publicUrlAsConfigured: string = PUBLIC_URL
): Promise<Connector> {
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
  const app = createApp({
    store,
    pool,
    authToken: AUTH_TOKEN,
    accountsFile: accountsPath,
    settingsSigningKey: SETTINGS_KEY,
    publicUrl: publicUrlAsConfigured,
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
    iss: PUBLIC_URL,
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

/** A literal, escaped so it can be dropped into a RegExp without meaning anything. */
function escapeRe(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Attach `_stamp` from the connector's current on-disk stamp, and the *Save
 * anyway* override.
 *
 * The override is here rather than at every call site because of what these
 * hosts are: `imap.example.invalid` and its siblings are guaranteed not to
 * resolve, and since #147 both write routes probe before they write. Every
 * case below that is about the write — the round trip, the CalDAV block, the
 * stale stamp, the shared password — would otherwise be refused by a probe it
 * is not about, and would be asserting the gate over and over instead of the
 * thing it was written for.
 *
 * So they say what an operator says by pressing the second button: store this
 * without testing it. The gate itself has a file of its own,
 * settings-save-probe.test.ts, which has real servers to point at.
 */
async function withStamp(
  accountsPath: string,
  fields: Record<string, string>
): Promise<Record<string, string>> {
  return { ...fields, _stamp: await stamp(accountsPath), [SAVE_ANYWAY_FIELD]: CHECKBOX_ON };
}

/** The same, for a case that wants the probe to run. */
async function withStampProbed(
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

/**
 * #110, end to end and from the operator's side.
 *
 * Both services hold their own `PUBLIC_URL` — `.env` here, `.env.oauth` there —
 * and the OAuth layer canonicalises its copy before minting, so `iss` always
 * arrives in the canonical spelling. What used to break was the *other* side:
 * whatever the operator typed into `.env` went to the comparison verbatim, so a
 * capital letter in the host or an explicit `:443` — spellings identical to every
 * browser and every resolver — made `payload.iss !== issuer` hold and answered
 * 401 to every settings request, with only a `rejected settings request` line to
 * show for it.
 *
 * These two cases fail against the old `.trim().replace(/\/+$/, "")`: they mint
 * the canonical `iss` and configure the connector with a different spelling. The
 * comparison itself is untouched and still strict — it is the configured value
 * that is now canonicalised before it becomes the operand.
 */
test("a PUBLIC_URL whose host is spelled with capitals still verifies", async () => {
  const { url, close } = await startConnector([], "https://Mail-MCP.Example.invalid");
  try {
    const res = await get(url, "/settings/mailboxes", mint("GET", "/settings/mailboxes"));
    assert.equal(res.status, 200);
  } finally {
    await close();
  }
});

test("a PUBLIC_URL carrying an explicit default port still verifies", async () => {
  const { url, close } = await startConnector([], "https://mail-mcp.example.invalid:443/");
  try {
    const res = await get(url, "/settings/mailboxes", mint("GET", "/settings/mailboxes"));
    assert.equal(res.status, 200);
  } finally {
    await close();
  }
});

test("a PUBLIC_URL naming a different host is still refused", async () => {
  // The fix canonicalises; it does not make the comparison lenient. A wrong host
  // is a wrong issuer, exactly as before.
  const { url, close } = await startConnector([], "https://other.example.invalid");
  try {
    const res = await get(url, "/settings/mailboxes", mint("GET", "/settings/mailboxes"));
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
      // See `withStamp`: this case is about the stamp, not about the probe.
      [SAVE_ANYWAY_FIELD]: CHECKBOX_ON,
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
    const res = await oversizedPost(url, "application/x-www-form-urlencoded");
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
 * #137. The same route, the same handler, two content types — and, until this
 * pair of tests existed, two limits eighty times apart. `express.json({ limit:
 * "5mb" })` used to be mounted app-wide ahead of the settings router, and
 * body-parser short-circuits on `req._body`, so the router's own 64 KB
 * `jsonBody` never ran: a JSON draft of up to 5 MB reached `parseAccountForm`
 * and `store.create`, while the browser form of the *same* route was refused at
 * 64 KB. The test above covers the form half only, which is why the suite could
 * not see it.
 */
test("an oversized settings JSON body gets the same clean JSON 4xx the form body gets", async () => {
  const { url, accountsPath, close } = await startConnector();
  try {
    const res = await oversizedPost(url, "application/json");
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
 * The defect was never a missing rejection on one side; it was the two sides
 * disagreeing. Asserted as a pair so neither limit can drift away from the
 * other again — #147 adds a field to exactly this JSON surface.
 */
test("both branches of one settings route refuse an oversized body identically", async () => {
  const { url, close } = await startConnector();
  try {
    const asJson = await oversizedPost(url, "application/json");
    const asForm = await oversizedPost(url, "application/x-www-form-urlencoded");
    assert.equal(
      asJson.status,
      asForm.status,
      "the JSON branch and the form branch of the same route cap at the same size"
    );
    assert.deepEqual(await asJson.json(), await asForm.json(), "and refuse in the same shape");
  } finally {
    await close();
  }
});

/**
 * One POST to `/settings/mailboxes` carrying ~80 KB — over the settings routes'
 * 64 KB cap, and far under the 5 MB `/mcp` keeps — in whichever of the two
 * content types that route accepts.
 */
async function oversizedPost(url: string, contentType: string): Promise<Response> {
  const oversized = "x".repeat(80 * 1024);
  const body =
    contentType === "application/json"
      ? JSON.stringify({ label: oversized, _csrf: CSRF })
      : `label=${oversized}`;
  return fetch(`${url}/settings/mailboxes`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${AUTH_TOKEN}`,
      [ASSERTION_HEADER]: mint("POST", "/settings/mailboxes"),
      "content-type": contentType,
    },
    body,
  });
}

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

// ---- The same routes, answering JSON (#69) ---------------------------------
//
// The setup wizard in the OAuth layer drives three of these routes and takes a
// decision on the answer — save this mailbox, or refuse to. It used to read that
// answer back out of the rendered form with regular expressions, and a test
// helper in the other package mirrored this package's markup verbatim to feed
// them. What follows is the contract that replaced it, exercised against the
// real app: the same routes, the same guards, the same parser and the same
// probe, with a document at the end instead of a page.

/** A draft of the same mailbox `validForm()` describes. */
function validDraft(overrides: Partial<MailboxDraft> = {}): MailboxDraft {
  return { ...draftFromFields(validForm()), ...overrides };
}

async function getJson(url: string, path: string, assertion = mint("GET", path)): Promise<Response> {
  return fetch(`${url}${path}`, {
    headers: {
      authorization: `Bearer ${AUTH_TOKEN}`,
      [ASSERTION_HEADER]: assertion,
      accept: "application/json",
    },
  });
}

async function postJson(
  url: string,
  path: string,
  body: unknown,
  opts: { assertion?: string } = {}
): Promise<Response> {
  return fetch(`${url}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${AUTH_TOKEN}`,
      [ASSERTION_HEADER]: opts.assertion ?? mint("POST", path),
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(body),
    redirect: "manual",
  });
}

test("the new-mailbox route states the accounts stamp when asked for JSON", async () => {
  const { url, accountsPath, close } = await startConnector();
  try {
    const res = await getJson(url, "/settings/mailboxes/new");

    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type")?.split(";")[0].trim(), "application/json");
    assert.deepEqual(await res.json(), { stamp: await stamp(accountsPath) });
    // The same headers a page carries: these bodies hold the same account
    // details, and no-store means as much to a fetch as to a browser.
    for (const [header, value] of Object.entries(EXPECTED_HEADERS)) {
      assert.equal(res.headers.get(header), value, header);
    }
  } finally {
    await close();
  }
});

test("a browser still gets a page from the very same route", async () => {
  // Content negotiation, not a replacement. The settings UI posts to these
  // routes unchanged and must go on getting a page.
  //
  // Which page it is changed with #141: a bare GET is now the address screen,
  // and the eighteen-field form it used to be is `?view=manual`. Both are
  // asserted, because "html rather than a document" is what this case is about
  // and the full form still has to be one press away.
  const { url, close } = await startConnector();
  try {
    const res = await get(url, "/settings/mailboxes/new", mint("GET", "/settings/mailboxes/new"));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type")?.split(";")[0].trim(), "text/html");
    assert.match(await res.text(), /<form method="post" action="\/settings\/mailboxes\/new"/);

    const manual = await get(
      url,
      "/settings/mailboxes/new?view=manual",
      mint("GET", "/settings/mailboxes/new")
    );
    assert.equal(manual.status, 200);
    assert.match(await manual.text(), /<form method="post" action="\/settings\/mailboxes"/);
  } finally {
    await close();
  }
});

test("a JSON probe reports one result per service and writes nothing", async () => {
  const { url, accountsPath, close } = await startConnector();
  try {
    const before = await stamp(accountsPath);
    const res = await postJson(url, "/settings/mailboxes/test", {
      _csrf: CSRF,
      _stamp: before,
      // Port 1 on loopback refuses immediately, so this probes for real without
      // waiting out a DNS lookup.
      mailbox: validDraft({
        imap: { ...validDraft().imap, host: "127.0.0.1", port: "1" },
        smtp: { ...validDraft().smtp, host: "127.0.0.1", port: "1" },
      }),
    });

    assert.equal(res.status, 200);
    const body = (await res.json()) as { probe: MailboxProbeReport };
    // Three services told apart, not one verdict across the lot. CalDAV is null
    // rather than a failure: no CalDAV block was submitted, so none was tried.
    assert.equal(body.probe.imap.ok, false);
    assert.equal(body.probe.smtp.ok, false);
    assert.equal(body.probe.caldav, null);
    assert.equal(typeof (body.probe.imap as { message: string }).message, "string");
    // And the readers on the other side of the hop accept it as written.
    assert.deepEqual(parseProbeAnswer(body), body.probe);

    assert.deepEqual(JSON.parse(await readFile(accountsPath, "utf8")).accounts, []);
    assert.equal(await stamp(accountsPath), before, "a probe writes nothing");
  } finally {
    await close();
  }
});

test("a JSON create stores the account and answers 201 with the id and the new stamp", async () => {
  const { url, accountsPath, close } = await startConnector();
  try {
    const before = await stamp(accountsPath);
    const res = await postJson(url, "/settings/mailboxes", {
      _csrf: CSRF,
      _stamp: before,
      mailbox: validDraft(),
      [SAVE_ANYWAY_FIELD]: true,
    });

    // 201 and not the browser's 303: there is nowhere to redirect a caller that
    // is not a browser, and the status is what the wizard reads as "stored".
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.id, "work");
    assert.equal(body.stamp, await stamp(accountsPath));
    assert.notEqual(body.stamp, before, "the file moved");
    assert.equal(parseCreatedAnswer(body)?.id, "work");

    // Everything the draft carried, on disk, under the connector's own model.
    const stored = JSON.parse(await readFile(accountsPath, "utf8")).accounts[0] as Account;
    assert.equal(stored.imap.host, "imap.example.invalid");
    assert.equal(stored.imap.port, 993, "the port the draft carried as a string");
    assert.equal(stored.imap.pass, "imap-secret");
    assert.equal(stored.smtp.tls, true);
    assert.equal(stored.mail.defaultFrom, "user@example.invalid");
    assert.equal(stored.mail.sentFolder, "Sent");
    assert.equal(stored.caldav, undefined, "no CalDAV block was drafted");
  } finally {
    await close();
  }
});

test("a JSON create carries a CalDAV block through when the draft has one", async () => {
  const { url, accountsPath, close } = await startConnector();
  try {
    const res = await postJson(url, "/settings/mailboxes", {
      _csrf: CSRF,
      _stamp: await stamp(accountsPath),
      mailbox: validDraft({
        caldav: { url: "https://dav.example.invalid/", user: "dav-user", pass: "dav-secret" },
      }),
      [SAVE_ANYWAY_FIELD]: true,
    });

    assert.equal(res.status, 201);
    const stored = JSON.parse(await readFile(accountsPath, "utf8")).accounts[0] as Account;
    assert.deepEqual(stored.caldav, {
      url: "https://dav.example.invalid/",
      user: "dav-user",
      pass: "dav-secret",
    });
  } finally {
    await close();
  }
});

test("a JSON submission the parser rejects comes back keyed by field name", async () => {
  // The same `parseAccountForm` the form goes through, and the same messages —
  // the only difference is where they end up. Every key here is a name from
  // MAILBOX_FIELDS, which is what lets the caller mark the box it belongs to.
  const { url, accountsPath, close } = await startConnector();
  try {
    const res = await postJson(url, "/settings/mailboxes", {
      _csrf: CSRF,
      _stamp: await stamp(accountsPath),
      mailbox: validDraft({
        imap: { host: "", port: "not-a-port", user: "u", pass: "", tls: true },
      }),
    });

    assert.equal(res.status, 400);
    const body = (await res.json()) as { errors: Record<string, string> };
    assert.equal(body.errors[MAILBOX_FIELDS.imapHost], "Required.");
    assert.equal(body.errors[MAILBOX_FIELDS.imapPort], "Must be a port number between 1 and 65535.");
    // #83: a rejected password is reported on its own field rather than nowhere.
    assert.equal(body.errors[MAILBOX_FIELDS.imapPass], "Required.");
    assert.deepEqual(parseErrorAnswer(body).errors, body.errors, "readable from the other side");
    assert.deepEqual(JSON.parse(await readFile(accountsPath, "utf8")).accounts, []);
  } finally {
    await close();
  }
});

test("a JSON create against a stale stamp is refused, not allowed to clobber", async () => {
  const { url, accountsPath, close } = await startConnector();
  try {
    const res = await postJson(url, "/settings/mailboxes", {
      _csrf: CSRF,
      _stamp: "0-0",
      mailbox: validDraft(),
      [SAVE_ANYWAY_FIELD]: true,
    });

    assert.equal(res.status, 409);
    const body = (await res.json()) as { errors: Record<string, string> };
    assert.match(body.errors[MAILBOX_FIELDS.id] ?? "", /changed|reload|stale/i);
    assert.deepEqual(JSON.parse(await readFile(accountsPath, "utf8")).accounts, []);
  } finally {
    await close();
  }
});

test("a JSON body that is not a mailbox draft is refused without a field to blame", async () => {
  const { url, accountsPath, close } = await startConnector();
  try {
    for (const mailbox of [undefined, "a string", { id: "work" }, { ...validDraft(), imap: null }]) {
      const res = await postJson(url, "/settings/mailboxes", {
        _csrf: CSRF,
        _stamp: await stamp(accountsPath),
        mailbox,
      });
      assert.equal(res.status, 400, JSON.stringify(mailbox));
      const body = (await res.json()) as { message?: string; errors: Record<string, string> };
      assert.deepEqual(body.errors, {});
      assert.match(body.message ?? "", /mailbox draft/);
    }
    assert.deepEqual(JSON.parse(await readFile(accountsPath, "utf8")).accounts, []);
  } finally {
    await close();
  }
});

test("the JSON routes are behind exactly the credentials the pages are", async () => {
  // The point of negotiating on the existing routes rather than adding
  // /settings/api/… ones: there is no second place for a guard to be forgotten.
  const { url, accountsPath, close } = await startConnector();
  try {
    const body = { _csrf: CSRF, _stamp: await stamp(accountsPath), mailbox: validDraft() };

    const noBearer = await fetch(`${url}/settings/mailboxes`, {
      method: "POST",
      headers: {
        [ASSERTION_HEADER]: mint("POST", "/settings/mailboxes"),
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(body),
    });
    assert.equal(noBearer.status, 401, "no bearer token");

    const wrongKey = await postJson(url, "/settings/mailboxes", body, {
      assertion: mint("POST", "/settings/mailboxes", OTHER_KEY),
    });
    assert.equal(wrongKey.status, 401, "an assertion this connector did not key");

    const wrongPath = await postJson(url, "/settings/mailboxes", body, {
      assertion: mint("POST", "/settings/mailboxes/test"),
    });
    assert.equal(wrongPath.status, 401, "an assertion bound to another path");

    const wrongCsrf = await postJson(url, "/settings/mailboxes", { ...body, _csrf: "not-it" });
    assert.equal(wrongCsrf.status, 403, "the CSRF field is checked on JSON too");

    assert.deepEqual(JSON.parse(await readFile(accountsPath, "utf8")).accounts, []);
  } finally {
    await close();
  }
});

// ---- The autoconfig lookup route -------------------------------------------
//
// What is asserted here is the *route*: its guards, its content type, its
// status, and that a lookup which finds nothing is a 200 rather than an error.
// The cascade behind it — HTTPS-only, resolve-then-refuse, one redirect, the two
// deadlines, the body cap — is exercised against injected fixtures in
// test/unit/autoconfig.test.ts, which is the only place it can be exercised
// without outbound traffic. Every case below uses an address the module refuses
// before it opens a socket, so this suite stays offline: `parseAddress` rejects
// anything without a two-label domain, and a single-label or bracketed domain is
// exactly the shape that would otherwise turn this route into a port scanner.

/** An address `parseAddress` refuses outright, so nothing leaves the process. */
const UNRESOLVABLE = "operator@localhost";

test("the autoconfig route answers a document, and a miss is a 200 not an error", async () => {
  const { url, close } = await startConnector();
  try {
    const res = await postJson(url, "/settings/autoconfig", {
      _csrf: CSRF,
      email: UNRESOLVABLE,
    });

    // §7: the whole cascade is best-effort, and no autoconfig failure is ever
    // shown to the operator as an error. A status code is the first place that
    // promise could be broken, so it is the first place it is pinned.
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);
    assert.deepEqual(await res.json(), { suggestion: null });
  } finally {
    await close();
  }
});

test("the autoconfig route is a document whether or not JSON was asked for", async () => {
  // Unlike the three mailbox routes, this one is not negotiated: there is no
  // page behind it and never was. A caller that forgets the Accept header gets
  // the same answer rather than a rendered form it cannot read.
  const { url, close } = await startConnector();
  try {
    const res = await fetch(`${url}/settings/autoconfig`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${AUTH_TOKEN}`,
        [ASSERTION_HEADER]: mint("POST", "/settings/autoconfig"),
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ _csrf: CSRF, email: UNRESOLVABLE }).toString(),
      redirect: "manual",
    });

    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);
    assert.deepEqual(await res.json(), { suggestion: null });
  } finally {
    await close();
  }
});

test("a body with no address at all is a miss, not a rejection", async () => {
  // There is nothing for the operator to fix in a rejection here and nothing
  // this route could say that the provider list does not say better.
  const { url, close } = await startConnector();
  try {
    for (const body of [{ _csrf: CSRF }, { _csrf: CSRF, email: "" }, { _csrf: CSRF, email: 7 }]) {
      const res = await postJson(url, "/settings/autoconfig", body);
      assert.equal(res.status, 200, JSON.stringify(body));
      assert.deepEqual(await res.json(), { suggestion: null });
    }
  } finally {
    await close();
  }
});

test("the autoconfig route is behind exactly the credentials the others are", async () => {
  // It makes an outbound request on the strength of its body, which is worth
  // binding to the assertion the same way a write is. A route that fetched a
  // user-named host on an unauthenticated POST would be the SSRF the §7 rules
  // exist to prevent, reachable without any of them being consulted.
  const { url, close } = await startConnector();
  try {
    const body = { _csrf: CSRF, email: UNRESOLVABLE };

    const noBearer = await fetch(`${url}/settings/autoconfig`, {
      method: "POST",
      headers: {
        [ASSERTION_HEADER]: mint("POST", "/settings/autoconfig"),
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(body),
    });
    assert.equal(noBearer.status, 401, "no bearer token");

    const noAssertion = await fetch(`${url}/settings/autoconfig`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${AUTH_TOKEN}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(body),
    });
    assert.equal(noAssertion.status, 401, "no settings assertion");

    const wrongKey = await postJson(url, "/settings/autoconfig", body, {
      assertion: mint("POST", "/settings/autoconfig", OTHER_KEY),
    });
    assert.equal(wrongKey.status, 401, "an assertion this connector did not key");

    const wrongPath = await postJson(url, "/settings/autoconfig", body, {
      assertion: mint("POST", "/settings/mailboxes/test"),
    });
    assert.equal(wrongPath.status, 401, "an assertion bound to another path");

    const expired = await postJson(url, "/settings/autoconfig", body, {
      assertion: mintExpired("POST", "/settings/autoconfig"),
    });
    assert.equal(expired.status, 401, "an expired assertion");

    const wrongCsrf = await postJson(url, "/settings/autoconfig", { ...body, _csrf: "not-it" });
    assert.equal(wrongCsrf.status, 403, "the CSRF field is checked here too");
  } finally {
    await close();
  }
});

test("the autoconfig answer carries the settings header set", async () => {
  const { url, close } = await startConnector();
  try {
    const res = await postJson(url, "/settings/autoconfig", { _csrf: CSRF, email: UNRESOLVABLE });
    await res.json();

    // `no-store` is the one that means as much to a document as to a page: a
    // suggestion names an operator's mail hosts and their login.
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(res.headers.get("x-frame-options"), "DENY");
  } finally {
    await close();
  }
});

// ---- Add mailbox, address first (#141) -------------------------------------
//
// The guided path used to be the setup wizard's alone, which meant it ran once
// — for the mailbox the operator is most likely to know the settings for. These
// are the same four screens served from `/settings/mailboxes/new`, where every
// mailbox after the first is added.
//
// Every case here stays offline. The lookup uses `operator@localhost`, which
// `parseAddress` refuses before it opens a socket, so what is exercised is the
// route and the cascade rather than anybody's autoconfig document.

test("Add mailbox opens on the address screen, not on eighteen empty boxes", async () => {
  const { url, close } = await startConnector();
  try {
    const res = await get(url, "/settings/mailboxes/new", mint("GET", "/settings/mailboxes/new"));
    assert.equal(res.status, 200);
    const html = await res.text();

    assert.match(html, /name="mail\.defaultFrom"/);
    assert.match(html, /name="password"/);
    // The whole of #141: the eighteen-field form is no longer what this URL is.
    assert.equal(html.includes('name="imap.host"'), false, html);
    // And it is still one press away.
    assert.match(html, /href="\/settings\/mailboxes\/new\?view=manual"/);
  } finally {
    await close();
  }
});

test("?view= reaches the provider list and the full form at any time", async () => {
  const { url, close } = await startConnector();
  try {
    const providers = await get(
      url,
      "/settings/mailboxes/new?view=providers",
      mint("GET", "/settings/mailboxes/new")
    );
    assert.equal(providers.status, 200);
    const providerHtml = await providers.text();
    // Served from the connector's own table, as a function call rather than a
    // round trip — this is the package the table lives in.
    assert.match(providerHtml, /value="mailbox-org"/);
    assert.match(providerHtml, /value="other"/);

    const manual = await get(
      url,
      "/settings/mailboxes/new?view=manual",
      mint("GET", "/settings/mailboxes/new")
    );
    assert.equal(manual.status, 200);
    assert.match(await manual.text(), /name="imap\.host"/);

    // A mistyped query is not a reason to show someone eighteen boxes.
    const mistyped = await get(
      url,
      "/settings/mailboxes/new?view=nonsense",
      mint("GET", "/settings/mailboxes/new")
    );
    assert.match(await mistyped.text(), /name="password"/);
  } finally {
    await close();
  }
});

test("the JSON caller still gets the stamp from that URL, cascade or no cascade", async () => {
  // The setup wizard reads the accounts stamp here and does not go through the
  // cascade at all. Adding three screens behind this URL must not have moved it.
  const { url, accountsPath, close } = await startConnector();
  try {
    const res = await fetch(`${url}/settings/mailboxes/new`, {
      headers: {
        authorization: `Bearer ${AUTH_TOKEN}`,
        [ASSERTION_HEADER]: mint("GET", "/settings/mailboxes/new"),
        accept: "application/json",
      },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { stamp: await stamp(accountsPath) });
  } finally {
    await close();
  }
});

test("a lookup that finds nothing shows the provider list and calls it no failure", async () => {
  const { url, close } = await startConnector();
  try {
    const res = await post(url, "/settings/mailboxes/new", {
      _action: "lookup",
      "mail.defaultFrom": UNRESOLVABLE,
      password: "hunter2",
    });

    // Not a 4xx and not an error box: §7 says no autoconfig failure is ever
    // shown to the operator as one, and "nothing published" arrives here the
    // same way every refusal inside the cascade does.
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /value="mailbox-org"/);
    assert.equal(/class="error"/.test(html), false, html);
    // #120: the password came in on this submission and goes on to the form.
    assert.match(html, /<input type="hidden" name="password" value="hunter2">/);
  } finally {
    await close();
  }
});

test("an address the screen cannot read is the one thing it does report", async () => {
  const { url, close } = await startConnector();
  try {
    const res = await post(url, "/settings/mailboxes/new", {
      _action: "lookup",
      "mail.defaultFrom": "anna",
      password: "hunter2",
    });

    assert.equal(res.status, 400);
    const html = await res.text();
    assert.match(html, /Enter a full email address/);
    assert.match(html, /value="anna"/);
  } finally {
    await close();
  }
});

test("choosing a provider fills the form in and stores nothing", async () => {
  const { url, accountsPath, close } = await startConnector();
  const before = await stamp(accountsPath);
  try {
    const res = await post(url, "/settings/mailboxes/new", {
      _action: "provider",
      "mail.defaultFrom": "anna@posteo.net",
      provider: "posteo",
      password: "hunter2",
    });

    assert.equal(res.status, 200);
    const html = await res.text();
    // The values are the reason to pick a provider, and this is the only screen
    // that shows them — including the ones a reader would have guessed wrong.
    assert.match(html, /value="posteo\.de"/);
    assert.match(html, new RegExp(escapeRe("https://posteo.de:8443/calendars/anna/default")));
    assert.match(html, /Posteo settings have been filled in/);
    // Derived, shown, and not applied: the id box is filled in and editable.
    assert.match(html, /<input id="id" name="id" type="text" value="anna"/);
    // And the password the operator typed a screen ago is in the boxes that
    // will send it, rather than being asked for a second time.
    assert.match(html, /type="password" value="hunter2"/);
    assert.equal(await stamp(accountsPath), before, "nothing was written");
  } finally {
    await close();
  }
});

test("Other leads to an empty form with TLS still on and the address kept", async () => {
  const { url, close } = await startConnector();
  try {
    const res = await post(url, "/settings/mailboxes/new", {
      _action: "provider",
      "mail.defaultFrom": "anna@example.com",
      provider: "other",
      password: "hunter2",
    });

    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /value="anna@example\.com"/);
    // An absent checkbox is how a browser submits an unticked one, so a form
    // rendered from any submitted values would otherwise come back with TLS off
    // — a default nobody chose, on the one setting worth defaulting.
    assert.match(html, /name="imap\.tls"[^>]*checked/);
    assert.match(html, /name="smtp\.tls"[^>]*checked/);
  } finally {
    await close();
  }
});

test("a provider this build does not have is a question, not a crash", async () => {
  const { url, close } = await startConnector();
  try {
    const res = await post(url, "/settings/mailboxes/new", {
      _action: "provider",
      "mail.defaultFrom": "anna@example.com",
      provider: "a-provider-from-another-release",
      password: "hunter2",
    });

    assert.equal(res.status, 400);
    assert.match(await res.text(), /Choose a provider, or pick Other\./);
  } finally {
    await close();
  }
});

test("Edit these opens the form on what was found, with no password from a file", async () => {
  const { url, close } = await startConnector();
  try {
    const res = await post(url, "/settings/mailboxes/new", {
      _action: "edit",
      id: "anna",
      label: "anna@example.com",
      "mail.defaultFrom": "anna@example.com",
      "imap.host": "imap.example.com",
      "imap.port": "993",
      "imap.user": "anna@example.com",
      "imap.tls": "1",
      "smtp.host": "smtp.example.com",
      "smtp.port": "587",
      "smtp.user": "anna@example.com",
      password: "hunter2",
    });

    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /value="imap\.example\.com"/);
    assert.match(html, /value="587"/);
    // The one password on the page is the one that arrived on this submission.
    assert.match(html, /type="password" value="hunter2"/);
    assert.match(html, /Nothing has been saved/);
  } finally {
    await close();
  }
});

test("the cascade route is behind the same CSRF check every write is", async () => {
  const { url, close } = await startConnector();
  try {
    const noCsrf = await post(
      url,
      "/settings/mailboxes/new",
      { _action: "provider", "mail.defaultFrom": "anna@example.com", provider: "posteo" },
      { csrf: "" }
    );
    assert.equal(noCsrf.status, 403);

    const wrongCsrf = await post(
      url,
      "/settings/mailboxes/new",
      { _action: "provider", "mail.defaultFrom": "anna@example.com", provider: "posteo" },
      { csrf: "not-it" }
    );
    assert.equal(wrongCsrf.status, 403);

    const wrongPath = await post(
      url,
      "/settings/mailboxes/new",
      { _action: "provider", "mail.defaultFrom": "anna@example.com", provider: "posteo" },
      { assertion: mint("POST", "/settings/mailboxes") }
    );
    assert.equal(wrongPath.status, 401);
  } finally {
    await close();
  }
});

test("every Add mailbox screen carries the settings header set", async () => {
  const { url, close } = await startConnector();
  try {
    const screens = [
      await get(url, "/settings/mailboxes/new", mint("GET", "/settings/mailboxes/new")),
      await get(
        url,
        "/settings/mailboxes/new?view=providers",
        mint("GET", "/settings/mailboxes/new")
      ),
      await post(url, "/settings/mailboxes/new", {
        _action: "provider",
        "mail.defaultFrom": "anna@posteo.net",
        provider: "posteo",
      }),
    ];
    for (const res of screens) {
      for (const [header, value] of Object.entries(EXPECTED_HEADERS)) {
        assert.equal(res.headers.get(header), value, header);
      }
    }
  } finally {
    await close();
  }
});

// ---- The provider table, for the wizard ------------------------------------

test("the provider route answers the table as a document, filled in for the address", async () => {
  const { url, close } = await startConnector();
  try {
    const res = await postJson(url, "/settings/providers", {
      _csrf: CSRF,
      email: "anna@posteo.net",
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);

    const answer = parseProvidersAnswer(await res.json());
    assert.ok(answer, "the connector's own answer must be readable by the shared reader");
    assert.deepEqual(
      answer.providers.map((p) => p.id),
      MAIL_PROVIDERS.map((p) => p.id)
    );
    const posteo = answer.providers.find((p) => p.id === "posteo");
    assert.ok(posteo);
    // Resolved on this side: the wizard never sees a placeholder.
    assert.equal(
      posteo.values[MAILBOX_FIELDS.caldavUrl],
      "https://posteo.de:8443/calendars/anna/default"
    );
    // And no password field, at any depth, for any entry. (The word appears in
    // the caveats — several providers want an app password — so the assertion
    // is about the field names, which are the things that could carry one.)
    const serialised = JSON.stringify(answer);
    for (const secret of [
      MAILBOX_FIELDS.imapPass,
      MAILBOX_FIELDS.smtpPass,
      MAILBOX_FIELDS.caldavPass,
    ]) {
      assert.equal(serialised.includes(secret), false, secret);
    }
  } finally {
    await close();
  }
});

test("the provider route is behind exactly the credentials the others are", async () => {
  const { url, close } = await startConnector();
  const body = { _csrf: CSRF, email: "anna@example.com" };
  try {
    const noBearer = await fetch(`${url}/settings/providers`, {
      method: "POST",
      headers: {
        [ASSERTION_HEADER]: mint("POST", "/settings/providers"),
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    assert.equal(noBearer.status, 401);

    const noAssertion = await fetch(`${url}/settings/providers`, {
      method: "POST",
      headers: { authorization: `Bearer ${AUTH_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(noAssertion.status, 401);

    const wrongKey = await postJson(url, "/settings/providers", body, {
      assertion: mint("POST", "/settings/providers", OTHER_KEY),
    });
    assert.equal(wrongKey.status, 401);

    const wrongPath = await postJson(url, "/settings/providers", body, {
      assertion: mint("POST", "/settings/autoconfig"),
    });
    assert.equal(wrongPath.status, 401);

    const expired = await postJson(url, "/settings/providers", body, {
      assertion: mintExpired("POST", "/settings/providers"),
    });
    assert.equal(expired.status, 401);

    const wrongCsrf = await postJson(url, "/settings/providers", { ...body, _csrf: "not-it" });
    assert.equal(wrongCsrf.status, 403);
  } finally {
    await close();
  }
});

// ---- The confirmation screen's Save, end to end ----------------------------

test("one password, asked once, reaches both services in the stored account", async () => {
  // What the confirmation screen submits: hidden settings, an id and a label in
  // boxes, and one `password` field — the #120 rule that the operator is asked
  // for a mailbox password once. `withSharedPassword` is what spreads it, and
  // this is the only place that is visible end to end.
  const { url, accountsPath, close } = await startConnector();
  try {
    const res = await post(
      url,
      "/settings/mailboxes",
      await withStamp(accountsPath, {
        _action: "save",
        id: "anna",
        label: "anna@example.com",
        "mail.defaultFrom": "anna@example.com",
        "imap.host": "imap.example.invalid",
        "imap.port": "993",
        "imap.user": "anna@example.com",
        "imap.tls": "1",
        "smtp.host": "smtp.example.invalid",
        "smtp.port": "465",
        "smtp.user": "anna@example.com",
        "smtp.tls": "1",
        password: "one-password-asked-once",
      })
    );
    assert.equal(res.status, 303);

    const stored = JSON.parse(await readFile(accountsPath, "utf8")) as {
      accounts: Array<{ id: string; imap: { pass: string }; smtp: { pass: string } }>;
    };
    const account = stored.accounts.find((a) => a.id === "anna");
    assert.ok(account, "the mailbox was stored");
    assert.equal(account.imap.pass, "one-password-asked-once");
    assert.equal(account.smtp.pass, "one-password-asked-once");
  } finally {
    await close();
  }
});

test("a save with no CalDAV URL gets no CalDAV block from the shared password", async () => {
  // A CalDAV block that is nothing but a password is a probe against a server
  // nobody named, and the account model treats CalDAV as optional.
  const { url, accountsPath, close } = await startConnector();
  try {
    const res = await post(
      url,
      "/settings/mailboxes",
      await withStamp(accountsPath, {
        ...validForm({ id: "anna" }),
        "imap.pass": "",
        "smtp.pass": "",
        password: "one-password-asked-once",
      })
    );
    assert.equal(res.status, 303);

    const stored = JSON.parse(await readFile(accountsPath, "utf8")) as {
      accounts: Array<{ id: string; caldav?: unknown }>;
    };
    assert.equal(stored.accounts.find((a) => a.id === "anna")?.caldav, undefined);
  } finally {
    await close();
  }
});

test("the full form's own passwords still win over a shared one", async () => {
  // The full form is where a mailbox whose IMAP and SMTP logins take different
  // passwords is expressed. Spreading one over it would silently destroy that.
  const { url, accountsPath, close } = await startConnector();
  try {
    const res = await post(
      url,
      "/settings/mailboxes",
      await withStamp(accountsPath, {
        ...validForm({ id: "anna" }),
        "imap.pass": "different-for-imap",
        "smtp.pass": "different-for-smtp",
        password: "would-have-overwritten-both",
      })
    );
    assert.equal(res.status, 303);

    const stored = JSON.parse(await readFile(accountsPath, "utf8")) as {
      accounts: Array<{ id: string; imap: { pass: string }; smtp: { pass: string } }>;
    };
    const account = stored.accounts.find((a) => a.id === "anna");
    assert.ok(account);
    assert.equal(account.imap.pass, "different-for-imap");
    assert.equal(account.smtp.pass, "different-for-smtp");
  } finally {
    await close();
  }
});

test("a rejected save never echoes the shared password back into the page", async () => {
  // `sanitize()` strips every password field out of a re-rendered submission,
  // and the cascade's own single box is one of them — otherwise it would be the
  // one secret the strip missed.
  const { url, accountsPath, close } = await startConnector();
  try {
    const res = await post(
      url,
      "/settings/mailboxes",
      await withStamp(accountsPath, {
        ...validForm({ id: "Not A Valid Id" }),
        password: "must-not-be-echoed",
      })
    );
    assert.equal(res.status, 400);
    const html = await res.text();
    assert.equal(html.includes("must-not-be-echoed"), false, html);
  } finally {
    await close();
  }
});

// ---- The save that probes first (#147) -------------------------------------
//
// The two cases here are the ones a fake server can carry on its own: a real
// IMAP rejection, and the override that skips the probe entirely. The rest of
// the gate — a save that goes through, and a CalDAV failure that does not stop
// one — needs servers that *work*, and lives in settings-save-probe.test.ts
// against GreenMail.

/** The full form, pointed at a server that refuses every login. */
function formAgainst(port: number, overrides: Record<string, string> = {}): Record<string, string> {
  return validForm({
    id: "work",
    "imap.host": "127.0.0.1",
    "imap.port": String(port),
    "imap.tls": "",
    // Nothing is listening here, so SMTP is a connectivity failure — a
    // different half of the same classification, on the same submission.
    "smtp.host": "127.0.0.1",
    "smtp.port": "1",
    "smtp.tls": "",
    ...overrides,
  });
}

test("a mailbox whose IMAP the server rejects is not written, and the page says which", async () => {
  const imap = await startRejectingImapServer();
  const { url, accountsPath, close } = await startConnector();
  try {
    const res = await post(
      url,
      "/settings/mailboxes",
      await withStampProbed(accountsPath, formAgainst(imap.port))
    );

    assert.equal(res.status, 400, "the write must be refused, not merely reported on");
    const page = await res.text();
    // Per service, and told apart: the IMAP server answered and said no, the
    // SMTP port has nothing behind it at all. Collapsing those two into "the
    // connection test failed" is the confusion #146 exists to prevent.
    assert.match(page, /IMAP rejected these credentials/);
    assert.match(page, /SMTP did not answer/);
    assert.match(page, /the server rejected these credentials/);
    assert.match(page, /Save anyway/, "the way past the gate has to be on the page");

    assert.deepEqual(
      JSON.parse(await readFile(accountsPath, "utf8")).accounts,
      [],
      "nothing may be stored by a submission the probe refused"
    );
  } finally {
    await close();
    await imap.close();
  }
});

test("the same submission in JSON is refused with the report, not just a message", async () => {
  const imap = await startRejectingImapServer();
  const { url, accountsPath, close } = await startConnector();
  try {
    const res = await postJson(url, "/settings/mailboxes", {
      _csrf: CSRF,
      _stamp: await stamp(accountsPath),
      mailbox: draftFromFields(formAgainst(imap.port)),
    });

    assert.equal(res.status, 400);
    const answer = parseErrorAnswer(await res.json());
    assert.equal(answer.probe?.imap.ok, false);
    // The classification, on the wire — which is what lets the wizard say the
    // same sentence this connector's own page says.
    assert.equal(
      answer.probe?.imap.ok === false && answer.probe.imap.credentialRejection,
      true
    );
    assert.equal(answer.probe?.smtp.ok, false);
    assert.match(answer.message ?? "", /nothing was saved/i);
    assert.deepEqual(answer.errors, {}, "no field the operator typed is wrong");
    assert.deepEqual(JSON.parse(await readFile(accountsPath, "utf8")).accounts, []);
  } finally {
    await close();
    await imap.close();
  }
});

test("Save anyway writes the very same mailbox, and probes nothing", async () => {
  // Same credentials, same servers, one extra field — and the operator gets
  // their mailbox. That is the escape hatch: a server in maintenance, a
  // network blip, or someone who knows better is not stuck behind a probe.
  const imap = await startRejectingImapServer();
  const { url, accountsPath, close } = await startConnector();
  try {
    const started = Date.now();
    const res = await post(
      url,
      "/settings/mailboxes",
      await withStampProbed(accountsPath, {
        ...formAgainst(imap.port),
        [SAVE_ANYWAY_FIELD]: CHECKBOX_ON,
      })
    );

    assert.equal(res.status, 303);
    const stored = JSON.parse(await readFile(accountsPath, "utf8")).accounts as Account[];
    assert.equal(stored.length, 1);
    assert.equal(stored[0]?.id, "work");
    // Nothing was probed, so nothing waited on a socket: a probe against the
    // dead SMTP port alone would have cost seconds. This is the observable
    // difference between "the probe passed" and "there was no probe".
    assert.ok(Date.now() - started < 2000, "Save anyway must not have probed anything");
  } finally {
    await close();
    await imap.close();
  }
});

test("an edit is gated the same way, and leaves the stored mailbox alone", async () => {
  // The route an operator uses for every mailbox they already have. An edit
  // that replaces a working password with one the server refuses leaves
  // exactly the mailbox #147 is about.
  const imap = await startRejectingImapServer();
  const { url, accountsPath, close } = await startConnector([
    makeAccount({ id: "work", label: "Work" }),
  ]);
  try {
    const res = await post(
      url,
      "/settings/mailboxes/work",
      await withStampProbed(accountsPath, formAgainst(imap.port, { "imap.pass": "changed" }))
    );

    assert.equal(res.status, 400);
    assert.match(await res.text(), /rejected these credentials/);
    const stored = JSON.parse(await readFile(accountsPath, "utf8")).accounts as Account[];
    assert.equal(stored[0]?.imap.pass, makeAccount({ id: "work" }).imap.pass, "unchanged");
  } finally {
    await close();
    await imap.close();
  }
});

/** The `<input>` tag with this `id`, from a rendered page. */
function inputTag(page: string, id: string): string {
  const match = new RegExp(`<input id="${escapeRe(id)}"[^>]*>`).exec(page);
  assert.ok(match, `expected an input with id="${id}" on the page`);
  return match[0];
}

test("the refusal page carries the passwords back, so Save anyway can be pressed", async () => {
  // The milestone's headline scenario, walked to its end. The operator types an
  // account password Google will not take over IMAP, presses Save, waits out
  // the probe, and lands on a 400 whose notice ends "…or press Save anyway to
  // store it without testing it."
  //
  // `sanitize()` strips every password, and this form's boxes are `required`
  // because there is no account behind it — so that button used to do nothing
  // but pop the browser's "Please fill out this field" bubble, on a box the
  // server had just cleared. The advertised escape hatch was a dead end on the
  // exact screen the deployment failure happened on.
  const imap = await startRejectingImapServer();
  const { url, accountsPath, close } = await startConnector();
  try {
    const res = await post(
      url,
      "/settings/mailboxes",
      await withStampProbed(accountsPath, formAgainst(imap.port))
    );
    assert.equal(res.status, 400);
    const page = await res.text();

    assert.match(inputTag(page, "imap_pass"), /value="imap-secret"/);
    assert.match(inputTag(page, "smtp_pass"), /value="smtp-secret"/);
    assert.match(page, /Save anyway/, "the way past the gate has to be on the page");
  } finally {
    await close();
    await imap.close();
  }
});

test("Test connection carries them back too", async () => {
  // The same dead end by a different door: probe, then a form whose mandatory
  // password boxes the answer had emptied. This route stores nothing whatever
  // it finds, so the only thing the operator can do next is press Save.
  const imap = await startRejectingImapServer();
  const { url, accountsPath, close } = await startConnector();
  try {
    const res = await post(
      url,
      "/settings/mailboxes/test",
      await withStampProbed(accountsPath, formAgainst(imap.port))
    );
    assert.equal(res.status, 200);
    assert.match(inputTag(await res.text(), "imap_pass"), /value="imap-secret"/);
  } finally {
    await close();
    await imap.close();
  }
});

test("the refusal page does not tell the operator to press Save", async () => {
  // The probe panel's footer was written for the *Test connection* answer,
  // where "These values were not saved. Press Save to store them." is true. On
  // a page that has just refused a Save it is advice that cannot work — Save
  // re-probes and refuses again — and it contradicts the notice a few lines
  // above it. Both pages are asserted here, because the fix has to leave the
  // sentence standing where it is still true.
  const imap = await startRejectingImapServer();
  const { url, accountsPath, close } = await startConnector();
  try {
    const refused = await post(
      url,
      "/settings/mailboxes",
      await withStampProbed(accountsPath, formAgainst(imap.port))
    );
    assert.equal(refused.status, 400);
    const refusedPage = await refused.text();
    assert.match(refusedPage, /IMAP rejected these credentials/, "the panel is on the page");
    assert.doesNotMatch(refusedPage, /Press Save to store them/);

    const tested = await post(
      url,
      "/settings/mailboxes/test",
      await withStampProbed(accountsPath, formAgainst(imap.port))
    );
    assert.equal(tested.status, 200);
    assert.match(await tested.text(), /Press Save to store them/);
  } finally {
    await close();
    await imap.close();
  }
});

test("the 303 after a state-changing POST carries the header set, through the whole app", async () => {
  // The unit suite pins this on the settings router alone. Here the response
  // comes back through the connector's full middleware chain, so a header
  // something upstream drops or overwrites shows up as a failure rather than
  // as a passing test of a router nobody mounts on its own (#127).
  const { url, accountsPath, close } = await startConnector([
    makeAccount({ id: "work", label: "Work" }),
    makeAccount({ id: "spare", label: "Spare" }),
  ]);
  try {
    const res = await post(url, "/settings/mailboxes/spare/default", await withStamp(accountsPath, {}));
    assert.equal(res.status, 303);
    for (const [name, value] of Object.entries(EXPECTED_HEADERS)) {
      assert.equal(res.headers.get(name), value, `expected ${name} on the 303`);
    }
    assert.equal(res.headers.get("content-type"), null, "a redirect carries no body to describe");
  } finally {
    await close();
  }
});
