/**
 * The half of #147 that needs a mail server which actually works.
 *
 * `POST /settings/mailboxes` and `POST /settings/mailboxes/:id` probe before
 * they write. Refusing on a failure can be shown against a fake server — and
 * test/integration/settings-mailboxes.test.ts does exactly that — but the other
 * three quarters of the rule cannot:
 *
 *   - a save that goes *through* because the credentials are good;
 *   - IMAP working while SMTP does not, which is what proves each service gates
 *     the write on its own rather than the pair being read as one verdict;
 *   - a CalDAV block that fails while the save proceeds anyway, which is the
 *     one deliberate hole in the gate and the easiest thing to close by
 *     accident.
 *
 * All three need IMAP and SMTP to answer, so all three are here, against
 * GreenMail (docker-compose.test.yml) with the connector's real Express app in
 * front of them. Without Docker every case skips with a reason rather than
 * failing, exactly as the other Docker-backed files do.
 *
 * This is a third file owning the GreenMail lifecycle. See the note at the top
 * of test/helpers/docker.ts: `--test-concurrency=1` in the `test:integration`
 * script is what makes that safe, and the cost is wall-clock time rather than
 * flakiness.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import { AccountsStore, type Account } from "../../src/accounts.js";
import { ClientPool } from "../../src/client-pool.js";
import { createApp } from "../../src/app.js";
import { ASSERTION_HEADER } from "../../src/settings-assertion.js";
import { CHECKBOX_ON, SAVE_ANYWAY_FIELD } from "../../shared/settings-api.js";
import { isDockerAvailable, composeUp, composeDown, waitForGreenmailReady } from "../helpers/docker.js";
import { startFakeCalDavServer, type FakeCalDavServer } from "../helpers/fake-caldav.js";
import { ensureMailboxes } from "../helpers/imap-setup.js";
import { makeTmpDir, cleanupTmpDir } from "../helpers/fixtures.js";

const DOCKER_AVAILABLE = isDockerAvailable();
const SKIP: { skip: string } | Record<string, never> = DOCKER_AVAILABLE
  ? {}
  : { skip: "Docker is not available — skipping integration tests against GreenMail" };

const GREENMAIL_HOST = "127.0.0.1";
const IMAP_PORT = 3143;
const SMTP_PORT = 3025;
const USER = "alice";
const PASSWORD = "pw1";

const AUTH_TOKEN = "settings-save-probe-token-please-do-not-reuse";
const SETTINGS_KEY = "s".repeat(32);
const CSRF = "test-csrf-value";
const PUBLIC_URL = "https://mail-mcp.example.invalid";

interface Connector {
  url: string;
  accountsPath: string;
  close(): Promise<void>;
}

async function startConnector(accounts: Account[] = []): Promise<Connector> {
  const dir = await makeTmpDir();
  const accountsPath = `${dir}/accounts.json`;
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
    publicUrl: PUBLIC_URL,
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

/** An assertion in the shape the OAuth layer mints, bound to this method and path. */
function mint(method: string, path: string): string {
  const payload = {
    v: 1,
    iss: PUBLIC_URL,
    aud: "mail-mcp-settings",
    sub: "operator",
    sid: "session-1",
    csrf: CSRF,
    htm: method.toUpperCase(),
    htu: path,
    exp: Math.floor(Date.now() / 1000) + 60,
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const mac = createHmac("sha256", Buffer.from(SETTINGS_KEY, "utf8")).update(encoded).digest("base64url");
  return `${encoded}.${mac}`;
}

async function post(
  url: string,
  path: string,
  fields: Record<string, string>
): Promise<Response> {
  const body = new URLSearchParams({ _csrf: CSRF, ...fields });
  return fetch(`${url}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${AUTH_TOKEN}`,
      [ASSERTION_HEADER]: mint("POST", path),
      "content-type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
    redirect: "manual",
  });
}

async function stampOf(accountsPath: string): Promise<string> {
  const { readStamp } = await import("../../src/accounts-writer.js");
  return readStamp(accountsPath);
}

async function storedAccounts(accountsPath: string): Promise<Account[]> {
  return JSON.parse(await readFile(accountsPath, "utf8")).accounts as Account[];
}

/** The full form, pointed at GreenMail, with whatever a case wants changed. */
function form(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    id: "work",
    label: "Work",
    "imap.host": GREENMAIL_HOST,
    "imap.port": String(IMAP_PORT),
    "imap.user": USER,
    "imap.pass": PASSWORD,
    "imap.tls": "",
    "smtp.host": GREENMAIL_HOST,
    "smtp.port": String(SMTP_PORT),
    "smtp.user": USER,
    "smtp.pass": PASSWORD,
    "smtp.tls": "",
    "mail.defaultFrom": `${USER}@example.invalid`,
    "mail.draftsFolder": "Drafts",
    "mail.sentFolder": "Sent",
    ...overrides,
  };
}

before(async () => {
  if (!DOCKER_AVAILABLE) return;
  composeUp();
  await waitForGreenmailReady();
  // GreenMail registers its `-Dgreenmail.users=...` accounts slightly after the
  // IMAP listener starts answering; this absorbs that race the same way
  // test/integration/probe.test.ts does.
  await ensureMailboxes(
    { host: GREENMAIL_HOST, port: IMAP_PORT, user: USER, pass: PASSWORD },
    []
  );
});

after(async () => {
  if (DOCKER_AVAILABLE) composeDown();
});

test("credentials the server accepts are stored, having authenticated once first", SKIP, async () => {
  const { url, accountsPath, close } = await startConnector();
  try {
    const res = await post(url, "/settings/mailboxes", {
      ...form(),
      _stamp: await stampOf(accountsPath),
    });

    assert.equal(res.status, 303, "a save that probed clean still goes to the list");
    const accounts = await storedAccounts(accountsPath);
    assert.equal(accounts.length, 1);
    assert.equal(accounts[0]?.id, "work");
  } finally {
    await close();
  }
});

test("a password the server rejects is refused at save time, and nothing is stored", SKIP, async () => {
  // The case that opened the milestone, against a real server rather than a
  // fake one: a mailbox whose credentials the server refuses used to sit in
  // accounts.json having never authenticated once.
  const { url, accountsPath, close } = await startConnector();
  try {
    const res = await post(url, "/settings/mailboxes", {
      ...form({ "imap.pass": "not-the-password" }),
      _stamp: await stampOf(accountsPath),
    });

    assert.equal(res.status, 400);
    const page = await res.text();
    assert.match(page, /IMAP rejected these credentials/);
    // SMTP answered, so the refusal must not implicate it. A gate that reports
    // one verdict across the lot sends the operator to look at both.
    assert.equal(page.includes("SMTP did not answer"), false, page);
    assert.deepEqual(await storedAccounts(accountsPath), []);
  } finally {
    await close();
  }
});

test("a working IMAP does not carry a broken SMTP past the gate", SKIP, async () => {
  // Each service gates the write on its own. Port 1 on loopback refuses
  // immediately, so this is a connectivity failure beside a login that worked.
  const { url, accountsPath, close } = await startConnector();
  try {
    const res = await post(url, "/settings/mailboxes", {
      ...form({ "smtp.port": "1" }),
      _stamp: await stampOf(accountsPath),
    });

    assert.equal(res.status, 400);
    const page = await res.text();
    assert.match(page, /SMTP did not answer/);
    assert.equal(page.includes("IMAP rejected"), false, page);
    assert.deepEqual(await storedAccounts(accountsPath), []);
  } finally {
    await close();
  }
});

test("a CalDAV server that refuses does not stop the save, and the operator is told", SKIP, async () => {
  // The one deliberate hole in the gate. CalDAV is optional in the account
  // model and fails for benign reasons far too often to gate a mailbox on;
  // showing the failure is right, refusing on it is not.
  let caldav: FakeCalDavServer | undefined;
  const { url, accountsPath, close } = await startConnector();
  try {
    caldav = await startFakeCalDavServer("reject-credentials");
    const res = await post(url, "/settings/mailboxes", {
      ...form({
        "caldav.url": caldav.url,
        "caldav.user": USER,
        "caldav.pass": "not-the-password",
      }),
      _stamp: await stampOf(accountsPath),
    });

    // 200 and the mailbox list, not the 303 a clean save gets: a redirect
    // carries nothing, and this is the one outcome that has something to say.
    assert.equal(res.status, 200);
    const page = await res.text();
    assert.match(page, /The mailbox was saved/);
    assert.match(page, /calendar tools/i);
    assert.match(page, /rejected these credentials/);

    const accounts = await storedAccounts(accountsPath);
    assert.equal(accounts.length, 1, "the mailbox is stored, CalDAV or no CalDAV");
    assert.equal(accounts[0]?.caldav?.url, caldav.url, "including the block that failed");
  } finally {
    await close();
    await caldav?.close();
  }
});

test("Save anyway stores credentials the server would have refused", SKIP, async () => {
  const { url, accountsPath, close } = await startConnector();
  try {
    const res = await post(url, "/settings/mailboxes", {
      ...form({ "imap.pass": "not-the-password" }),
      _stamp: await stampOf(accountsPath),
      [SAVE_ANYWAY_FIELD]: CHECKBOX_ON,
    });

    assert.equal(res.status, 303);
    const accounts = await storedAccounts(accountsPath);
    assert.equal(accounts.length, 1);
    assert.equal(accounts[0]?.imap.pass, "not-the-password", "stored exactly as typed");
  } finally {
    await close();
  }
});
