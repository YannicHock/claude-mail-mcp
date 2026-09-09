/**
 * The settings sign-in flow and the session guard around every other route.
 *
 * The settings sign-in shares the OAuth consent screen's LoginThrottle instance
 * deliberately: both guard the same operator secret, and giving settings its own
 * budget would mean ten attempts instead of five. One of the tests below exists
 * specifically to pin that sharing down.
 *
 * Each test builds and tears down its own harness — the same "own harness"
 * reason authorization-guards.test.ts uses for its throttle tests — and each
 * body is wrapped in try/finally, matching that file, so a failing assertion
 * still closes the harness instead of leaving its HTTP server listening and
 * hanging the run.
 */

import { strict as assert } from "node:assert";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  TEST_PASSWORD,
  TEST_USERNAME,
  extractCsrf,
  getSettings,
  postAuthorizeForm,
  signInWith,
  startHarness,
} from "../helpers/harness.js";

async function tempOperatorFile(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "settings-session-")), "operator.json");
}

test("an unauthenticated GET /settings returns the sign-in form and no data", async () => {
  const harness = await startHarness();
  try {
    const res = await fetch(`${harness.baseUrl}/settings`);
    const body = await res.text();
    assert.equal(res.status, 200);
    assert.match(body, /name="password"/);
    assert.ok(!body.includes("Connected clients"), "no operator data before sign-in");
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(res.headers.get("set-cookie"), null, "no cookie is issued before sign-in");
  } finally {
    await harness.close();
  }
});

test("a correct sign-in sets the session cookie with the expected attributes", async () => {
  const harness = await startHarness();
  try {
    const res = await fetch(`${harness.baseUrl}/settings/login`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: harness.baseUrl },
      body: new URLSearchParams({ username: TEST_USERNAME, password: TEST_PASSWORD }),
    });
    assert.equal(res.status, 303);
    const cookie = res.headers.get("set-cookie") ?? "";
    assert.match(cookie, /^__Host-mailmcp_session=/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /Secure/);
    assert.match(cookie, /SameSite=Lax/);
  } finally {
    await harness.close();
  }
});

test("a wrong password is throttled after five attempts and logs the fail2ban line", async () => {
  const events: string[] = [];
  const harness = await startHarness({ log: (_l, msg) => events.push(msg) });
  try {
    for (let i = 0; i < 5; i += 1) {
      const res = await signInWith(harness, TEST_USERNAME, "wrong");
      assert.equal(res.status, 401);
    }
    const blocked = await signInWith(harness, TEST_USERNAME, TEST_PASSWORD);
    assert.equal(blocked.status, 429, "a correct password does not bypass the lockout");
    assert.ok(blocked.headers.has("retry-after"));
    assert.ok(events.includes("login failed"), "the fail2ban filter matches on this line");
  } finally {
    await harness.close();
  }
});

test("the settings throttle and the OAuth sign-in throttle share one budget", async () => {
  const harness = await startHarness();
  try {
    for (let i = 0; i < 5; i += 1) await signInWith(harness, TEST_USERNAME, "wrong");
    const authorize = await postAuthorizeForm(harness, TEST_USERNAME, TEST_PASSWORD);
    assert.equal(authorize.status, 429);
  } finally {
    await harness.close();
  }
});

test("a session cookie minted before a password change stops working after it", async () => {
  const harness = await startHarness({ operatorPath: await tempOperatorFile() });
  try {
    const cookie = await harness.signIn();
    assert.equal((await getSettings(harness, cookie)).status, 200);
    // Present because this harness is bootstrapped; an unclaimed one has no
    // operator record at all.
    assert.ok(harness.operator);
    await harness.operator.changePassword("a new password entirely");
    const after = await getSettings(harness, cookie);
    assert.equal(after.status, 200);
    assert.match(await after.text(), /name="password"/, "back to the sign-in form");
  } finally {
    await harness.close();
  }
});

test("a POST without the CSRF field is refused", async () => {
  const harness = await startHarness();
  try {
    const cookie = await harness.signIn();
    const res = await fetch(`${harness.baseUrl}/settings/logout`, {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: harness.baseUrl,
        cookie: `__Host-mailmcp_session=${cookie}`,
      },
      body: new URLSearchParams({}),
    });
    assert.equal(res.status, 403);
  } finally {
    await harness.close();
  }
});

test("a cross-origin POST is refused even with a valid CSRF token", async () => {
  const harness = await startHarness();
  try {
    const cookie = await harness.signIn();
    const csrf = extractCsrf(await (await getSettings(harness, cookie)).text());
    const res = await fetch(`${harness.baseUrl}/settings/logout`, {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://evil.example",
        cookie: `__Host-mailmcp_session=${cookie}`,
      },
      body: new URLSearchParams({ _csrf: csrf }),
    });
    assert.equal(res.status, 403);
  } finally {
    await harness.close();
  }
});
