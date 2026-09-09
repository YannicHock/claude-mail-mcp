/**
 * The settings UI opens with the instance, in the process that claimed it.
 *
 * Issue #121. `/mcp` has opened the moment Finish is pressed since #24 — the gate
 * reads `bootstrap.bootstrapped` per request, deliberately, so completing the
 * claim opens the endpoint in the same breath. The settings mount did not: it was
 * decided once, at construction, against an `OperatorRecord` that does not exist
 * while the instance is unclaimed, and nothing re-ran that decision. So the
 * completion screen had to send the operator to `docker compose restart
 * mail-oauth` for the one page it had just created an account for.
 *
 * What this file holds in place is both halves of that, on **one app object**:
 *
 *  - before Finish, every `/settings/*` path is a 404 that is byte-for-byte the
 *    one a wrong claim token gets — the wizard's own indistinguishability
 *    property, which the mount must not weaken by answering differently;
 *  - after Finish, and with no restart anywhere in the test, `/settings` serves
 *    the sign-in page, accepts the credentials step 1 wrote, and the
 *    `/settings/mailboxes` proxy below it opens in the same instant. Both halves
 *    or neither: a UI that can list the settings pages but not reach the mailbox
 *    ones is worse than no UI.
 *
 * Every request here goes through the real middleware chain, and the harness is
 * never restarted: `startHarness` is called once per test, and a second call
 * would be exactly the restart this issue removes.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ASSERTION_HEADER } from "../../src/assertion.js";
import { SESSION_COOKIE } from "../../src/session.js";
import {
  completeAuthorizationFlow,
  postAuthorizeForm,
  postSetupForm,
  signInWith,
  startHarness,
  UPSTREAM_TOKEN,
  type Harness,
} from "../helpers/harness.js";

const USERNAME = "anna";
const PASSWORD = "a-password-nobody-guesses";

function dataDir(): string {
  return mkdtempSync(join(tmpdir(), "oauth-settings-mount-"));
}

/** The connector, as step 3 and the settings overview ask it about mailboxes. */
function stubHealth(harness: Harness): void {
  harness.upstream.respondWith((req, res) => {
    if (req.method === "GET" && (req.url ?? "") === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", version: "0.6.3", accounts: [] }));
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<h1>the connector's own mailbox page</h1>");
  });
}

/** Step 1, step 2 skipped, Finish — the whole wizard, as a browser drives it. */
async function claim(harness: Harness): Promise<Response> {
  const credentials = await postSetupForm(harness, "/credentials", {
    username: USERNAME,
    password: PASSWORD,
    confirmation: PASSWORD,
  });
  assert.equal(credentials.status, 303, "step 1 completed");
  const skipped = await postSetupForm(harness, "/mailbox", { _action: "skip" });
  assert.equal(skipped.status, 303, "step 2 skipped");
  const finished = await postSetupForm(harness, "/connect", { public_url_ok: "yes" });
  assert.equal(finished.status, 200, "Finish");
  return finished;
}

test("the settings UI answers in the process that claimed the instance", async () => {
  const harness = await startHarness({ unbootstrapped: true, dataDir: dataDir() });
  try {
    stubHealth(harness);

    // Closed first. Not merely "not yet useful": a 404, from the same responder
    // an unknown path on a claimed instance gets.
    const before = await fetch(`${harness.baseUrl}/settings`, { redirect: "manual" });
    assert.equal(before.status, 404, "unclaimed: /settings is not there at all");

    await claim(harness);

    // No restart, no second harness, the same app object throughout.
    const signIn = await fetch(`${harness.baseUrl}/settings`, { redirect: "manual" });
    assert.equal(signIn.status, 200, "the settings UI is mounted now");
    assert.match(await signIn.text(), /name="password"/, "the sign-in form, not a 404 body");

    // And the account step 1 wrote is the one it signs in with.
    const session = await signInWith(harness, USERNAME, PASSWORD);
    assert.equal(session.status, 303);
    const cookie = new RegExp(`^${SESSION_COOKIE}=([^;]+)`).exec(
      session.headers.get("set-cookie") ?? ""
    )?.[1];
    assert.ok(cookie, "a session cookie was issued");

    const overview = await fetch(`${harness.baseUrl}/settings`, {
      redirect: "manual",
      headers: { cookie: `${SESSION_COOKIE}=${cookie}` },
    });
    assert.equal(overview.status, 200);
    assert.match(await overview.text(), /Sign out/, "the overview, behind the session");

    // A wrong password is still wrong: the record is the live credential, not a
    // mount that accepts anything now that it exists.
    const wrong = await signInWith(harness, USERNAME, "not the password");
    assert.equal((wrong.headers.get("set-cookie") ?? "").includes(SESSION_COOKIE), false);
  } finally {
    await harness.close();
  }
});

test("the mailbox proxy opens in the same instant the settings router does", async () => {
  const harness = await startHarness({ unbootstrapped: true, dataDir: dataDir() });
  try {
    stubHealth(harness);

    assert.equal(
      (await fetch(`${harness.baseUrl}/settings/mailboxes`, { redirect: "manual" })).status,
      404,
      "unclaimed: the proxy is not there either"
    );

    await claim(harness);

    // Unauthenticated, it is the sign-in page and nothing is forwarded — the
    // guarantee requireSession-ahead-of-the-proxy exists for, which a lazily
    // built mount must not lose.
    const forwardedBefore = harness.upstream.requests.length;
    const anonymous = await fetch(`${harness.baseUrl}/settings/mailboxes`, { redirect: "manual" });
    assert.equal(anonymous.status, 200);
    assert.match(await anonymous.text(), /name="password"/);
    assert.equal(harness.upstream.requests.length, forwardedBefore, "nothing was forwarded");

    const cookie = new RegExp(`^${SESSION_COOKIE}=([^;]+)`).exec(
      (await signInWith(harness, USERNAME, PASSWORD)).headers.get("set-cookie") ?? ""
    )?.[1];
    assert.ok(cookie);

    const proxied = await fetch(`${harness.baseUrl}/settings/mailboxes`, {
      redirect: "manual",
      headers: { cookie: `${SESSION_COOKIE}=${cookie}` },
    });
    assert.equal(proxied.status, 200);

    const forwarded = harness.upstream.requests.at(-1);
    assert.ok(forwarded, "the request reached the connector");
    assert.equal(forwarded!.url, "/settings/mailboxes");
    assert.equal(forwarded!.headers.authorization, `Bearer ${UPSTREAM_TOKEN}`);
    assert.equal(
      typeof forwarded!.headers[ASSERTION_HEADER],
      "string",
      "signed with this session, the same as a mount built at boot"
    );
    assert.equal(forwarded!.headers.cookie, undefined, "the session cookie is still stripped");
  } finally {
    await harness.close();
  }
});

test("while unclaimed, /settings/* is the same 404 a wrong claim token gets", async () => {
  const harness = await startHarness({ unbootstrapped: true, dataDir: dataDir() });
  try {
    // The reference answer: a wrong token on an unclaimed instance.
    const wrongToken = await fetch(`${harness.baseUrl}/setup/not-the-token/credentials`, {
      redirect: "manual",
    });
    assert.equal(wrongToken.status, 404);
    const reference = await wrongToken.json();

    for (const path of ["/settings", "/settings/", "/settings/login", "/settings/clients", "/settings/mailboxes"]) {
      const res = await fetch(`${harness.baseUrl}${path}`, { redirect: "manual" });
      assert.equal(res.status, 404, path);
      assert.equal(res.headers.get("content-type"), wrongToken.headers.get("content-type"), path);
      assert.deepEqual(
        Object.keys((await res.json()) as object),
        Object.keys(reference as object),
        path
      );
    }
  } finally {
    await harness.close();
  }
});

test("the consent screen accepts the account the wizard just created", async () => {
  // The same capture, on the other route that reads the operator record:
  // `/authorize` POST used to check a credential resolved before the wizard had
  // created one, so the instance refused the password it had just been given and
  // Claude could not be connected until the container came back — on the screen
  // that says the MCP endpoint needs no restart.
  const harness = await startHarness({ unbootstrapped: true, dataDir: dataDir() });
  try {
    stubHealth(harness);
    await claim(harness);

    const flow = await completeAuthorizationFlow(harness, {
      username: USERNAME,
      password: PASSWORD,
    });
    assert.equal(flow.status, 200, "the whole flow, in the process that claimed the instance");
    assert.equal(typeof flow.body.access_token, "string");

    // And the token is minted for the operator the wizard chose, not for the
    // configured default that was the only name available at construction.
    const claims = JSON.parse(
      Buffer.from((flow.body.access_token as string).split(".")[1], "base64url").toString("utf8")
    ) as { sub: string };
    assert.equal(claims.sub, USERNAME);

    const wrong = await postAuthorizeForm(harness, USERNAME, "not the password");
    assert.equal(wrong.status, 401, "and a wrong password is still wrong");
  } finally {
    await harness.close();
  }
});

test("a claimed instance with no settings signing key still has no settings UI", async () => {
  // The other half of the mount condition, unchanged by this issue: without a
  // key there is nothing the connector would accept for the mailbox pages, so a
  // claimed instance answers 404 there too — and must not start answering
  // differently now that the operator is resolved per request rather than
  // captured.
  const harness = await startHarness({ configOverrides: { settingsSigningKey: null } });
  try {
    for (const path of ["/settings", "/settings/clients", "/settings/mailboxes"]) {
      assert.equal(
        (await fetch(`${harness.baseUrl}${path}`, { redirect: "manual" })).status,
        404,
        path
      );
    }
  } finally {
    await harness.close();
  }
});
