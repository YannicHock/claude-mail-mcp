/**
 * The connected-clients page and its revoke action. Each test opens its own
 * harness and closes it in `finally`, opened before the first request, matching
 * the convention settings-session.test.ts established.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  UPSTREAM_TOKEN,
  completeAuthorizationFlow,
  extractCsrf,
  getClients,
  postForm,
  postTokenRefresh,
  startHarness,
} from "../helpers/harness.js";

test("revoking a client ends its session and its access token at once", async () => {
  const harness = await startHarness();
  try {
    const { body, clientId } = await completeAuthorizationFlow(harness);
    const accessToken = body.access_token as string;
    const refreshToken = body.refresh_token as string;
    const cookie = await harness.signIn();
    const csrf = extractCsrf(await (await getClients(harness, cookie)).text());

    const res = await postForm(harness, "/settings/clients/revoke", cookie, {
      _csrf: csrf,
      client_id: clientId,
    });
    assert.equal(res.status, 303);

    const mcp = await fetch(`${harness.baseUrl}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(mcp.status, 401, "the access token dies with the client, not an hour later");

    const refresh = await postTokenRefresh(harness, refreshToken, clientId);
    assert.equal(refresh.status, 400);
  } finally {
    await harness.close();
  }
});

test("the clients page lists nothing sensitive", async () => {
  const harness = await startHarness();
  try {
    const { body } = await completeAuthorizationFlow(harness);
    const accessToken = body.access_token as string;
    const refreshToken = body.refresh_token as string;
    const cookie = await harness.signIn();
    const pageBody = await (await getClients(harness, cookie)).text();
    assert.ok(!pageBody.includes(accessToken));
    assert.ok(!pageBody.includes(refreshToken));
    assert.ok(!pageBody.includes(UPSTREAM_TOKEN));
  } finally {
    await harness.close();
  }
});

test("the clients page lists a registered client and its active session", async () => {
  const harness = await startHarness();
  try {
    const { clientId } = await completeAuthorizationFlow(harness);
    const cookie = await harness.signIn();
    const body = await (await getClients(harness, cookie)).text();
    assert.ok(body.includes(clientId), "the client id is shown");
    assert.match(body, /Active/, "the unrevoked client is shown as active");
  } finally {
    await harness.close();
  }
});

test("revoking one session leaves the other client's session alone", async () => {
  const harness = await startHarness();
  try {
    await completeAuthorizationFlow(harness);
    await completeAuthorizationFlow(harness);
    const cookie = await harness.signIn();
    const sessions = Object.keys(harness.store.sessions);
    assert.equal(sessions.length, 2);
    const [revokedSid, remainingSid] = sessions;
    const csrf = extractCsrf(await (await getClients(harness, cookie)).text());

    const res = await postForm(harness, "/settings/clients/revoke", cookie, {
      _csrf: csrf,
      sid: revokedSid,
    });
    assert.equal(res.status, 303);

    const remaining = Object.keys(harness.store.sessions);
    assert.deepEqual(remaining, [remainingSid]);
  } finally {
    await harness.close();
  }
});

test("revoking a client requires the CSRF field", async () => {
  const harness = await startHarness();
  try {
    const { clientId } = await completeAuthorizationFlow(harness);
    const cookie = await harness.signIn();
    const res = await postForm(harness, "/settings/clients/revoke", cookie, {
      client_id: clientId,
    });
    assert.equal(res.status, 403);
  } finally {
    await harness.close();
  }
});

test("an unauthenticated request for the clients page gets the sign-in form, not the list", async () => {
  const harness = await startHarness();
  try {
    const res = await fetch(`${harness.baseUrl}/settings/clients`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /name="password"/);
  } finally {
    await harness.close();
  }
});
