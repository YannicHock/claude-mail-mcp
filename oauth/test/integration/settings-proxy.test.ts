/**
 * The settings proxy's two obligations, the same shape as proxy-isolation.test.ts's
 * for /mcp: the operator's session cookie never reaches the connector, and an
 * unauthenticated request never reaches it either. Each test builds its own
 * harness and closes it in `finally`, opened before the first `fetch`/`signIn`
 * call, matching the convention settings-session.test.ts established — a failed
 * assertion must still close the harness rather than hang the run.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  UPSTREAM_TOKEN,
  completeAuthorizationFlow,
  startHarness,
} from "../helpers/harness.js";

test("the session cookie never reaches the connector", async () => {
  const harness = await startHarness();
  try {
    const cookie = await harness.signIn();
    await fetch(`${harness.baseUrl}/settings/mailboxes`, {
      headers: { cookie: `__Host-mailmcp_session=${cookie}` },
    });
    const forwarded = harness.upstream.requests.at(-1);
    assert.ok(forwarded, "the request reached the upstream");
    assert.equal(forwarded!.headers.cookie, undefined, "Cookie must be stripped");
    assert.ok(
      !JSON.stringify(forwarded!.headers).includes(cookie),
      "the session token appears in no forwarded header"
    );
  } finally {
    await harness.close();
  }
});

test("the proxied request carries the static token and a matching assertion", async () => {
  const harness = await startHarness();
  try {
    const cookie = await harness.signIn();
    await fetch(`${harness.baseUrl}/settings/mailboxes`, {
      headers: { cookie: `__Host-mailmcp_session=${cookie}` },
    });
    const forwarded = harness.upstream.requests.at(-1)!;
    assert.equal(forwarded.headers.authorization, `Bearer ${UPSTREAM_TOKEN}`);
    const assertionHeader = forwarded.headers["x-settings-assertion"];
    assert.equal(typeof assertionHeader, "string");
    const payload = JSON.parse(
      Buffer.from((assertionHeader as string).split(".")[0], "base64url").toString("utf8")
    );
    assert.equal(payload.htm, "GET");
    assert.equal(payload.htu, "/settings/mailboxes");
    assert.equal(payload.aud, "mail-mcp-settings");
  } finally {
    await harness.close();
  }
});

test("an unauthenticated settings request never reaches the connector", async () => {
  const harness = await startHarness();
  try {
    const before = harness.upstream.requests.length;
    const res = await fetch(`${harness.baseUrl}/settings/mailboxes`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /name="password"/);
    assert.equal(harness.upstream.requests.length, before, "nothing was forwarded");
  } finally {
    await harness.close();
  }
});

test("a MCP request is unaffected by the cookie filter", async () => {
  const harness = await startHarness();
  try {
    const { body } = await completeAuthorizationFlow(harness);
    const token = body.access_token as string;
    await fetch(`${harness.baseUrl}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        cookie: "unrelated=1",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const forwarded = harness.upstream.requests.at(-1)!;
    assert.equal(forwarded.headers.cookie, undefined);
    assert.equal(forwarded.headers["x-settings-assertion"], undefined);
  } finally {
    await harness.close();
  }
});
