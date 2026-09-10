/**
 * The setup wizard, against the real gate and the real middleware chain.
 *
 * Three things this file exists to hold in place.
 *
 * **The way out.** The wizard's whole purpose is to leave the instance claimed,
 * and until step 3 landed there was no code path in the service that called
 * `Bootstrap.complete()` at all: an operator could finish both earlier screens
 * and still be left with `/mcp` answering 503 for ever, the settings UI never
 * mounted, and a full-control claim token re-printed to stdout on every boot.
 * So Finish is driven here end to end — and then a **second app is started on
 * the same data directory**, because "the live process flipped" and "the next
 * boot agrees" are two different claims and only the second one is the promise.
 *
 * **The restart trap.** Step 1 writes the operator record with two screens still
 * to go. If the state check read that record alone, a container restarting at
 * that moment would come back deciding it was claimed: every `/setup/*` path
 * 404, the claim token deleted as the litter of a configured instance, and the
 * operator locked out of steps 2 and 3 with no route back in. So a restart
 * mid-wizard is driven here for real — a second app on the same data directory —
 * rather than reasoned about.
 *
 * **The headers a browser actually sends.** Every screen is a same-origin form
 * POST, the exact shape that broke in 0.6.0: `Referrer-Policy: no-referrer` left
 * `isSameOrigin()` with neither `Origin` nor `Referer`, because Chrome sends no
 * `Origin` on a same-origin form POST, and 251 unit and 81 integration tests
 * missed it because every one of them set `Origin` explicitly. The helper used
 * here sends what Chrome sends — a `Referer` and nothing else — by default, and
 * `Origin` only where a test is about `Origin`.
 *
 * **Step 2 against a stubbed connector.** The mailbox itself is probed and
 * stored by the connector, which this package cannot import and does not run in
 * these suites. What is asserted here is the wizard's half of that conversation:
 * that it asks before it writes, that it refuses to write when the answer is a
 * failure, that it can be skipped without asking at all, and that the mailbox
 * password reaches the connector and nothing else. The upstream stub records
 * every request, which is how each of those is checked rather than assumed.
 *
 * That stub answers in JSON, in the shapes settings-api.ts declares. It used to
 * answer in HTML copied verbatim out of the connector's own renderer, under a
 * "change one, change both" rule that nothing enforced; #69 replaced the markup
 * with a contract, and this file's half of it is held up by the same types the
 * connector's integration suite holds its half up by.
 */

import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ASSERTION_HEADER } from "../../src/assertion.js";
import { verifyPassword } from "../../src/passwords.js";
import { SESSION_COOKIE } from "../../src/session.js";
import {
  ADDRESS_FIELD,
  flattenDraft,
  MAILBOX_FIELDS,
  MAILBOX_FIELD_NAMES,
  PROVIDER_FIELD,
  PROVIDER_OTHER,
  SHARED_PASSWORD_FIELD,
  type MailboxProbeReport,
  type MailboxRequestBody,
  type MailboxSuggestion,
  type ProviderPreset,
} from "../../src/settings-api.js";
import {
  getSetup,
  postSetupForm,
  setupBase,
  signInWith,
  startHarness,
  UPSTREAM_TOKEN,
  type Harness,
} from "../helpers/harness.js";

const USERNAME = "anna";
const PASSWORD = "a-password-nobody-guesses";
const MAILBOX_PASSWORD = "the-mailbox-password-itself";

function dataDir(): string {
  return mkdtempSync(join(tmpdir(), "oauth-wizard-flow-"));
}

interface StoredRecord {
  username: string;
  passwordHash: string;
}

function storedRecord(dir: string): StoredRecord {
  return JSON.parse(readFileSync(join(dir, "operator.json"), "utf8")) as StoredRecord;
}

/** Submit step 1 with the headers Chrome sends on a same-origin form POST. */
async function submitStep1(
  harness: Harness,
  fields: Partial<Record<"username" | "password" | "confirmation", string>> = {}
): Promise<Response> {
  return postSetupForm(harness, "/credentials", {
    username: USERNAME,
    password: PASSWORD,
    confirmation: PASSWORD,
    ...fields,
  });
}

test("the setup URL from the log reaches step 1 on a fresh instance", async () => {
  const harness = await startHarness({ unbootstrapped: true, dataDir: dataDir() });
  try {
    assert.ok(harness.setupUrl, "an unclaimed instance prints a setup URL");

    // Exactly what an operator does: paste the printed link and follow it.
    const res = await fetch(harness.setupUrl, { redirect: "follow" });

    assert.equal(res.status, 200);
    assert.equal(res.url, `${harness.setupUrl}/credentials`);
    const html = await res.text();
    assert.match(html, /Step 1 of 3 · Create the operator account/);
    assert.match(html, /Repeat password/);
  } finally {
    await harness.close();
  }
});

test("completing step 1 leaves a usable operator credential", async () => {
  const dir = dataDir();
  const harness = await startHarness({ unbootstrapped: true, dataDir: dir });
  try {
    const res = await submitStep1(harness);

    // 303, so a reload of step 2 does not re-submit a password.
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), `/setup/${harness.claimToken}/mailbox`);

    const record = storedRecord(dir);
    assert.equal(record.username, USERNAME);
    assert.equal(await verifyPassword(PASSWORD, record.passwordHash), true);
    assert.equal(await verifyPassword("not the password", record.passwordHash), false);
    assert.match(record.passwordHash, /^scrypt\$65536\$8\$1\$/, "the shipped cost parameters");
  } finally {
    await harness.close();
  }
});

test("that credential is the one the settings UI signs in with, once setup completes", async () => {
  // The end of the story step 1 starts: the wizard finishes, the token goes, the
  // next boot mounts the settings UI against the record written here.
  const dir = dataDir();
  const wizard = await startHarness({ unbootstrapped: true, dataDir: dir });
  assert.equal((await submitStep1(wizard)).status, 303);
  // What issue #24's Finish does, and the only thing it has left to do.
  await wizard.bootstrap.complete();
  await wizard.close();

  const claimed = await startHarness({ unbootstrapped: true, dataDir: dir });
  try {
    assert.equal(claimed.bootstrap.bootstrapped, true);

    const signedIn = await signInWith(claimed, USERNAME, PASSWORD);
    assert.equal(signedIn.status, 303);
    assert.match(signedIn.headers.get("set-cookie") ?? "", new RegExp(`^${SESSION_COOKIE}=`));

    const wrong = await signInWith(claimed, USERNAME, "not the password");
    assert.equal((wrong.headers.get("set-cookie") ?? "").includes(SESSION_COOKIE), false);
  } finally {
    await claimed.close();
  }
});

test("a restart mid-wizard keeps the token, the progress and the way to step 2", async () => {
  // The trap this issue is built around. Step 1 has written the operator record;
  // a container restarting here must not decide it is claimed.
  const dir = dataDir();
  const first = await startHarness({ unbootstrapped: true, dataDir: dir });
  assert.equal((await submitStep1(first)).status, 303);
  const token = first.claimToken;
  await first.close();

  const restarted = await startHarness({ unbootstrapped: true, dataDir: dir });
  try {
    assert.equal(restarted.bootstrap.bootstrapped, false, "still unclaimed: setup is unfinished");
    assert.equal(restarted.claimToken, token, "the same token, not a new one");
    assert.equal(existsSync(join(dir, "claim-token.txt")), true, "and it is still on disk");

    // The tab the operator left open on step 2 still works …
    assert.equal((await getSetup(restarted, "/mailbox")).status, 200);
    // … and the bare setup link resumes there rather than at step 1.
    const entry = await getSetup(restarted);
    assert.equal(entry.status, 302);
    assert.equal(entry.headers.get("location"), `/setup/${token}/mailbox`);

    // And the instance is still closed to everything else: an operator record
    // exists, but nobody has finished claiming the instance.
    assert.equal((await fetch(`${restarted.baseUrl}/mcp`, { method: "POST" })).status, 503);
    assert.equal((await fetch(`${restarted.baseUrl}/settings`)).status, 404);
  } finally {
    await restarted.close();
  }
});

test("a reload mid-wizard does not lose progress", async () => {
  const dir = dataDir();
  const harness = await startHarness({ unbootstrapped: true, dataDir: dir });
  try {
    assert.equal((await submitStep1(harness)).status, 303);

    // The reload the operator does: back to the link they were given.
    const entry = await getSetup(harness);
    assert.equal(entry.status, 302);
    assert.equal(entry.headers.get("location"), `/setup/${harness.claimToken}/mailbox`);

    // Step 1 is still reachable behind them — that is what Back is — and the
    // progress note on the volume holds the mark, not a secret.
    assert.equal((await getSetup(harness, "/credentials")).status, 200);
    const progress = JSON.parse(readFileSync(join(dir, "setup-wizard.json"), "utf8")) as Record<
      string,
      unknown
    >;
    assert.deepEqual(progress, { version: 1, furthest: "mailbox" });
    const raw = readFileSync(join(dir, "setup-wizard.json"), "utf8");
    assert.equal(raw.includes(PASSWORD), false, "no password anywhere near this file");
    assert.equal(raw.includes(USERNAME), false, "nor the username");
  } finally {
    await harness.close();
  }
});

test("a screen the operator has not reached yet cannot be jumped to", async () => {
  const harness = await startHarness({ unbootstrapped: true, dataDir: dataDir() });
  try {
    for (const step of ["/mailbox", "/connect"]) {
      const res = await getSetup(harness, step);
      assert.equal(res.status, 302, step);
      assert.equal(res.headers.get("location"), `/setup/${harness.claimToken}/credentials`, step);
    }
  } finally {
    await harness.close();
  }
});

test("weak or mistyped credentials are refused, and nothing is written", async () => {
  const dir = dataDir();
  const harness = await startHarness({ unbootstrapped: true, dataDir: dir });
  try {
    const cases: Array<[string, Record<string, string>, RegExp]> = [
      ["too short", { password: "short", confirmation: "short" }, /at least 12 characters/i],
      [
        "equal to the username",
        { username: "operatorpassword", password: "operatorpassword", confirmation: "operatorpassword" },
        /cannot be the same as the username/i,
      ],
      ["mistyped", { confirmation: `${PASSWORD}!` }, /do not match/i],
      ["no username", { username: "" }, /Enter a username/i],
    ];

    for (const [name, fields, expected] of cases) {
      const res = await submitStep1(harness, fields);
      assert.equal(res.status, 400, name);
      assert.match(await res.text(), expected, name);
      assert.equal(existsSync(join(dir, "operator.json")), false, name);
    }

    // And the wizard has not moved on.
    const entry = await getSetup(harness);
    assert.equal(entry.headers.get("location"), `/setup/${harness.claimToken}/credentials`);
  } finally {
    await harness.close();
  }
});

test("a rejected submission keeps the username but never echoes the password", async () => {
  const dir = dataDir();
  const harness = await startHarness({ unbootstrapped: true, dataDir: dir });
  try {
    const res = await submitStep1(harness, { confirmation: "" });
    const html = await res.text();

    assert.match(html, /value="anna"/);
    assert.equal(html.includes(PASSWORD), false, "a password is never rendered back");
  } finally {
    await harness.close();
  }
});

test("a cross-origin submission is refused and writes nothing", async () => {
  const dir = dataDir();
  const harness = await startHarness({ unbootstrapped: true, dataDir: dir });
  try {
    const res = await postSetupForm(
      harness,
      "/credentials",
      { username: USERNAME, password: PASSWORD, confirmation: PASSWORD },
      { headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example" } }
    );

    assert.equal(res.status, 403);
    assert.equal(existsSync(join(dir, "operator.json")), false);
  } finally {
    await harness.close();
  }
});

test("a submission with an Origin header is accepted too, since some browsers send one", async () => {
  const dir = dataDir();
  const harness = await startHarness({ unbootstrapped: true, dataDir: dir });
  try {
    const res = await postSetupForm(
      harness,
      "/credentials",
      { username: USERNAME, password: PASSWORD, confirmation: PASSWORD },
      {
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: harness.baseUrl,
        },
      }
    );

    assert.equal(res.status, 303);
    assert.equal(storedRecord(dir).username, USERNAME);
  } finally {
    await harness.close();
  }
});

test("the wizard page carries the headers a form POST depends on", async () => {
  // Referrer-Policy is the load-bearing one: with no-referrer, Chrome's
  // same-origin form POST would arrive with neither Origin nor Referer and every
  // submission in this wizard would be refused.
  const harness = await startHarness({ unbootstrapped: true });
  try {
    const res = await getSetup(harness, "/credentials");
    assert.equal(res.headers.get("referrer-policy"), "same-origin");
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(res.headers.get("x-frame-options"), "DENY");
    assert.match(res.headers.get("content-security-policy") ?? "", /form-action 'self'/);
  } finally {
    await harness.close();
  }
});

test("the wizard is only reachable with the claim token", async () => {
  const dir = dataDir();
  const harness = await startHarness({ unbootstrapped: true, dataDir: dir });
  try {
    const wrong = `${harness.baseUrl}/setup/not-the-token/credentials`;
    assert.equal((await fetch(wrong, { redirect: "manual" })).status, 404);

    const posted = await fetch(wrong, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", referer: wrong },
      body: new URLSearchParams({
        username: USERNAME,
        password: PASSWORD,
        confirmation: PASSWORD,
      }),
    });
    assert.equal(posted.status, 404);
    assert.equal(existsSync(join(dir, "operator.json")), false, "and it wrote nothing");
    // The real one is untouched by any of that.
    assert.equal((await fetch(`${setupBase(harness)}/credentials`)).status, 200);
  } finally {
    await harness.close();
  }
});

// ---- Step 2 — the first mailbox -------------------------------------------

/** What an operator types into step 2, under the connector's own field names. */
function mailboxFields(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    id: "main",
    label: "Main mailbox",
    default: "1",
    "mail.defaultFrom": "anna@example.com",
    "imap.host": "imap.example.com",
    "imap.port": "993",
    "imap.tls": "1",
    "imap.user": "anna@example.com",
    "imap.pass": MAILBOX_PASSWORD,
    "smtp.host": "smtp.example.com",
    "smtp.port": "465",
    "smtp.tls": "1",
    "smtp.user": "anna@example.com",
    "smtp.pass": MAILBOX_PASSWORD,
    ...overrides,
  };
}

/** What `GET /settings/mailboxes/new` reports before anything has been written. */
const STAMP_BEFORE = "412-1757000000000";
/** What an acknowledged write reports back. Nothing on this side reads it. */
const STAMP_AFTER = "530-1757000009999";

interface ConnectorBehaviour {
  probe?: MailboxProbeReport;
  /** Status for `POST /settings/mailboxes/test`. 200 unless a test says otherwise. */
  probeStatus?: number;
  probeBody?: unknown;
  /** Status for `POST /settings/mailboxes`. 201 is what a stored account looks like. */
  createStatus?: number;
  createBody?: unknown;
  /**
   * Answer the save with no answer at all.
   *
   * `"hang"` is the case issue #82 is about: the request is written, the
   * connector acts on it, and the wizard's 5-second budget runs out before the
   * response comes back. `"reset"` is the same branch reached in a fraction of
   * the time — the client sees a dropped connection rather than an abort, and
   * the wizard has exactly as little to go on either way. Tests that are not
   * about the budget itself use `"reset"` so the suite does not sit out five
   * seconds proving `AbortSignal.timeout` works.
   */
  createAnswer?: "hang" | "reset";
  /**
   * What `accounts.json` looks like once the save has arrived — the fact that
   * settles whether an unanswered save landed. Unchanged unless a test says so.
   */
  stampAfterCreate?: string;
  /** Status for `GET /settings/mailboxes/new` once the save has arrived. */
  newStatusAfterCreate?: number;
  /**
   * What `POST /settings/autoconfig` finds. `undefined` is the ordinary miss —
   * a domain that publishes nothing, which the connector reports as a 200 with
   * `suggestion: null` rather than as any kind of failure.
   */
  suggestion?: MailboxSuggestion;
  /** Status for the lookup. 200 unless a test is about a connector that is not. */
  autoconfigStatus?: number;
  autoconfigBody?: unknown;
  /** Drop the lookup's connection: the connector is there, then it is not. */
  autoconfigAnswer?: "reset";
  /** Status for `POST /settings/providers`. 200 unless a test says otherwise. */
  providersStatus?: number;
  providersBody?: unknown;
  /** Drop the provider list's connection, the way `autoconfigAnswer` does. */
  providersAnswer?: "reset";
}

/**
 * The provider table, as this stub answers for it.
 *
 * The real table is the connector's (`src/providers.ts`) since #141, and its
 * entries are pinned literal by literal in the connector's own
 * test/unit/providers.test.ts. What is being tested on this side of the hop is
 * that whatever the connector sends reaches the screens — the list, the caveats,
 * and the values on the form a chosen preset leads to — so this stub sends
 * Posteo's real documented values, including the CalDAV URL that carries the
 * local part and the port that is not 443.
 */
function stubPresets(email: string): ProviderPreset[] {
  const localPart = (email.split("@")[0] ?? "").toLowerCase();
  return [
    {
      id: "mailbox-org",
      label: "mailbox.org",
      note: "Log in with your main address, not an alias.",
      values: {
        [MAILBOX_FIELDS.mailDefaultFrom]: email,
        [MAILBOX_FIELDS.imapHost]: "imap.mailbox.org",
        [MAILBOX_FIELDS.imapPort]: "993",
        [MAILBOX_FIELDS.imapUser]: email,
        [MAILBOX_FIELDS.imapTls]: "1",
        [MAILBOX_FIELDS.smtpHost]: "smtp.mailbox.org",
        [MAILBOX_FIELDS.smtpPort]: "465",
        [MAILBOX_FIELDS.smtpUser]: email,
        [MAILBOX_FIELDS.smtpTls]: "1",
      },
    },
    {
      id: "posteo",
      label: "Posteo",
      note: "The server is posteo.de whatever your address ends in.",
      values: {
        [MAILBOX_FIELDS.mailDefaultFrom]: email,
        [MAILBOX_FIELDS.imapHost]: "posteo.de",
        [MAILBOX_FIELDS.imapPort]: "993",
        [MAILBOX_FIELDS.imapUser]: email,
        [MAILBOX_FIELDS.imapTls]: "1",
        [MAILBOX_FIELDS.smtpHost]: "posteo.de",
        [MAILBOX_FIELDS.smtpPort]: "465",
        [MAILBOX_FIELDS.smtpUser]: email,
        [MAILBOX_FIELDS.smtpTls]: "1",
        [MAILBOX_FIELDS.caldavUrl]: `https://posteo.de:8443/calendars/${localPart}/default`,
        [MAILBOX_FIELDS.caldavUser]: email,
      },
    },
  ];
}

/** The `email` out of a `{ _csrf, email }` request document, or "". */
function readEmail(body: string): string {
  try {
    const parsed = JSON.parse(body) as { email?: unknown };
    return typeof parsed.email === "string" ? parsed.email : "";
  } catch {
    return "";
  }
}

/**
 * Answer the three connector routes step 2 uses, and nothing else.
 *
 * In JSON, because that is what step 2 asks for now (#69). Every response goes
 * out as a document rather than a page, and the shapes are the ones
 * settings-api.ts declares — which is also what the connector's own integration
 * suite pins against the real routes, so the two halves of this conversation are
 * each held to the same contract from their own side.
 */
function stubConnector(harness: Harness, behaviour: ConnectorBehaviour = {}): void {
  let saveArrived = false;
  const json = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  harness.upstream.respondWith((req, res, requestBody) => {
    const url = req.url ?? "";
    if (req.method === "POST" && url === "/settings/providers") {
      if (behaviour.providersAnswer === "reset") {
        res.destroy();
        return;
      }
      const email = readEmail(requestBody);
      json(
        res,
        behaviour.providersStatus ?? 200,
        behaviour.providersBody ?? { providers: stubPresets(email) }
      );
      return;
    }
    if (req.method === "POST" && url === "/settings/autoconfig") {
      if (behaviour.autoconfigAnswer === "reset") {
        res.destroy();
        return;
      }
      json(
        res,
        behaviour.autoconfigStatus ?? 200,
        behaviour.autoconfigBody ?? { suggestion: behaviour.suggestion ?? null }
      );
      return;
    }
    if (req.method === "POST" && url === "/settings/mailboxes/test") {
      const status = behaviour.probeStatus ?? 200;
      json(
        res,
        status,
        behaviour.probeBody ?? {
          probe: behaviour.probe ?? { imap: { ok: true }, smtp: { ok: true }, caldav: null },
        }
      );
      return;
    }
    if (req.method === "GET" && url === "/settings/mailboxes/new") {
      const status = saveArrived ? (behaviour.newStatusAfterCreate ?? 200) : 200;
      if (status !== 200) {
        json(res, status, { message: "Service Unavailable", errors: {} });
        return;
      }
      const stamp = saveArrived ? (behaviour.stampAfterCreate ?? STAMP_BEFORE) : STAMP_BEFORE;
      json(res, 200, { stamp });
      return;
    }
    if (req.method === "POST" && url === "/settings/mailboxes") {
      saveArrived = true;
      // The stored-but-unacknowledged case: the account is written, and the
      // answer saying so never reaches the wizard.
      if (behaviour.createAnswer === "hang") return;
      if (behaviour.createAnswer === "reset") {
        res.destroy();
        return;
      }
      const status = behaviour.createStatus ?? 201;
      json(res, status, behaviour.createBody ?? { id: "main", stamp: STAMP_AFTER });
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not stubbed");
  });
}

/** How many times the wizard asked the connector what `accounts.json` looks like. */
function stampReads(harness: Harness): number {
  return harness.upstream.requests.filter((r) => r.url === "/settings/mailboxes/new").length;
}

/** Complete step 1, which is how step 2 becomes reachable at all. */
async function reachStep2(harness: Harness): Promise<void> {
  const res = await postSetupForm(harness, "/credentials", {
    username: USERNAME,
    password: PASSWORD,
    confirmation: PASSWORD,
  });
  assert.equal(res.status, 303, "step 1 completes");
}

function upstreamPosts(harness: Harness, url: string): number {
  return harness.upstream.requests.filter((r) => r.method === "POST" && r.url === url).length;
}

test("credentials that fail the probe are not saved", async () => {
  const harness = await startHarness({ unbootstrapped: true, dataDir: dataDir() });
  try {
    await reachStep2(harness);
    stubConnector(harness, {
      probe: {
        imap: { ok: false, message: "the server rejected these credentials" },
        smtp: { ok: true },
        caldav: null,
      },
    });

    const res = await postSetupForm(harness, "/mailbox", {
      ...mailboxFields(),
      _action: "save",
    });

    assert.equal(res.status, 400);
    const html = await res.text();
    assert.match(html, /the server rejected these credentials/);
    assert.match(html, /nothing was stored/i);
    // The probe ran; the write did not, and no stamp was even asked for.
    assert.equal(upstreamPosts(harness, "/settings/mailboxes/test"), 1);
    assert.equal(upstreamPosts(harness, "/settings/mailboxes"), 0);
    assert.equal(
      harness.upstream.requests.some((r) => r.url === "/settings/mailboxes/new"),
      false
    );
    // And the wizard has not moved on.
    const entry = await getSetup(harness);
    assert.equal(entry.headers.get("location"), `/setup/${harness.claimToken}/mailbox`);
  } finally {
    await harness.close();
  }
});

test("skipping reaches step 3 with no account configured", async () => {
  const dir = dataDir();
  const harness = await startHarness({ unbootstrapped: true, dataDir: dir });
  try {
    await reachStep2(harness);
    stubConnector(harness);

    const res = await postSetupForm(harness, "/mailbox", { _action: "skip" });

    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), `/setup/${harness.claimToken}/connect`);
    // Someone looking around first should not need mail credentials to hand:
    // the connector was not contacted at all.
    assert.deepEqual(harness.upstream.requests, []);
    assert.equal((await getSetup(harness, "/connect")).status, 200);
    assert.deepEqual(
      JSON.parse(readFileSync(join(dir, "setup-wizard.json"), "utf8")) as Record<string, unknown>,
      { version: 1, furthest: "connect" }
    );
  } finally {
    await harness.close();
  }
});

test("IMAP, SMTP and CalDAV are each reported separately", async () => {
  const harness = await startHarness({ unbootstrapped: true, dataDir: dataDir() });
  try {
    await reachStep2(harness);
    stubConnector(harness, {
      probe: {
        imap: { ok: true },
        smtp: { ok: false, message: "connect ECONNREFUSED" },
        caldav: { ok: false, message: "404 Not Found" },
      },
    });

    const res = await postSetupForm(harness, "/mailbox", {
      ...mailboxFields({ "caldav.url": "https://dav.example.com", "caldav.user": "anna" }),
      _action: "test",
    });

    assert.equal(res.status, 200);
    const html = await res.text();
    // Three services, three verdicts — not one pass/fail across the lot.
    assert.match(html, /<strong>IMAP<\/strong><span>ok<\/span>/);
    assert.match(html, /<strong>SMTP<\/strong><span>failed: connect ECONNREFUSED<\/span>/);
    assert.match(html, /<strong>CalDAV<\/strong><span>failed: 404 Not Found<\/span>/);
    // "Test connection" never stores anything, whatever it finds.
    assert.equal(upstreamPosts(harness, "/settings/mailboxes"), 0);
  } finally {
    await harness.close();
  }
});

test("CalDAV alone failing does not stop a working mailbox being saved", async () => {
  // CalDAV is optional in the account model. Treating it as fatal would lock out
  // every IMAP-only provider, which is most of them.
  const harness = await startHarness({ unbootstrapped: true, dataDir: dataDir() });
  try {
    await reachStep2(harness);
    stubConnector(harness, {
      probe: {
        imap: { ok: true },
        smtp: { ok: true },
        caldav: { ok: false, message: "404 Not Found" },
      },
    });

    const res = await postSetupForm(harness, "/mailbox", {
      ...mailboxFields({ "caldav.url": "https://dav.example.com", "caldav.user": "anna" }),
      _action: "save",
    });

    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), `/setup/${harness.claimToken}/connect`);
    assert.equal(upstreamPosts(harness, "/settings/mailboxes"), 1);
  } finally {
    await harness.close();
  }
});

test("a verified mailbox is probed first, then stored, with the credentials the connector expects", async () => {
  const dir = dataDir();
  const harness = await startHarness({ unbootstrapped: true, dataDir: dir });
  try {
    await reachStep2(harness);
    stubConnector(harness);

    // Every box filled in, CalDAV included, so the draft that goes over the
    // wire has to carry the whole vocabulary and not merely most of it.
    const res = await postSetupForm(harness, "/mailbox", {
      ...mailboxFields({
        "caldav.url": "https://dav.example.com",
        "caldav.user": "anna",
        "caldav.pass": MAILBOX_PASSWORD,
      }),
      _action: "save",
    });

    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), `/setup/${harness.claimToken}/connect`);

    // The order is the requirement: probe, read the stamp, then write.
    assert.deepEqual(
      harness.upstream.requests.map((r) => `${r.method} ${r.url}`),
      [
        "POST /settings/mailboxes/test",
        "GET /settings/mailboxes/new",
        "POST /settings/mailboxes",
      ]
    );

    for (const request of harness.upstream.requests) {
      // Both credentials the settings proxy carries, on every hop: the static
      // token the connector's bearer check wants, and an assertion bound to
      // this method and this path — the connector 401s on any other.
      assert.equal(request.headers.authorization, `Bearer ${UPSTREAM_TOKEN}`);
      const header = request.headers[ASSERTION_HEADER];
      assert.equal(typeof header, "string", ASSERTION_HEADER);
      const payload = JSON.parse(
        Buffer.from((header as string).split(".")[0], "base64url").toString("utf8")
      ) as Record<string, unknown>;
      assert.equal(payload.aud, "mail-mcp-settings");
      assert.equal(payload.iss, harness.config.issuer);
      assert.equal(payload.htm, request.method);
      assert.equal(payload.htu, request.url);
    }

    for (const request of harness.upstream.requests.filter((r) => r.method === "POST")) {
      // A JSON document, not a form. The connector answers these three routes
      // either way, and the wizard asks for the document because the alternative
      // was reading its own answers back out of rendered markup (#69).
      assert.equal(request.headers["content-type"], "application/json");
      assert.equal(request.headers.accept, "application/json");
    }

    const create = harness.upstream.requests[2];
    const body = JSON.parse(create.body) as MailboxRequestBody;
    assert.equal(body.mailbox.imap.pass, MAILBOX_PASSWORD);
    // What the operator typed, under every name the contract has — the request
    // half of #69, where a name only one package knew about used to be dropped
    // on the way over and reported back as "Required." for a filled-in box.
    for (const name of MAILBOX_FIELD_NAMES) {
      assert.ok(name in flattenDraft(body.mailbox), `the draft carries no ${name}`);
    }
    assert.equal(flattenDraft(body.mailbox)["mail.defaultFrom"], "anna@example.com");
    // The CSRF field the connector compares against is the assertion's own
    // claim: this hop has no browser and no cookie, only the two credentials.
    const createAssertion = JSON.parse(
      Buffer.from(String(create.headers[ASSERTION_HEADER]).split(".")[0], "base64url").toString(
        "utf8"
      )
    ) as { csrf: string };
    assert.equal(body._csrf, createAssertion.csrf);
    assert.equal(body._stamp, "412-1757000000000", "the stamp the connector just gave");

    // The wizard's own progress note still holds nothing but progress.
    const progress = readFileSync(join(dir, "setup-wizard.json"), "utf8");
    assert.deepEqual(JSON.parse(progress) as Record<string, unknown>, {
      version: 1,
      furthest: "connect",
    });
    assert.equal(progress.includes(MAILBOX_PASSWORD), false, "no mailbox password near it");
  } finally {
    await harness.close();
  }
});

test("a save the connector never answers is settled by the stamp, not called a failure", async () => {
  // Issue #82. The 5-second budget on the save aborts a request that has
  // already been written, so the connector may well have stored the mailbox and
  // simply not have answered in time. Every earlier build read that silence as
  // proof nothing happened and said so — and the retry it invited came back
  // "an account with id \"main\" already exists", blaming credentials that were
  // fine, about a mailbox that was already stored.
  const dir = dataDir();
  const harness = await startHarness({ unbootstrapped: true, dataDir: dir });
  try {
    await reachStep2(harness);
    stubConnector(harness, { createAnswer: "hang", stampAfterCreate: "530-1757000009999" });

    const res = await postSetupForm(harness, "/mailbox", {
      ...mailboxFields(),
      _action: "save",
    });

    // accounts.json moved under the only request writing to it. That is the
    // mailbox stored, and step 3 is where a stored mailbox leads.
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), `/setup/${harness.claimToken}/connect`);
    // Read once before the write and once to settle it — the second read is
    // the whole of the fix.
    assert.equal(stampReads(harness), 2);
    assert.deepEqual(
      JSON.parse(readFileSync(join(dir, "setup-wizard.json"), "utf8")) as Record<string, unknown>,
      { version: 1, furthest: "connect" }
    );
  } finally {
    await harness.close();
  }
});

test("a save that never landed still says plainly that nothing was stored", async () => {
  // The other half of the same check: an unchanged stamp means the write did
  // not happen, and the old message was true all along for this case.
  const harness = await startHarness({ unbootstrapped: true, dataDir: dataDir() });
  try {
    await reachStep2(harness);
    stubConnector(harness, { createAnswer: "reset" });

    const res = await postSetupForm(harness, "/mailbox", {
      ...mailboxFields(),
      _action: "save",
    });

    assert.equal(res.status, 502);
    assert.match(await res.text(), /Nothing was stored/);
    assert.equal(stampReads(harness), 2);
    // And the wizard has not moved on, because nothing was stored.
    const entry = await getSetup(harness);
    assert.equal(entry.headers.get("location"), `/setup/${harness.claimToken}/mailbox`);
  } finally {
    await harness.close();
  }
});

test("a save it cannot settle is reported as unknown rather than as a failure", async () => {
  // The connector drops the save and is then in no state to be asked what it
  // did with it. There is no fact to report here, and the one thing this screen
  // must not do is invent one in either direction.
  const harness = await startHarness({ unbootstrapped: true, dataDir: dataDir() });
  try {
    await reachStep2(harness);
    stubConnector(harness, { createAnswer: "reset", newStatusAfterCreate: 503 });

    const res = await postSetupForm(harness, "/mailbox", {
      ...mailboxFields(),
      _action: "save",
    });

    assert.equal(res.status, 502);
    const html = await res.text();
    assert.match(html, /may or may not have been saved/);
    // Not this. It is exactly the claim this build cannot make.
    assert.equal(/Nothing was stored/.test(html), false);
    // And the operator is told what a second attempt will do rather than being
    // left to invent a different ID.
    assert.match(html, /refused by its ID/);
    assert.equal(stampReads(harness), 2);
  } finally {
    await harness.close();
  }
});

test("a save the connector refuses does not blame the passwords for it", async () => {
  // A stored mailbox reached by a save this wizard never saw acknowledged comes
  // back as "an account with id … already exists" on the next attempt. That is
  // the connector's answer, and it belongs against the field it names — the
  // notice above it may not read as "your credentials were wrong".
  const harness = await startHarness({ unbootstrapped: true, dataDir: dataDir() });
  try {
    await reachStep2(harness);
    stubConnector(harness, {
      createStatus: 400,
      createBody: { errors: { id: 'An account with id "main" already exists.' } },
    });

    const res = await postSetupForm(harness, "/mailbox", {
      ...mailboxFields(),
      _action: "save",
    });

    assert.equal(res.status, 400);
    const html = await res.text();
    assert.match(html, /An account with id &quot;main&quot; already exists\./);
    assert.match(html, /refused to store these details/);
    assert.equal(/these details were refused/.test(html), false);
  } finally {
    await harness.close();
  }
});

test("a mailbox password is never written back into the page", async () => {
  const harness = await startHarness({ unbootstrapped: true, dataDir: dataDir() });
  try {
    await reachStep2(harness);
    stubConnector(harness, {
      probe: { imap: { ok: false, message: "no route to host" }, smtp: { ok: true }, caldav: null },
    });

    const res = await postSetupForm(harness, "/mailbox", {
      ...mailboxFields(),
      _action: "save",
    });
    const html = await res.text();

    // What was typed comes back, so a retry is not a retype of everything …
    assert.match(html, /value="imap\.example\.com"/);
    // … but the password does not, and the page says so rather than leaving the
    // operator to wonder why the box is empty.
    assert.equal(html.includes(MAILBOX_PASSWORD), false);
    assert.match(html, /Passwords are never written back/);
  } finally {
    await harness.close();
  }
});

test("the connector's own rejection is shown against the field it rejected", async () => {
  const harness = await startHarness({ unbootstrapped: true, dataDir: dataDir() });
  try {
    await reachStep2(harness);
    stubConnector(harness, {
      probeStatus: 400,
      probeBody: { errors: { id: 'An account with id "main" already exists.' } },
    });

    const res = await postSetupForm(harness, "/mailbox", {
      ...mailboxFields(),
      _action: "save",
    });

    assert.equal(res.status, 400);
    assert.match(await res.text(), /An account with id &quot;main&quot; already exists\./);
    assert.equal(upstreamPosts(harness, "/settings/mailboxes"), 0);
  } finally {
    await harness.close();
  }
});

test("an unreadable or refused answer saves nothing, rather than assuming it passed", async () => {
  const harness = await startHarness({ unbootstrapped: true, dataDir: dataDir() });
  try {
    await reachStep2(harness);

    // A connector that answers with something this build cannot read …
    stubConnector(harness, { probeBody: "<html><body>Bad Gateway</body></html>" });
    let res = await postSetupForm(harness, "/mailbox", { ...mailboxFields(), _action: "save" });
    assert.equal(res.status, 502);
    assert.match(await res.text(), /nothing was saved/i);

    // … and one that refuses the request outright.
    stubConnector(harness, { probeStatus: 401 });
    res = await postSetupForm(harness, "/mailbox", { ...mailboxFields(), _action: "save" });
    assert.equal(res.status, 502);
    assert.match(await res.text(), /HTTP 401/);

    assert.equal(upstreamPosts(harness, "/settings/mailboxes"), 0);
  } finally {
    await harness.close();
  }
});

test("a cross-origin step 2 submission is refused before the connector is touched", async () => {
  const harness = await startHarness({ unbootstrapped: true, dataDir: dataDir() });
  try {
    await reachStep2(harness);
    stubConnector(harness);

    const res = await postSetupForm(
      harness,
      "/mailbox",
      { ...mailboxFields(), _action: "save" },
      {
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: "https://evil.example",
        },
      }
    );

    assert.equal(res.status, 403);
    assert.deepEqual(harness.upstream.requests, []);
  } finally {
    await harness.close();
  }
});

test("step 2 cannot be posted to before step 1 is done", async () => {
  const harness = await startHarness({ unbootstrapped: true, dataDir: dataDir() });
  try {
    stubConnector(harness);

    const res = await postSetupForm(harness, "/mailbox", { ...mailboxFields(), _action: "save" });

    // 303, so the browser follows it with a GET rather than re-submitting.
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), `/setup/${harness.claimToken}/credentials`);
    assert.deepEqual(harness.upstream.requests, []);
  } finally {
    await harness.close();
  }
});

// ---- Step 3 — the MCP URL, PUBLIC_URL, and Finish -------------------------

/**
 * Answer the connector's `/health`, which is the only route step 3 uses.
 *
 * Step 3 asks it one question — which mailboxes are configured — because step 2
 * hands over identically whether it saved one or was skipped, and the completion
 * screen has to tell those apart.
 */
function stubHealth(harness: Harness, accounts: Array<{ id: string; label: string }>): void {
  harness.upstream.respondWith((req, res) => {
    if (req.method === "GET" && (req.url ?? "") === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", version: "0.6.3", accounts }));
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not stubbed");
  });
}

/** Complete step 1 and skip step 2, which is the shortest way to step 3. */
async function reachStep3(harness: Harness): Promise<void> {
  await reachStep2(harness);
  const skipped = await postSetupForm(harness, "/mailbox", { _action: "skip" });
  assert.equal(skipped.status, 303, "step 2 is skippable");
}

test("step 3 shows the MCP URL and asks about PUBLIC_URL", async () => {
  const harness = await startHarness({ unbootstrapped: true, dataDir: dataDir() });
  try {
    stubHealth(harness, [{ id: "main", label: "Main mailbox" }]);
    await reachStep3(harness);

    const res = await getSetup(harness, "/connect");
    assert.equal(res.status, 200);
    const html = await res.text();

    assert.match(html, /Step 3 of 3 · Connect Claude/);
    // The URL an operator pastes into claude.ai: PUBLIC_URL + MCP_PATH.
    assert.ok(
      html.includes(`value="${harness.config.resource}"`),
      "the MCP URL is on the page, ready to be copied"
    );
    // And the question the container cannot answer for itself.
    assert.match(html, /PUBLIC_URL/);
    assert.match(html, /name="public_url_ok" value="yes"/);
    assert.match(html, /name="public_url_ok" value="no"/);
    // No client-side JavaScript anywhere in this service, so no copy button.
    assert.equal(/<script/i.test(html), false);
    // A mailbox is configured on this instance, and the screen says which.
    assert.match(html, /Main mailbox/);

    // And in that order (#119): the address is derived from PUBLIC_URL, so an
    // operator working down the page must not be told to copy it into claude.ai
    // before being asked whether PUBLIC_URL is right. Offsets, not presence —
    // presence was true of the backwards page too.
    const question = html.indexOf('name="public_url_ok" value="yes"');
    const field = html.indexOf(`value="${harness.config.resource}"`);
    const copy = html.search(/copy it/i);
    assert.ok(question !== -1 && field !== -1 && copy !== -1, "all three are on the page");
    assert.ok(question < field, "the confirmation comes before the MCP URL");
    assert.ok(question < copy, "and before the instruction to copy it");
  } finally {
    await harness.close();
  }
});

test("step 3 tells a skipped step 2 from a saved one", async () => {
  const harness = await startHarness({ unbootstrapped: true, dataDir: dataDir() });
  try {
    // Both paths arrive here with furthest === "connect", so the screen has to
    // ask the connector rather than read the wizard's own progress note.
    stubHealth(harness, []);
    await reachStep3(harness);

    const html = await (await getSetup(harness, "/connect")).text();
    assert.match(html, /No mailbox is configured/i);
  } finally {
    await harness.close();
  }
});

test("a connector that does not answer does not block finishing", async () => {
  const harness = await startHarness({ unbootstrapped: true, dataDir: dataDir() });
  try {
    harness.upstream.respondWith((_req, res) => {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("down");
    });
    await reachStep3(harness);

    const html = await (await getSetup(harness, "/connect")).text();
    assert.match(html, /did not answer/i);
    assert.match(html, /does not stop you finishing/i);
  } finally {
    await harness.close();
  }
});

test("Finish claims the instance, and a restart still reads as bootstrapped", async () => {
  // The criterion the security review added. `isBootstrapped` wants both halves —
  // the operator record *and* the token's absence — and only complete() deletes
  // the token, so a Finish that flipped the live process but left the file would
  // hand the next boot a claimable instance and a setup URL in its log again.
  const dir = dataDir();
  const wizard = await startHarness({ unbootstrapped: true, dataDir: dir });
  const token = wizard.claimToken ?? "";
  try {
    stubHealth(wizard, [{ id: "main", label: "Main mailbox" }]);
    await reachStep3(wizard);

    const res = await postSetupForm(wizard, "/connect", { public_url_ok: "yes" });

    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Setup is complete/i);
    assert.ok(html.includes(wizard.config.resource), "the MCP URL is repeated on the last screen");

    // The live process: the token is gone from disk and from the object.
    assert.equal(existsSync(join(dir, "claim-token.txt")), false, "the token file is deleted");
    assert.equal(wizard.bootstrap.bootstrapped, true);
    assert.equal(wizard.bootstrap.setupUrl, null);

    // /mcp answers, and every /setup path is shut.
    const mcp = await fetch(`${wizard.baseUrl}/mcp`, { method: "POST" });
    assert.equal(mcp.status, 401, "a live endpoint again, not 503 not_configured");
    assert.match(mcp.headers.get("www-authenticate") ?? "", /Bearer/);
    assert.equal((await getSetup(wizard, "/connect")).status, 404);
  } finally {
    await wizard.close();
  }

  // The restart. Same data directory, second process, nothing else carried over.
  const restarted = await startHarness({ unbootstrapped: true, dataDir: dir });
  try {
    assert.equal(restarted.bootstrap.bootstrapped, true, "still claimed after a restart");
    assert.equal(restarted.bootstrap.setupUrl, null, "and no setup URL is printed again");
    assert.equal(existsSync(join(dir, "claim-token.txt")), false, "no token is minted again");

    assert.equal((await fetch(`${restarted.baseUrl}/mcp`, { method: "POST" })).status, 401);
    for (const path of ["", "/credentials", "/mailbox", "/connect", "/not-a-step"]) {
      const res = await fetch(`${restarted.baseUrl}/setup/${token}${path}`, { redirect: "manual" });
      assert.equal(res.status, 404, `/setup/<token>${path}`);
    }
  } finally {
    await restarted.close();
  }
});

test("every /setup path afterwards is the same 404 a wrong token gets, byte for byte", async () => {
  const harness = await startHarness({ unbootstrapped: true, dataDir: dataDir() });
  try {
    const token = harness.claimToken ?? "";
    stubHealth(harness, []);

    // What a wrong token gets while the instance is still claimable — the
    // reference answer the claimed instance has to match. The body echoes the
    // path the caller already knows and is otherwise the same object from the
    // same responder, so that is what is compared.
    const wrong = await fetch(`${harness.baseUrl}/setup/not-the-token/connect`, {
      redirect: "manual",
    });
    assert.equal(wrong.status, 404);

    await reachStep3(harness);
    assert.equal((await postSetupForm(harness, "/connect", { public_url_ok: "yes" })).status, 200);

    const after = await fetch(`${harness.baseUrl}/setup/${token}/connect`, { redirect: "manual" });
    assert.equal(after.status, 404);
    assert.equal(after.headers.get("content-type"), wrong.headers.get("content-type"));
    assert.deepEqual(Object.keys((await after.json()) as object), ["error", "message"]);

    // And the token that used to work is now indistinguishable from one that
    // never did: same status, same headers, same shape.
    const stillWrong = await fetch(`${harness.baseUrl}/setup/not-the-token/connect`, {
      redirect: "manual",
    });
    assert.equal(stillWrong.status, 404);
    assert.equal(stillWrong.headers.get("content-type"), after.headers.get("content-type"));
  } finally {
    await harness.close();
  }
});

test("answering No explains PUBLIC_URL and leaves the wizard exactly where it was", async () => {
  const dir = dataDir();
  const harness = await startHarness({ unbootstrapped: true, dataDir: dir });
  try {
    stubHealth(harness, []);
    await reachStep3(harness);

    const res = await postSetupForm(harness, "/connect", { public_url_ok: "no" });

    assert.equal(res.status, 200);
    const html = await res.text();
    // It cannot be edited from a browser, so the screen says what to change instead.
    assert.match(html, /PUBLIC_URL=/);
    assert.match(html, /cannot be changed from here/i);
    // And it says it before handing over the address built from the wrong value,
    // which is the whole point of asking first (#119).
    const help = html.search(/cannot be changed from here/i);
    const field = html.indexOf(`value="${harness.config.resource}"`);
    assert.ok(field !== -1, "the MCP URL is still on the page");
    assert.ok(help < field, "the fix comes before the address derived from the bad one");
    // Nothing was claimed: the token is still live and the link still works.
    assert.equal(existsSync(join(dir, "claim-token.txt")), true);
    assert.equal(harness.bootstrap.bootstrapped, false);
    assert.equal((await getSetup(harness, "/connect")).status, 200);
  } finally {
    await harness.close();
  }
});

test("Finish without an answer refuses, and claims nothing", async () => {
  const dir = dataDir();
  const harness = await startHarness({ unbootstrapped: true, dataDir: dir });
  try {
    stubHealth(harness, []);
    await reachStep3(harness);

    const res = await postSetupForm(harness, "/connect", {});

    assert.equal(res.status, 400);
    assert.match(await res.text(), /before finishing/i);
    assert.equal(existsSync(join(dir, "claim-token.txt")), true);
    assert.equal(harness.bootstrap.bootstrapped, false);
  } finally {
    await harness.close();
  }
});

test("a cross-origin Finish is refused and claims nothing", async () => {
  const dir = dataDir();
  const harness = await startHarness({ unbootstrapped: true, dataDir: dir });
  try {
    stubHealth(harness, []);
    await reachStep3(harness);

    const res = await postSetupForm(
      harness,
      "/connect",
      { public_url_ok: "yes" },
      {
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: "https://evil.example",
        },
      }
    );

    assert.equal(res.status, 403);
    assert.equal(existsSync(join(dir, "claim-token.txt")), true, "the token is still live");
    assert.equal(harness.bootstrap.bootstrapped, false);
  } finally {
    await harness.close();
  }
});

test("step 3 cannot be posted to before step 2 has been reached", async () => {
  const dir = dataDir();
  const harness = await startHarness({ unbootstrapped: true, dataDir: dir });
  try {
    const res = await postSetupForm(harness, "/connect", { public_url_ok: "yes" });

    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), `/setup/${harness.claimToken}/credentials`);
    assert.equal(existsSync(join(dir, "claim-token.txt")), true);
    assert.equal(harness.bootstrap.bootstrapped, false);
  } finally {
    await harness.close();
  }
});

test("a claim token that cannot be deleted is reported, and nothing is claimed", async () => {
  // The partial failure the review asked about: the operator record is written,
  // the token is not deleted. complete() throws rather than flipping the state,
  // and the operator has to be told something they can act on — not a dead end.
  const dir = dataDir();
  const harness = await startHarness({ unbootstrapped: true, dataDir: dir });
  try {
    stubHealth(harness, []);
    await reachStep3(harness);

    // Stand in for a read-only volume: replace the token file with a directory,
    // which unlink refuses with something other than ENOENT.
    const tokenFile = join(dir, "claim-token.txt");
    rmSync(tokenFile);
    mkdirSync(tokenFile);

    const res = await postSetupForm(harness, "/connect", { public_url_ok: "yes" });

    assert.equal(res.status, 500);
    const html = await res.text();
    assert.match(html, /claim-token\.txt/, "the file that has to go is named");
    assert.match(html, /still unclaimed/i);
    assert.match(html, /Finish/, "and the button to press again is still on the page");
    // The state did not flip on a half-done claim.
    assert.equal(harness.bootstrap.bootstrapped, false);
    assert.equal((await fetch(`${harness.baseUrl}/mcp`, { method: "POST" })).status, 503);
  } finally {
    await harness.close();
  }
});

// ---- Step 2's cascade, end to end -----------------------------------------
//
// Tiers 1 and 2 in front of the form step 2 used to be. What is asserted here is
// the handing off: which screen a request lands on, what reached the connector
// on the way, and — the §7 rule that is easiest to break by accident — that a
// lookup which finds nothing produces a screen with no failure on it.
//
// The lookup itself is the connector's, and its rules (HTTPS only, refuse
// private addresses after resolving, one redirect, 3 s an attempt and 10 s for
// the cascade, a capped body) are exercised against fixtures in the connector's
// own test/unit/autoconfig.test.ts. This package cannot import that module and
// does not try to: what it owns is the conversation, and the stub is what makes
// each half of it visible.

/** What the connector reports for a domain that publishes its own settings. */
function suggestionFor(overrides: Partial<MailboxSuggestion> = {}): MailboxSuggestion {
  return {
    email: "anna@example.com",
    domain: "example.com",
    source: "autoconfig-subdomain",
    imap: {
      host: "imap.example.com",
      port: 993,
      tls: true,
      socketType: "SSL",
      user: "anna@example.com",
    },
    smtp: {
      host: "smtp.example.com",
      port: 465,
      tls: true,
      socketType: "SSL",
      user: "anna@example.com",
    },
    caldav: null,
    ...overrides,
  };
}

function lookups(harness: Harness): number {
  return upstreamPosts(harness, "/settings/autoconfig");
}

/**
 * Every hidden input on a screen, as the browser would submit them.
 *
 * Read out of the page rather than assembled from what the test knows, because
 * what a screen carries onward is exactly the thing these tests are about: a
 * value shown but not carried, or typed but not carried, is invisible to any
 * assertion built from the fixture instead of from the HTML.
 */
function hiddenFields(html: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const match of html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) {
    fields[match[1]] = match[2];
  }
  return fields;
}

test("step 2 opens on the address, not on eighteen boxes", async () => {
  const harness = await startHarness({ unbootstrapped: true, dataDir: dataDir() });
  try {
    await reachStep2(harness);
    stubConnector(harness);

    const res = await getSetup(harness, "/mailbox");
    assert.equal(res.status, 200);
    const html = await res.text();

    assert.match(html, /Step 2 of 3 · Add your first mailbox/);
    assert.match(html, new RegExp(`name="${ADDRESS_FIELD}"`));
    assert.match(html, new RegExp(`name="${SHARED_PASSWORD_FIELD}"`));
    // The full form is the fallback now, not the front door.
    assert.equal(html.includes(`name="${MAILBOX_FIELDS.imapHost}"`), false);
    // And nothing was contacted merely by looking at the screen.
    assert.equal(harness.upstream.requests.length, 0);
  } finally {
    await harness.close();
  }
});

test("the wizard reads the provider table off the connector, not out of itself", async () => {
  // #141 moved the table into the connector, where the settings UI can read it
  // as a function call — so tier 2 is one more question over the hop the probe,
  // the write, the stamp and the lookup already go over. What this pins is that
  // the wizard renders *what it was sent*, rather than a copy of its own.
  const harness = await startHarness({ unbootstrapped: true, dataDir: dataDir() });
  try {
    await reachStep2(harness);
    stubConnector(harness, {
      providersBody: {
        providers: [
          { id: "invented", label: "A provider from the connector", note: "Says so.", values: {} },
        ],
      },
    });

    const res = await getSetup(harness, "/mailbox?view=providers");
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /value="invented"/);
    assert.match(html, /A provider from the connector/);
    assert.deepEqual(
      harness.upstream.requests.map((r) => `${r.method} ${r.url}`),
      ["POST /settings/providers"]
    );
  } finally {
    await harness.close();
  }
});

test("a provider list the connector will not give falls to the form, never to a dead end", async () => {
  // The same shape of degradation the lookup has: a tier that cannot be shown
  // hands over to the tier below rather than rendering an empty fieldset. It is
  // not reported as a failure either — the operator can finish from the form,
  // which is what they would have reached from the link anyway.
  const harness = await startHarness({ unbootstrapped: true, dataDir: dataDir() });
  try {
    await reachStep2(harness);
    stubConnector(harness, { providersAnswer: "reset" });

    const res = await getSetup(harness, "/mailbox?view=providers");
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, new RegExp(`name="${MAILBOX_FIELDS.imapHost}"`));
    assert.equal(/class="error"/.test(html), false, html);
  } finally {
    await harness.close();
  }
});

test("a lookup that found nothing still reaches a usable screen with no table to show", async () => {
  const harness = await startHarness({ unbootstrapped: true, dataDir: dataDir() });
  try {
    await reachStep2(harness);
    stubConnector(harness, { providersStatus: 503, providersBody: { message: "nope" } });

    const res = await postSetupForm(harness, "/mailbox", {
      [ADDRESS_FIELD]: "anna@example.com",
      [SHARED_PASSWORD_FIELD]: "hunter2",
      _action: "lookup",
    });

    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, new RegExp(`name="${MAILBOX_FIELDS.imapHost}"`));
    // #120 survives the fallback: the password is still in the boxes that will
    // send it, rather than being asked for a second time.
    assert.match(html, /value="hunter2"/);
  } finally {
    await harness.close();
  }
});

test("the other two tiers are reachable at any time, by URL", async () => {
  const harness = await startHarness({ unbootstrapped: true, dataDir: dataDir() });
  try {
    await reachStep2(harness);
    stubConnector(harness);

    const providers = await getSetup(harness, "/mailbox?view=providers");
    assert.equal(providers.status, 200);
    const providerHtml = await providers.text();
    assert.match(providerHtml, /value="mailbox-org"/);
    assert.match(providerHtml, new RegExp(`value="${PROVIDER_OTHER}"`));

    const manual = await getSetup(harness, "/mailbox?view=manual");
    assert.equal(manual.status, 200);
    const manualHtml = await manual.text();
    // Tier 3 unchanged: every field the contract names that this screen has
    // always rendered. The three `mail.*` defaults stay the connector's
    // business, as they were before this cascade existed.
    for (const name of MAILBOX_FIELD_NAMES) {
      if (name.startsWith("mail.") && name !== MAILBOX_FIELDS.mailDefaultFrom) continue;
      assert.ok(manualHtml.includes(`name="${name}"`), `the full form lost ${name}`);
    }

    // A view nobody wrote is tier 1, not a 404 and not the long form.
    const nonsense = await getSetup(harness, "/mailbox?view=whatever");
    assert.equal(nonsense.status, 200);
    assert.match(await nonsense.text(), new RegExp(`name="${ADDRESS_FIELD}"`));
  } finally {
    await harness.close();
  }
});

test("a domain that publishes its settings gets a confirmation screen, not a save", async () => {
  const harness = await startHarness({ unbootstrapped: true, dataDir: dataDir() });
  try {
    await reachStep2(harness);
    stubConnector(harness, {
      suggestion: suggestionFor({
        caldav: {
          url: "https://dav.example.com/",
          user: "anna@example.com",
          source: "well-known",
        },
      }),
    });

    const res = await postSetupForm(harness, "/mailbox", {
      [ADDRESS_FIELD]: "anna@example.com",
      [SHARED_PASSWORD_FIELD]: MAILBOX_PASSWORD,
      _action: "lookup",
    });

    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Found settings for example\.com/);
    assert.match(html, /imap\.example\.com:993/);
    assert.match(html, /smtp\.example\.com:465/);
    assert.match(html, /https:\/\/dav\.example\.com\//);

    // Shown, never applied: one call went out, and it was the lookup. Nothing
    // was probed and nothing was written, so a wrong answer costs a glance.
    assert.deepEqual(
      harness.upstream.requests.map((r) => `${r.method} ${r.url}`),
      ["POST /settings/autoconfig"]
    );
    // And the address went over on its own — the password stays on this side
    // until there is a server to send it to.
    const body = JSON.parse(harness.upstream.requests[0].body) as Record<string, unknown>;
    assert.equal(body.email, "anna@example.com");
    assert.equal(harness.upstream.requests[0].body.includes(MAILBOX_PASSWORD), false);
  } finally {
    await harness.close();
  }
});

test("a lookup that finds nothing shows the provider list and calls it no failure", async () => {
  // §7: the whole cascade is best-effort, any failure falls through to tier 2,
  // and no autoconfig failure is ever shown to the operator as an error.
  const harness = await startHarness({ unbootstrapped: true, dataDir: dataDir() });
  try {
    await reachStep2(harness);
    stubConnector(harness);

    const res = await postSetupForm(harness, "/mailbox", {
      [ADDRESS_FIELD]: "anna@example.com",
      [SHARED_PASSWORD_FIELD]: MAILBOX_PASSWORD,
      _action: "lookup",
    });

    assert.equal(res.status, 200, "a miss is not an error status either");
    const html = await res.text();
    assert.match(html, /We could not detect settings for example\.com/);
    assert.match(html, /value="mailbox-org"/);
    // The address is carried over, so it is typed once rather than once a tier.
    assert.match(html, /value="anna@example\.com"/);
    assert.equal(lookups(harness), 1);

    const body = html.slice(html.indexOf("</style>"));
    assert.equal(/\bfailed\b|\berror\b|class="error"/i.test(body), false, body);
  } finally {
    await harness.close();
  }
});

test("every way the lookup can go wrong falls through to the same screen", async () => {
  // A connector that drops the connection, one that refuses, and one on a
  // release whose answer this build cannot read. All three are indistinguishable
  // from "this domain publishes nothing", which is the §7 contract: the operator
  // cannot act on the difference and is not shown it.
  for (const behaviour of [
    { autoconfigAnswer: "reset" as const },
    { autoconfigStatus: 503, autoconfigBody: { message: "Service Unavailable", errors: {} } },
    { autoconfigBody: { suggestion: { imap: "half a suggestion" } } },
  ]) {
    const harness = await startHarness({ unbootstrapped: true, dataDir: dataDir() });
    try {
      await reachStep2(harness);
      stubConnector(harness, behaviour);

      const res = await postSetupForm(harness, "/mailbox", {
        [ADDRESS_FIELD]: "anna@example.com",
        [SHARED_PASSWORD_FIELD]: MAILBOX_PASSWORD,
        _action: "lookup",
      });

      assert.equal(res.status, 200, JSON.stringify(behaviour));
      const html = await res.text();
      assert.match(html, /We could not detect settings for example\.com/);
      const body = html.slice(html.indexOf("</style>"));
      assert.equal(/\bfailed\b|\berror\b|class="error"/i.test(body), false, JSON.stringify(behaviour));
    } finally {
      await harness.close();
    }
  }
});

test("an address that is not one is rejected here, before anything is looked up", async () => {
  // This is not an autoconfig failure and is not treated as one: it is about
  // what the operator typed, which they can see and fix. Nothing leaves the
  // process for it — an address with no domain is also the shape that would
  // turn the lookup into a scan of the connector's own network.
  const harness = await startHarness({ unbootstrapped: true, dataDir: dataDir() });
  try {
    await reachStep2(harness);
    stubConnector(harness);

    for (const email of ["", "anna", "anna@", "@example.com"]) {
      const res = await postSetupForm(harness, "/mailbox", {
        [ADDRESS_FIELD]: email,
        [SHARED_PASSWORD_FIELD]: MAILBOX_PASSWORD,
        _action: "lookup",
      });
      assert.equal(res.status, 400, JSON.stringify(email));
      assert.match(await res.text(), /Enter a full email address/);
    }
    assert.equal(lookups(harness), 0, "an unusable address was still sent to the connector");
  } finally {
    await harness.close();
  }
});

test("Continue on the confirmation screen probes and stores what was shown", async () => {
  const harness = await startHarness({ unbootstrapped: true, dataDir: dataDir() });
  try {
    await reachStep2(harness);
    stubConnector(harness, { suggestion: suggestionFor() });

    const found = await postSetupForm(harness, "/mailbox", {
      [ADDRESS_FIELD]: "anna@example.com",
      [SHARED_PASSWORD_FIELD]: MAILBOX_PASSWORD,
      _action: "lookup",
    });
    const html = await found.text();

    // Submit exactly what the confirmation screen carries and nothing else —
    // the hidden fields, read straight back out of the page. The password is
    // among them, which is the whole of #120: the operator typed it on the
    // address screen and this submission is the one they made by pressing
    // Continue, not a second round of typing.
    const hidden = hiddenFields(html);
    assert.ok(Object.keys(hidden).length > 0, "the confirmation screen carried nothing");

    const res = await postSetupForm(harness, "/mailbox", { ...hidden, _action: "save" });

    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), `/setup/${harness.claimToken}/connect`);
    assert.deepEqual(
      harness.upstream.requests.map((r) => `${r.method} ${r.url}`),
      [
        "POST /settings/autoconfig",
        "POST /settings/mailboxes/test",
        "GET /settings/mailboxes/new",
        "POST /settings/mailboxes",
      ]
    );

    // The one password the screen asked for reaches both services. A screen
    // with two boxes cannot express a mailbox whose IMAP and SMTP logins take
    // different passwords, and the full form is where that case is expressed.
    const create = harness.upstream.requests[3];
    const body = JSON.parse(create.body) as MailboxRequestBody;
    assert.equal(body.mailbox.imap.pass, MAILBOX_PASSWORD);
    assert.equal(body.mailbox.smtp.pass, MAILBOX_PASSWORD);
    // And the settings the operator confirmed are the settings that were sent.
    assert.equal(body.mailbox.imap.host, "imap.example.com");
    assert.equal(body.mailbox.imap.port, "993");
    assert.equal(body.mailbox.imap.tls, true);
    assert.equal(body.mailbox.smtp.host, "smtp.example.com");
    assert.equal(body.mailbox.mail.defaultFrom, "anna@example.com");
    // No CalDAV was found, so none is claimed — not an empty block that would
    // probe a server nobody named.
    assert.equal(body.mailbox.caldav, null);
  } finally {
    await harness.close();
  }
});

test("a found CalDAV endpoint is stored with the same password, and only then", async () => {
  const harness = await startHarness({ unbootstrapped: true, dataDir: dataDir() });
  try {
    await reachStep2(harness);
    stubConnector(harness, {
      suggestion: suggestionFor({
        caldav: { url: "https://dav.example.com/", user: "anna@example.com", source: "dns-srv" },
      }),
    });

    const found = await postSetupForm(harness, "/mailbox", {
      [ADDRESS_FIELD]: "anna@example.com",
      [SHARED_PASSWORD_FIELD]: MAILBOX_PASSWORD,
      _action: "lookup",
    });
    const hidden = hiddenFields(await found.text());

    const res = await postSetupForm(harness, "/mailbox", { ...hidden, _action: "save" });
    assert.equal(res.status, 303);

    const body = JSON.parse(harness.upstream.requests[3].body) as MailboxRequestBody;
    assert.deepEqual(body.mailbox.caldav, {
      url: "https://dav.example.com/",
      user: "anna@example.com",
      pass: MAILBOX_PASSWORD,
    });
  } finally {
    await harness.close();
  }
});

test("the password typed on the address screen is not asked for a second time", async () => {
  // #120, end to end. One password, typed once on the screen that asks for it,
  // carried through the lookup in the form the operator is already looking at —
  // and still nowhere near the wizard's state file.
  const dir = dataDir();
  const harness = await startHarness({ unbootstrapped: true, dataDir: dir });
  try {
    await reachStep2(harness);
    stubConnector(harness, { suggestion: suggestionFor() });

    const found = await postSetupForm(harness, "/mailbox", {
      [ADDRESS_FIELD]: "anna@example.com",
      [SHARED_PASSWORD_FIELD]: MAILBOX_PASSWORD,
      _action: "lookup",
    });
    assert.equal(found.status, 200);
    const confirmation = await found.text();

    // Carried, not re-asked: no second password box on the confirmation screen,
    // and the value travelling in the form Continue submits.
    assert.equal(
      hiddenFields(confirmation)[SHARED_PASSWORD_FIELD],
      MAILBOX_PASSWORD,
      "the confirmation screen dropped the password"
    );
    assert.equal(
      /type="password"/.test(confirmation),
      false,
      "the confirmation screen still asks for the password"
    );
    // And it says so, rather than carrying it invisibly: an operator who cannot
    // see the value has no other way to know why the next screen is filled in.
    assert.match(confirmation, /carried/i);

    // Edit these — the one route from a successful lookup to the full form.
    const edited = await postSetupForm(harness, "/mailbox", {
      ...hiddenFields(confirmation),
      _action: "edit",
    });
    assert.equal(edited.status, 200);
    const form = await edited.text();

    for (const name of [MAILBOX_FIELDS.imapPass, MAILBOX_FIELDS.smtpPass]) {
      assert.ok(
        form.includes(`name="${name}" type="password" value="${MAILBOX_PASSWORD}"`),
        `the full form asks for ${name} again`
      );
    }
    assert.match(form, /carried over/i);
    assert.equal(lookups(harness), 1, "nothing but the lookup was contacted");
    assert.equal(harness.upstream.requests.length, 1);

    // The state file is the thing this must not have bought: progress and a
    // version, and no secret anywhere near it — #23's rule, unweakened.
    const state = readFileSync(join(dir, "setup-wizard.json"), "utf8");
    assert.deepEqual(JSON.parse(state) as Record<string, unknown>, {
      version: 1,
      furthest: "mailbox",
    });
    assert.equal(state.includes(MAILBOX_PASSWORD), false);
  } finally {
    await harness.close();
  }
});

test("a lookup that finds nothing carries the password on to tier 2 as well", async () => {
  // Tier 2 is reached two ways, and only one of them has a password to carry.
  // From the lookup it does — the operator typed one on the address screen a
  // moment ago — and dropping it there is the same bug in the other branch.
  const harness = await startHarness({ unbootstrapped: true, dataDir: dataDir() });
  try {
    await reachStep2(harness);
    stubConnector(harness);

    const missed = await postSetupForm(harness, "/mailbox", {
      [ADDRESS_FIELD]: "anna@example.com",
      [SHARED_PASSWORD_FIELD]: MAILBOX_PASSWORD,
      _action: "lookup",
    });
    const list = await missed.text();
    assert.match(list, /We could not detect settings for example\.com/);
    assert.equal(hiddenFields(list)[SHARED_PASSWORD_FIELD], MAILBOX_PASSWORD);

    const chosen = await postSetupForm(harness, "/mailbox", {
      ...hiddenFields(list),
      [ADDRESS_FIELD]: "anna@example.com",
      [PROVIDER_FIELD]: "posteo",
      _action: "provider",
    });
    assert.equal(chosen.status, 200);
    const form = await chosen.text();

    for (const name of [MAILBOX_FIELDS.imapPass, MAILBOX_FIELDS.smtpPass]) {
      assert.ok(
        form.includes(`name="${name}" type="password" value="${MAILBOX_PASSWORD}"`),
        `the full form asks for ${name} again`
      );
    }
    // Posteo's preset names a CalDAV URL, so the password goes with it — the
    // same rule the save path applies, and for the same reason.
    assert.ok(
      form.includes(`name="${MAILBOX_FIELDS.caldavPass}" type="password" value="${MAILBOX_PASSWORD}"`)
    );

    // The provider list reached from its own link has no password to carry, and
    // does not pretend to: the full form is where it gets typed on that route.
    const fromLink = await getSetup(harness, "/mailbox?view=providers");
    assert.equal(/name="password"/.test(await fromLink.text()), false);
  } finally {
    await harness.close();
  }
});

test("Edit these hands the same settings to the full form, with the password", async () => {
  const harness = await startHarness({ unbootstrapped: true, dataDir: dataDir() });
  try {
    await reachStep2(harness);
    stubConnector(harness, { suggestion: suggestionFor() });

    const res = await postSetupForm(harness, "/mailbox", {
      [MAILBOX_FIELDS.id]: "main",
      [MAILBOX_FIELDS.label]: "Main mailbox",
      [ADDRESS_FIELD]: "anna@example.com",
      [MAILBOX_FIELDS.imapHost]: "imap.example.com",
      [MAILBOX_FIELDS.imapPort]: "993",
      [MAILBOX_FIELDS.imapUser]: "anna@example.com",
      [MAILBOX_FIELDS.imapTls]: "1",
      [MAILBOX_FIELDS.smtpHost]: "smtp.example.com",
      [MAILBOX_FIELDS.smtpPort]: "465",
      [MAILBOX_FIELDS.smtpUser]: "anna@example.com",
      [MAILBOX_FIELDS.smtpTls]: "1",
      [SHARED_PASSWORD_FIELD]: MAILBOX_PASSWORD,
      _action: "edit",
    });

    assert.equal(res.status, 200);
    const html = await res.text();
    // Tier 3, with the values in it.
    for (const name of MAILBOX_FIELD_NAMES) {
      if (name.startsWith("mail.") && name !== MAILBOX_FIELDS.mailDefaultFrom) continue;
      assert.ok(html.includes(`name="${name}"`), `the full form lost ${name}`);
    }
    assert.match(html, /value="imap\.example\.com"/);
    assert.match(html, /value="993"/);
    // The password comes with them. It is not read back out of anything — it is
    // the value the operator typed two screens ago, travelling in the form they
    // are still filling in, and asking for it again here is #120.
    assert.ok(html.includes(`name="${MAILBOX_FIELDS.imapPass}" type="password" value="${MAILBOX_PASSWORD}"`));
    assert.ok(html.includes(`name="${MAILBOX_FIELDS.smtpPass}" type="password" value="${MAILBOX_PASSWORD}"`));
    // No CalDAV URL was confirmed, so no CalDAV password is guessed at: a block
    // that is nothing but a password probes a server nobody named.
    assert.ok(html.includes(`name="${MAILBOX_FIELDS.caldavPass}" type="password" value=""`));
    // Nothing was contacted.
    assert.equal(harness.upstream.requests.length, 0);
  } finally {
    await harness.close();
  }
});

test("choosing a provider fills the full form in rather than saving behind the operator", async () => {
  const harness = await startHarness({ unbootstrapped: true, dataDir: dataDir() });
  try {
    await reachStep2(harness);
    stubConnector(harness);

    const res = await postSetupForm(harness, "/mailbox", {
      [ADDRESS_FIELD]: "anna@posteo.net",
      [PROVIDER_FIELD]: "posteo",
      _action: "provider",
    });

    assert.equal(res.status, 200);
    const html = await res.text();
    // The values are the reason to pick a provider, and this is the only screen
    // that shows them — including the ones a reader would have guessed wrong.
    assert.match(html, /value="posteo\.de"/);
    assert.match(html, /value="993"/);
    assert.match(html, /value="465"/);
    assert.match(html, /https:\/\/posteo\.de:8443\/calendars\/anna\/default/);
    assert.match(html, /Posteo settings have been filled in/);
    // Reading the table is the one thing this step now asks the connector for
    // (#141) — the values live there, not here. Nothing was probed and nothing
    // was stored, which is the property that matters.
    assert.deepEqual(
      harness.upstream.requests.map((r) => `${r.method} ${r.url}`),
      ["POST /settings/providers"]
    );
  } finally {
    await harness.close();
  }
});

test("Other leads to an empty form with TLS still on and the address kept", async () => {
  const harness = await startHarness({ unbootstrapped: true, dataDir: dataDir() });
  try {
    await reachStep2(harness);
    stubConnector(harness);

    const res = await postSetupForm(harness, "/mailbox", {
      [ADDRESS_FIELD]: "anna@example.com",
      [PROVIDER_FIELD]: PROVIDER_OTHER,
      _action: "provider",
    });

    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /value="anna@example\.com"/);
    // An absent checkbox is how a browser submits an unticked one, so a form
    // rendered from any submitted values would otherwise come back with TLS off
    // — a default nobody chose, on the one setting worth defaulting.
    assert.match(html, new RegExp(`name="${MAILBOX_FIELDS.imapTls}"[^>]*checked`));
    assert.match(html, new RegExp(`name="${MAILBOX_FIELDS.smtpTls}"[^>]*checked`));
    assert.deepEqual(
      harness.upstream.requests.map((r) => `${r.method} ${r.url}`),
      ["POST /settings/providers"]
    );
  } finally {
    await harness.close();
  }
});

test("a provider this build does not have is a question, not a crash", async () => {
  const harness = await startHarness({ unbootstrapped: true, dataDir: dataDir() });
  try {
    await reachStep2(harness);
    stubConnector(harness);

    const res = await postSetupForm(harness, "/mailbox", {
      [ADDRESS_FIELD]: "anna@example.com",
      [PROVIDER_FIELD]: "a-provider-that-is-not-in-the-table",
      _action: "provider",
    });

    assert.equal(res.status, 400);
    assert.match(await res.text(), /Choose a provider, or pick Other\./);
  } finally {
    await harness.close();
  }
});

test("Skip still reaches step 3 with nothing configured, from every tier", async () => {
  for (const from of ["address", "providers", "manual"]) {
    const harness = await startHarness({ unbootstrapped: true, dataDir: dataDir() });
    try {
      await reachStep2(harness);
      stubConnector(harness);

      // Skip carries `formnovalidate` on every one of these screens, so what a
      // browser actually sends is the button and nothing else.
      const res = await postSetupForm(harness, "/mailbox", { _action: "skip" });

      assert.equal(res.status, 303, from);
      assert.equal(res.headers.get("location"), `/setup/${harness.claimToken}/connect`);
      // Nothing was looked up, nothing probed, nothing written: someone
      // evaluating the thing does not need mail credentials to hand.
      assert.equal(harness.upstream.requests.length, 0, from);

      const connect = await getSetup(harness, "/connect");
      assert.equal(connect.status, 200);
      assert.match(await connect.text(), /Step 3 of 3/);
    } finally {
      await harness.close();
    }
  }
});

test("the new actions are same-origin only, on the headers Chrome really sends", async () => {
  // #14, applied to the three submissions this issue adds. A same-origin form
  // POST from Chrome carries a `Referer` and no `Origin` at all, which is what
  // `postSetupForm` sends by default — and a cross-site one carries an `Origin`
  // that is not ours.
  const harness = await startHarness({ unbootstrapped: true, dataDir: dataDir() });
  try {
    await reachStep2(harness);
    stubConnector(harness, { suggestion: suggestionFor() });

    for (const action of ["lookup", "provider", "edit"]) {
      const res = await postSetupForm(
        harness,
        "/mailbox",
        {
          [ADDRESS_FIELD]: "anna@example.com",
          [PROVIDER_FIELD]: "posteo",
          [SHARED_PASSWORD_FIELD]: MAILBOX_PASSWORD,
          _action: action,
        },
        { headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example" } }
      );
      assert.equal(res.status, 403, action);
      assert.match(await res.text(), /did not come from this site/i);
    }
    assert.equal(lookups(harness), 0, "a cross-site form got a lookup out of the connector");
  } finally {
    await harness.close();
  }
});

/**
 * The `_action` a browser sends when Enter is pressed in one of a screen's boxes.
 *
 * Implicit submission is defined as activating the form's *first* submit
 * button, and a `<button name value>` contributes its pair only when it is the
 * button that was activated — so what reaches the server is that one button's
 * pair and nothing else. Read out of the served HTML rather than assumed,
 * because #140 was a page that named the right action on a button no browser
 * was ever going to press.
 */
function implicitAction(html: string): string {
  const form = /<form\b[^>]*>([\s\S]*?)<\/form>/.exec(html)?.[1] ?? "";
  for (const match of form.matchAll(/<button\b([^>]*)>/g)) {
    const attributes = match[1] ?? "";
    const type = /\btype="([^"]*)"/.exec(attributes)?.[1] ?? "submit";
    if (type !== "submit") continue;
    return /\bname="_action"[^>]*?\bvalue="([^"]*)"/.exec(attributes)?.[1] ?? "";
  }
  return "";
}

test("Enter on the address screen looks the domain up rather than skipping step 2", async () => {
  const harness = await startHarness({ unbootstrapped: true, dataDir: dataDir() });
  try {
    await reachStep2(harness);
    stubConnector(harness, { suggestion: suggestionFor() });

    const screen = await getSetup(harness, "/mailbox");
    assert.equal(screen.status, 200);
    const action = implicitAction(await screen.text());
    assert.equal(action, "lookup", `Enter on the address screen submits _action=${action}`);

    // Exactly what the browser posts: the two boxes, and the first submit
    // button's pair. The other buttons on the screen contribute nothing.
    const res = await postSetupForm(harness, "/mailbox", {
      [ADDRESS_FIELD]: "anna@example.com",
      [SHARED_PASSWORD_FIELD]: MAILBOX_PASSWORD,
      _action: action,
    });

    // #140 on the live instance was the reverse of each of these: a 303 to step
    // 3, and a connector log empty for the whole window.
    assert.equal(res.status, 200, "Enter advanced past step 2");
    assert.equal(lookups(harness), 1, "the connector was never asked for the settings");
    assert.match(await res.text(), /Found settings for example\.com/);
  } finally {
    await harness.close();
  }
});

test("every step 2 screen the wizard serves submits its own action on Enter", async () => {
  const harness = await startHarness({ unbootstrapped: true, dataDir: dataDir() });
  try {
    await reachStep2(harness);
    stubConnector(harness, { suggestion: suggestionFor() });

    for (const [path, expected] of [
      ["/mailbox", "lookup"],
      ["/mailbox?view=providers", "provider"],
      ["/mailbox?view=manual", "save"],
    ] as const) {
      const res = await getSetup(harness, path);
      assert.equal(res.status, 200, path);
      assert.equal(implicitAction(await res.text()), expected, path);
    }

    // The confirmation screen is not at a URL of its own: a lookup is the only
    // way to it, so it is checked from the answer to one.
    const suggested = await postSetupForm(harness, "/mailbox", {
      [ADDRESS_FIELD]: "anna@example.com",
      [SHARED_PASSWORD_FIELD]: MAILBOX_PASSWORD,
      _action: "lookup",
    });
    assert.equal(suggested.status, 200);
    assert.equal(implicitAction(await suggested.text()), "save", "the confirmation screen");
  } finally {
    await harness.close();
  }
});
