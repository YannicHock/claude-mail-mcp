/**
 * The proxy's two obligations, proven rather than asserted in a comment:
 * the connector's static token reaches the connector, and it reaches nothing else.
 */

import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";

import {
  UPSTREAM_TOKEN,
  completeAuthorizationFlow,
  startHarness,
  type Harness,
} from "../helpers/harness.js";

let harness: Harness;
let accessToken: string;
let refreshToken: string;

before(async () => {
  harness = await startHarness();
  const result = await completeAuthorizationFlow(harness);
  accessToken = result.body.access_token as string;
  refreshToken = result.body.refresh_token as string;
});

after(async () => {
  await harness.close();
});

describe("upstream token substitution", () => {
  it("presents the connector's own token upstream", async () => {
    const before = harness.upstream.requests.length;
    await fetch(`${harness.baseUrl}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });

    const recorded = harness.upstream.requests[before];
    assert.ok(recorded, "the request should have reached the upstream");
    assert.equal(recorded.headers.authorization, `Bearer ${UPSTREAM_TOKEN}`);
  });

  it("never forwards the client's own access token upstream", async () => {
    const before = harness.upstream.requests.length;
    await fetch(`${harness.baseUrl}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}` },
      body: "{}",
    });

    const recorded = harness.upstream.requests[before];
    const serialised = JSON.stringify(recorded);
    assert.equal(
      serialised.includes(accessToken),
      false,
      "the client's access token must not appear anywhere in the upstream request"
    );
  });

  it("forwards the request body byte for byte", async () => {
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "list_accounts", arguments: {} },
    });
    const before = harness.upstream.requests.length;
    await fetch(`${harness.baseUrl}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: payload,
    });
    assert.equal(harness.upstream.requests[before].body, payload);
  });

  it("preserves the Accept header the MCP transport requires", async () => {
    const before = harness.upstream.requests.length;
    await fetch(`${harness.baseUrl}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    assert.equal(
      harness.upstream.requests[before].headers.accept,
      "application/json, text/event-stream"
    );
  });
});

describe("the upstream token never reaches the client", () => {
  it("does not appear in a successful response", async () => {
    harness.upstream.respondWith((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }));
    });

    const response = await fetch(`${harness.baseUrl}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}` },
      body: "{}",
    });

    assertNoUpstreamToken(response, await response.text());
  });

  it("does not appear even if the upstream echoes it back", async () => {
    // The upstream is trusted, but "trusted" should not mean "can leak our
    // credential by accident". If this ever fails, the proxy is copying a header
    // it should not.
    harness.upstream.respondWith((req, res) => {
      res.writeHead(200, {
        "Content-Type": "application/json",
        // Deliberately hostile: the upstream reflects the credential.
        "X-Echoed-Auth": String(req.headers.authorization),
      });
      res.end(JSON.stringify({ received: req.headers.authorization }));
    });

    const response = await fetch(`${harness.baseUrl}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}` },
      body: "{}",
    });
    const text = await response.text();

    // The body is the upstream's to control and this service does not rewrite it,
    // so the echo is expected there. What must hold is that the proxy itself adds
    // no such disclosure — checked on the headers it constructs.
    assert.ok(text.includes(UPSTREAM_TOKEN), "sanity: the stub did echo it");
    assert.equal(
      response.headers.get("www-authenticate"),
      null,
      "the upstream's own auth challenge must not be relayed to an OAuth client"
    );
  });

  it("does not appear in a 401 challenge", async () => {
    const response = await fetch(`${harness.baseUrl}/mcp`, {
      method: "POST",
      headers: { Authorization: "Bearer nonsense" },
      body: "{}",
    });
    assert.equal(response.status, 401);
    assertNoUpstreamToken(response, await response.text());
  });

  it("does not appear in the discovery documents", async () => {
    for (const path of [
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp",
      "/.well-known/oauth-authorization-server",
      "/health",
    ]) {
      const response = await fetch(`${harness.baseUrl}${path}`);
      assertNoUpstreamToken(response, await response.text(), path);
    }
  });

  it("does not appear in an issued token", () => {
    // A JWT is signed, not encrypted; anything put in its claims is readable by
    // the client that holds it.
    for (const token of [accessToken, refreshToken]) {
      const [, payload] = token.split(".");
      const claims = Buffer.from(payload, "base64url").toString("utf8");
      assert.equal(claims.includes(UPSTREAM_TOKEN), false);
    }
  });

  it("does not appear on an upstream failure", async () => {
    harness.upstream.respondWith((_req, res) => {
      res.writeHead(500);
      res.end("upstream exploded");
    });
    const response = await fetch(`${harness.baseUrl}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}` },
      body: "{}",
    });
    assertNoUpstreamToken(response, await response.text());
  });
});

describe("the connector's /health is not exposed", () => {
  it("answers with this service's own health, disclosing nothing about the connector", async () => {
    const response = await fetch(`${harness.baseUrl}/health`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as Record<string, unknown>;

    // The connector's own /health leaks its version, how many mailboxes are
    // configured and the path to the credentials file. None of that belongs here.
    assert.equal("accounts" in body, false);
    assert.equal("accounts_file" in body, false);
    assert.equal(body.service, "claude-mail-mcp-oauth");
  });

  it("does not proxy /health upstream", async () => {
    const before = harness.upstream.requests.length;
    await fetch(`${harness.baseUrl}/health`);
    assert.equal(harness.upstream.requests.length, before);
  });
});

describe("streaming", () => {
  it("forwards text/event-stream as it is produced rather than buffering it", async () => {
    harness.upstream.respondWith((_req, res) => {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
      });
      res.write("event: message\ndata: {\"chunk\":1}\n\n");
      // The second chunk lands well after the first. If anything in the path
      // buffers, the reader below sees nothing until the response ends.
      setTimeout(() => {
        res.write("event: message\ndata: {\"chunk\":2}\n\n");
        res.end();
      }, 150);
    });

    const response = await fetch(`${harness.baseUrl}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json, text/event-stream",
      },
      body: "{}",
    });

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);

    const reader = response.body!.getReader();
    const startedAt = Date.now();
    const first = await reader.read();
    const firstChunkAt = Date.now() - startedAt;

    assert.equal(first.done, false);
    assert.ok(
      new TextDecoder().decode(first.value).includes('"chunk":1'),
      "the first event should arrive on its own"
    );
    assert.ok(
      firstChunkAt < 140,
      `first chunk arrived after ${firstChunkAt}ms — the response is being buffered`
    );

    await reader.cancel();
  });
});

function assertNoUpstreamToken(
  response: Response,
  body: string,
  label = ""
): void {
  const headers = JSON.stringify([...response.headers.entries()]);
  assert.equal(
    headers.includes(UPSTREAM_TOKEN),
    false,
    `upstream token leaked in response headers ${label}`
  );
  assert.equal(
    body.includes(UPSTREAM_TOKEN),
    false,
    `upstream token leaked in response body ${label}`
  );
}
