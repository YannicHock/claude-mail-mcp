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
import { readFile } from "node:fs/promises";

import type { Account } from "../../src/accounts.js";
import { ASSERTION_HEADER } from "../../src/settings-assertion.js";
import { CHECKBOX_ON, SAVE_ANYWAY_FIELD } from "../../shared/settings-api.js";
import { isDockerAvailable, composeUp, composeDown, waitForGreenmailReady } from "../helpers/docker.js";
import { startFakeCalDavServer, type FakeCalDavServer } from "../helpers/fake-caldav.js";
import { ensureMailboxes } from "../helpers/imap-setup.js";
import {
  AUTH_TOKEN,
  mint,
  post,
  startConnector,
  stampOf,
  type LogLine,
} from "../helpers/settings-connector.js";

const DOCKER_AVAILABLE = isDockerAvailable();
const SKIP: { skip: string } | Record<string, never> = DOCKER_AVAILABLE
  ? {}
  : { skip: "Docker is not available — skipping integration tests against GreenMail" };

const GREENMAIL_HOST = "127.0.0.1";
const IMAP_PORT = 3143;
const SMTP_PORT = 3025;
const USER = "alice";
const PASSWORD = "pw1";

/**
 * Where a save's 303 points, asserted to be the list with a notice token, and
 * the page a browser gets there.
 */
async function followNotice(url: string, res: Response): Promise<string> {
  const location = res.headers.get("location") ?? "";
  assert.match(location, /^\/settings\/mailboxes\?notice=[A-Za-z0-9_-]{22}$/);
  const page = await fetch(`${url}${location}`, {
    headers: {
      authorization: `Bearer ${AUTH_TOKEN}`,
      [ASSERTION_HEADER]: mint("GET", "/settings/mailboxes"),
    },
    redirect: "manual",
  });
  assert.equal(page.status, 200);
  return page.text();
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

    // A 303 like every other save (#173): a 200 rendered out of the POST made
    // a reload re-submit the form. The notice rides the redirect as a token
    // the list route turns back into the sentence.
    assert.equal(res.status, 303);
    const page = await followNotice(url, res);
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

test("an edit whose CalDAV fails lands on the list by 303 too, not on the edit URL", SKIP, async () => {
  let caldav: FakeCalDavServer | undefined;
  const { url, accountsPath, close } = await startConnector();
  try {
    const created = await post(url, "/settings/mailboxes", {
      ...form(),
      _stamp: await stampOf(accountsPath),
    });
    assert.equal(created.status, 303);
    caldav = await startFakeCalDavServer("reject-credentials");
    const res = await post(url, "/settings/mailboxes/work", {
      ...form({
        "caldav.url": caldav.url,
        "caldav.user": USER,
        "caldav.pass": "not-the-password",
      }),
      _stamp: await stampOf(accountsPath),
    });
    assert.equal(res.status, 303, res.status === 303 ? "" : await res.text());
    const page = await followNotice(url, res);
    assert.match(page, /The mailbox was saved/);
    assert.equal((await storedAccounts(accountsPath))[0]?.caldav?.url, caldav.url);
  } finally {
    await close();
    await caldav?.close();
  }
});

test("every save says in the log whether it was tested first (#173)", SKIP, async () => {
  // The refusal already left a `warn` line; a successful write left nothing, so
  // an operator could not tell from the log whether a mailbox that fails every
  // tool call had ever authenticated. *Save anyway* is exactly that case.
  const lines: LogLine[] = [];
  const { url, accountsPath, close } = await startConnector([], { lines });
  try {
    const saved = (): LogLine[] =>
      lines.filter((line) => line.message === "settings: a mailbox was saved");

    const created = await post(url, "/settings/mailboxes", {
      ...form(),
      _stamp: await stampOf(accountsPath),
    });
    assert.equal(created.status, 303);
    assert.deepEqual(saved().map((l) => [l.level, l.fields]), [
      ["info", { action: "create", id: "work", probed: true }],
    ]);

    const edited = await post(url, "/settings/mailboxes/work", {
      ...form({ "imap.pass": "not-the-password" }),
      _stamp: await stampOf(accountsPath),
      [SAVE_ANYWAY_FIELD]: CHECKBOX_ON,
    });
    assert.equal(edited.status, 303);
    assert.deepEqual(saved()[1]?.fields, { action: "edit", id: "work", probed: false });
    const everything = JSON.stringify(lines);
    assert.equal(everything.includes("not-the-password"), false, "never the password");
    assert.equal(everything.includes(PASSWORD), false, "never the password");
  } finally {
    await close();
  }
});

test("a probe that works does not take the warning off the screen with it", SKIP, async () => {
  // #191, and the half of it that needs servers which answer. The warning is a
  // fact about the **address**, so *Test connection* keeps it whichever way the
  // probe went — and a clean probe is the case that matters most, because that
  // is the operator running Proton Mail Bridge, which is exactly who the Bridge
  // sentence is written for: their servers answer, their mailbox works, and
  // they are the one audience the sentence must reach.
  //
  // GreenMail stands in for Bridge's local IMAP and SMTP here, which is what
  // Bridge is from this connector's side: a server on the machine that answers
  // an ordinary password.
  const { url, accountsPath, close } = await startConnector();
  try {
    const res = await post(url, "/settings/mailboxes/test", {
      ...form({ "mail.defaultFrom": "anna@proton.me" }),
      _stamp: await stampOf(accountsPath),
    });

    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Bridge/, "a probe that worked carried the warning away with it");
    assert.equal(/probe-row fail/.test(html), false, "both services answered");
    assert.deepEqual(await storedAccounts(accountsPath), [], "Test connection stores nothing");
  } finally {
    await close();
  }
});
