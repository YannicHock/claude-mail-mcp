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

import {
  TEST_PASSWORD,
  TEST_USERNAME,
  UPSTREAM_TOKEN,
  completeAuthorizationFlow,
  extractCsrf,
  getSettings,
  postAuthorizeForm,
  postForm,
  startHarness,
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

    const tooShort = await postForm(harness, "/settings/password", cookie, {
      _csrf: csrf,
      current_password: TEST_PASSWORD,
      new_password: "short",
      confirm_password: "short",
    });
    assert.equal(tooShort.status, 400);
    assert.equal(harness.throttle.size, 0);
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
