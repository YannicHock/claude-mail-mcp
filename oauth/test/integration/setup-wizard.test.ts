/**
 * Step 1 of the setup wizard, against the real gate and the real middleware chain.
 *
 * Two things this file exists to hold in place.
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
 */

import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { verifyPassword } from "../../src/passwords.js";
import { SESSION_COOKIE } from "../../src/session.js";
import {
  getSetup,
  postSetupForm,
  setupBase,
  signInWith,
  startHarness,
  type Harness,
} from "../helpers/harness.js";

const USERNAME = "anna";
const PASSWORD = "a-password-nobody-guesses";

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
