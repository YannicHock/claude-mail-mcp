/**
 * The password-change flow. Not one of the three files the task brief names for
 * strict TDD, but the ordering it specifies (verify current password before
 * validating the new one, throttle the former and not the latter, disconnect
 * clients only when asked) is exactly the kind of thing that silently breaks
 * without a test, so it gets one here. Same try/finally-around-the-harness
 * convention as the rest of this suite.
 */

import { strict as assert } from "node:assert";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { silentLogger } from "../../src/logger.js";
import {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  OperatorRecord,
} from "../../src/operator.js";
import { SESSION_COOKIE } from "../../src/session.js";
import {
  TEST_PASSWORD,
  TEST_USERNAME,
  UPSTREAM_TOKEN,
  completeAuthorizationFlow,
  extractCsrf,
  getSettings,
  postAuthorizeForm,
  postForm,
  signInWith,
  startHarness,
  type Harness,
} from "../helpers/harness.js";

async function tempOperatorFile(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "settings-password-")), "operator.json");
}

test("changing the password invalidates the current session but leaves clients connected", async () => {
  const harness = await startHarness({ operatorPath: await tempOperatorFile() });
  try {
    const { body } = await completeAuthorizationFlow(harness);
    const accessToken = body.access_token as string;
    const cookie = await harness.signIn();
    const csrf = extractCsrf(await (await getSettings(harness, cookie)).text());

    const res = await postForm(harness, "/settings/password", cookie, {
      _csrf: csrf,
      current_password: TEST_PASSWORD,
      new_password: "a whole new password",
      confirm_password: "a whole new password",
    });
    assert.equal(res.status, 303);
    assert.match(res.headers.get("set-cookie") ?? "", /__Host-mailmcp_session=;/);

    // The old cookie is dead — the epoch bump gets there before the explicit clear.
    const after = await getSettings(harness, cookie);
    assert.match(await after.text(), /name="password"/);

    // But the Claude client's own access token is untouched: a password change
    // alone does not bump tokenEpoch.
    const mcp = await fetch(`${harness.baseUrl}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.notEqual(mcp.status, 401, "the access token must survive an ordinary password change");
  } finally {
    await harness.close();
  }
});

test("disconnect_clients disconnects every client along with the password change", async () => {
  const harness = await startHarness({ operatorPath: await tempOperatorFile() });
  try {
    const { body } = await completeAuthorizationFlow(harness);
    const accessToken = body.access_token as string;
    const cookie = await harness.signIn();
    const csrf = extractCsrf(await (await getSettings(harness, cookie)).text());

    const res = await postForm(harness, "/settings/password", cookie, {
      _csrf: csrf,
      current_password: TEST_PASSWORD,
      new_password: "a whole new password",
      confirm_password: "a whole new password",
      disconnect_clients: "1",
    });
    assert.equal(res.status, 303);

    const mcp = await fetch(`${harness.baseUrl}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(mcp.status, 401, "disconnect_clients bumps tokenEpoch immediately");
  } finally {
    await harness.close();
  }
});

test("a wrong current password is refused, throttled, and changes nothing", async () => {
  const harness = await startHarness({ operatorPath: await tempOperatorFile() });
  try {
    const cookie = await harness.signIn();
    const csrf = extractCsrf(await (await getSettings(harness, cookie)).text());

    const res = await postForm(harness, "/settings/password", cookie, {
      _csrf: csrf,
      current_password: "not the password",
      new_password: "a whole new password",
      confirm_password: "a whole new password",
    });
    assert.equal(res.status, 401);
    assert.equal(harness.throttle.size, 1, "a wrong current password counts against the throttle");

    // The password did not change: signing in again with the old one still works.
    const stillWorks = await harness.signIn();
    assert.ok(stillWorks.length > 0);
  } finally {
    await harness.close();
  }
});

test("a mismatched or short new password is refused without a throttle hit", async () => {
  const harness = await startHarness({ operatorPath: await tempOperatorFile() });
  try {
    const cookie = await harness.signIn();
    const csrf = extractCsrf(await (await getSettings(harness, cookie)).text());

    const mismatch = await postForm(harness, "/settings/password", cookie, {
      _csrf: csrf,
      current_password: TEST_PASSWORD,
      new_password: "a whole new password",
      confirm_password: "does not match",
    });
    assert.equal(mismatch.status, 400);
    assert.equal(harness.throttle.size, 0, "a typo in the new password is not an attack");
    // The wording is validateNewCredentials', not this route's own: the two
    // pages that set a password have to be reading from one rule book.
    assert.match(await mismatch.text(), /The two passwords do not match\./);

    const tooShort = await postForm(harness, "/settings/password", cookie, {
      _csrf: csrf,
      current_password: TEST_PASSWORD,
      new_password: "short",
      confirm_password: "short",
    });
    assert.equal(tooShort.status, 400);
    assert.equal(harness.throttle.size, 0);
    assert.match(
      await tooShort.text(),
      new RegExp(`Use at least ${MIN_PASSWORD_LENGTH} characters\.`)
    );
  } finally {
    await harness.close();
  }
});

test("password change is refused with 409 when OPERATOR_FILE is none", async () => {
  const harness = await startHarness();
  try {
    const cookie = await harness.signIn();
    const csrf = extractCsrf(await (await getSettings(harness, cookie)).text());

    const res = await postForm(harness, "/settings/password", cookie, {
      _csrf: csrf,
      current_password: TEST_PASSWORD,
      new_password: "a whole new password",
      confirm_password: "a whole new password",
    });
    assert.equal(res.status, 409);
    assert.match(await res.text(), /OPERATOR_FILE/);
  } finally {
    await harness.close();
  }
});

test("the password page never renders a token", async () => {
  const harness = await startHarness({ operatorPath: await tempOperatorFile() });
  try {
    const { body } = await completeAuthorizationFlow(harness);
    const accessToken = body.access_token as string;
    const cookie = await harness.signIn();
    const pageBody = await (
      await fetch(`${harness.baseUrl}/settings/password`, {
        headers: { cookie: `__Host-mailmcp_session=${cookie}` },
      })
    ).text();
    assert.ok(!pageBody.includes(accessToken));
    assert.ok(!pageBody.includes(UPSTREAM_TOKEN));
  } finally {
    await harness.close();
  }
});

test("the OAuth consent screen follows the password change, not the seeding secret", async () => {
  // The operator record has been the live credential since 0.6.0, but /authorize
  // kept verifying against AUTH_PASSWORD_HASH, so a password changed here left
  // the Claude sign-in still accepting the old one. It has to be the record in
  // any case now that the hash is allowed to be absent entirely.
  const harness = await startHarness({ operatorPath: await tempOperatorFile() });
  try {
    assert.ok(harness.operator);
    await harness.operator.changePassword("the password the operator just chose");

    const stale = await postAuthorizeForm(harness, TEST_USERNAME, TEST_PASSWORD);
    assert.equal(stale.status, 401, "the seeding secret is no longer a way in");

    const current = await postAuthorizeForm(
      harness,
      TEST_USERNAME,
      "the password the operator just chose"
    );
    assert.equal(current.status, 302);
    assert.match(current.headers.get("location") ?? "", /[?&]code=/);
  } finally {
    await harness.close();
  }
});

test("a new password past the maximum is refused, and refused before it is hashed", async () => {
  // MAX_PASSWORD_LENGTH exists so that a submitted form cannot choose how much
  // CPU this process spends on scrypt. A bound applied after the hash would not
  // be one, so the assertion that matters here is not the status code — it is
  // that changePassword(), the only place this route hashes the new password,
  // was never reached.
  const harness = await startHarness({ operatorPath: await tempOperatorFile() });
  try {
    const cookie = await harness.signIn();
    const csrf = extractCsrf(await (await getSettings(harness, cookie)).text());

    assert.ok(harness.operator);
    const operator = harness.operator;
    const realChangePassword = operator.changePassword.bind(operator);
    let hashes = 0;
    operator.changePassword = async (next: string): Promise<void> => {
      hashes += 1;
      await realChangePassword(next);
    };

    const tooLong = "x".repeat(MAX_PASSWORD_LENGTH + 1);
    const res = await postForm(harness, "/settings/password", cookie, {
      _csrf: csrf,
      current_password: TEST_PASSWORD,
      new_password: tooLong,
      confirm_password: tooLong,
    });

    assert.equal(res.status, 400);
    assert.equal(hashes, 0, "the length bound has to be applied before scrypt, not after it");
    assert.match(
      await res.text(),
      new RegExp(`Use at most ${MAX_PASSWORD_LENGTH} characters\.`)
    );
    assert.equal(harness.throttle.size, 0, "an over-long password is a typo, not an attack");

    // Nothing was written either: the old password still signs in.
    assert.ok((await harness.signIn()).length > 0);
  } finally {
    await harness.close();
  }
});

/**
 * Start a harness whose operator record already carries a chosen username.
 *
 * `harness.signIn()` is fixed to TEST_USERNAME, and TEST_USERNAME is shorter
 * than MIN_PASSWORD_LENGTH, so the two username-dependent rules cannot be
 * reached through it. `OperatorRecord.open()` prefers a record already on disk,
 * which makes writing one first the honest way to put a different name on this
 * instance — the same thing AUTH_USERNAME does, and nothing validates that.
 */
async function signedInAs(
  username: string,
  password: string
): Promise<{ harness: Harness; cookie: string; csrf: string }> {
  const operatorPath = await tempOperatorFile();
  await OperatorRecord.create(operatorPath, { username, password }, silentLogger);
  const harness = await startHarness({ operatorPath });
  const res = await signInWith(harness, username, password);
  const match = new RegExp(`^${SESSION_COOKIE}=([^;]+)`).exec(
    res.headers.get("set-cookie") ?? ""
  );
  assert.ok(match, `signing in as ${username} failed with status ${res.status}`);
  const cookie = match[1];
  const csrf = extractCsrf(await (await getSettings(harness, cookie)).text());
  return { harness, cookie, csrf };
}

test("a password equal to the username is refused here too", async () => {
  const { harness, cookie, csrf } = await signedInAs(
    "a-rather-long-operator-name",
    "the current password"
  );
  try {
    const res = await postForm(harness, "/settings/password", cookie, {
      _csrf: csrf,
      current_password: "the current password",
      // Case-folded, the way validateNewCredentials compares the two.
      new_password: "A-Rather-Long-Operator-Name",
      confirm_password: "A-Rather-Long-Operator-Name",
    });

    assert.equal(res.status, 400);
    assert.match(await res.text(), /cannot be the same as the username/);
    assert.equal(harness.throttle.size, 0);
  } finally {
    await harness.close();
  }
});

test("a stored username that breaks a rule does not block the password change", async () => {
  // AUTH_USERNAME is an unvalidated environment variable, so an instance can be
  // running under a name validateNewCredentials would reject. That is a
  // complaint about the old credential and this form cannot act on it — there
  // is no username box here. Letting it refuse would strand the operator on the
  // one page that exists to replace what they have.
  const { harness, cookie, csrf } = await signedInAs("two words", "the current password");
  try {
    const res = await postForm(harness, "/settings/password", cookie, {
      _csrf: csrf,
      current_password: "the current password",
      new_password: "a whole new password",
      confirm_password: "a whole new password",
    });
    assert.equal(res.status, 303, "the password change goes through");
  } finally {
    await harness.close();
  }
});

test("a rejected new password is reported next to the field that was wrong", async () => {
  const harness = await startHarness({ operatorPath: await tempOperatorFile() });
  try {
    const cookie = await harness.signIn();
    const csrf = extractCsrf(await (await getSettings(harness, cookie)).text());

    const res = await postForm(harness, "/settings/password", cookie, {
      _csrf: csrf,
      current_password: TEST_PASSWORD,
      new_password: "short",
      confirm_password: "also wrong",
    });

    assert.equal(res.status, 400);
    const html = await res.text();
    // Both problems, not just the first, and each one attached to its own input
    // the way the setup wizard has done since it was written.
    assert.match(html, /new_password[^>]*aria-invalid="true"/);
    assert.match(html, /confirm_password[^>]*aria-invalid="true"/);
    assert.match(html, new RegExp(`Use at least ${MIN_PASSWORD_LENGTH} characters\.`));
    assert.match(html, /The two passwords do not match\./);
  } finally {
    await harness.close();
  }
});
