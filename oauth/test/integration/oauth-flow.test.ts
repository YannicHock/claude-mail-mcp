/**
 * End-to-end coverage of the OAuth flow against the real app.
 *
 * These tests exist to catch the failures that, in production, surface only as
 * "Couldn't reach the MCP server" with nothing else to go on.
 */

import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";

import {
  CLAUDE_CALLBACK,
  TEST_PASSWORD,
  TEST_USERNAME,
  UPSTREAM_TOKEN,
  completeAuthorizationFlow,
  extractCsrf,
  extractRequestToken,
  getClients,
  makePkce,
  postForm,
  registerClaudeClient,
  startHarness,
  type Harness,
} from "../helpers/harness.js";

let harness: Harness;

before(async () => {
  harness = await startHarness();
});

after(async () => {
  await harness.close();
});

describe("discovery", () => {
  it("serves protected resource metadata at the bare well-known path", async () => {
    const response = await fetch(
      `${harness.baseUrl}/.well-known/oauth-protected-resource`
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.resource, `${harness.baseUrl}/mcp`);
    assert.deepEqual(body.authorization_servers, [harness.baseUrl]);
    assert.deepEqual(body.bearer_methods_supported, ["header"]);
  });

  it("serves it at the path-suffixed variant Claude probes first", async () => {
    const response = await fetch(
      `${harness.baseUrl}/.well-known/oauth-protected-resource/mcp`
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.resource, `${harness.baseUrl}/mcp`);
  });

  it("does not advertise offline_access as a resource scope", async () => {
    // RFC 9728 guidance: a refresh token is not a requirement of the resource.
    const response = await fetch(
      `${harness.baseUrl}/.well-known/oauth-protected-resource`
    );
    const body = (await response.json()) as { scopes_supported: string[] };
    assert.equal(body.scopes_supported.includes("offline_access"), false);
  });

  it("serves authorization server metadata with everything Claude checks", async () => {
    const response = await fetch(
      `${harness.baseUrl}/.well-known/oauth-authorization-server`
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as Record<string, unknown>;

    assert.equal(body.issuer, harness.baseUrl);
    assert.equal(body.authorization_endpoint, `${harness.baseUrl}/authorize`);
    assert.equal(body.token_endpoint, `${harness.baseUrl}/token`);
    // Without a registration_endpoint, and with no CIMD support advertised,
    // Claude has no way to obtain a client identity at all.
    assert.equal(body.registration_endpoint, `${harness.baseUrl}/register`);
    // Required by the MCP authorization spec so clients can verify PKCE support.
    assert.deepEqual(body.code_challenge_methods_supported, ["S256"]);
    assert.deepEqual(body.response_types_supported, ["code"]);
    assert.deepEqual(body.grant_types_supported, [
      "authorization_code",
      "refresh_token",
    ]);
    assert.deepEqual(body.token_endpoint_auth_methods_supported, ["none"]);
    assert.equal(body.authorization_response_iss_parameter_supported, true);
    // Advertised here so Claude asks for it and gets a refresh token.
    assert.ok((body.scopes_supported as string[]).includes("offline_access"));
  });

  it("does not serve a JWKS document, which nothing consumes", async () => {
    const response = await fetch(`${harness.baseUrl}/jwks.json`);
    assert.equal(response.status, 404);
  });
});

describe("unauthenticated access to /mcp", () => {
  it("is refused with 401 and a WWW-Authenticate pointing at the metadata", async () => {
    const response = await fetch(`${harness.baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });

    // A 200 carrying an error body would produce no auth prompt in Claude at all.
    assert.equal(response.status, 401);
    const challenge = response.headers.get("www-authenticate");
    assert.ok(challenge, "expected a WWW-Authenticate header");
    assert.match(challenge, /^Bearer /);
    assert.ok(
      challenge.includes(
        `resource_metadata="${harness.baseUrl}/.well-known/oauth-protected-resource/mcp"`
      ),
      `resource_metadata missing or wrong: ${challenge}`
    );
    assert.ok(challenge.includes('scope="mcp"'), `scope missing: ${challenge}`);
  });

  it("never reaches the upstream", async () => {
    const before = harness.upstream.requests.length;
    await fetch(`${harness.baseUrl}/mcp`, { method: "POST", body: "{}" });
    assert.equal(harness.upstream.requests.length, before);
  });

  it("refuses a made-up bearer token", async () => {
    const response = await fetch(`${harness.baseUrl}/mcp`, {
      method: "POST",
      headers: { Authorization: "Bearer not-a-real-token" },
      body: "{}",
    });
    assert.equal(response.status, 401);
    assert.ok(response.headers.get("www-authenticate"));
  });

  it("refuses the upstream's own token, which a client must never be able to use", async () => {
    const response = await fetch(`${harness.baseUrl}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${UPSTREAM_TOKEN}` },
      body: "{}",
    });
    assert.equal(response.status, 401);
  });
});

describe("the full authorization flow", () => {
  it("issues tokens and reaches the connector", async () => {
    const result = await completeAuthorizationFlow(harness);
    assert.equal(result.status, 200);
    assert.equal(result.body.token_type, "Bearer");
    assert.equal(typeof result.body.access_token, "string");
    assert.equal(typeof result.body.refresh_token, "string");
    assert.equal(result.body.expires_in, 3600);

    const before = harness.upstream.requests.length;
    const call = await fetch(`${harness.baseUrl}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${result.body.access_token as string}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });

    assert.equal(call.status, 200);
    assert.equal(harness.upstream.requests.length, before + 1);
  });

  it("returns the operator to the registered redirect URI with state and iss", async () => {
    const registration = await registerClaudeClient(harness.baseUrl);
    const clientId = registration.body.client_id as string;
    const { challenge } = makePkce();

    const url = new URL(`${harness.baseUrl}/authorize`);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", CLAUDE_CALLBACK);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("state", "the-original-state");

    const form = await fetch(url);
    const requestToken = extractRequestToken(await form.text());
    assert.ok(requestToken);

    const login = await fetch(`${harness.baseUrl}/authorize`, {
      method: "POST",
      redirect: "manual",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: harness.baseUrl,
      },
      body: new URLSearchParams({
        request: requestToken,
        username: TEST_USERNAME,
        password: TEST_PASSWORD,
      }),
    });

    assert.equal(login.status, 302);
    const location = new URL(login.headers.get("location")!);
    assert.equal(location.origin + location.pathname, CLAUDE_CALLBACK);
    assert.equal(location.searchParams.get("state"), "the-original-state");
    // RFC 9207: advertised in the metadata, so it has to actually be sent.
    assert.equal(location.searchParams.get("iss"), harness.baseUrl);
    assert.ok(location.searchParams.get("code"));
  });

  it("shows the redirect host on the sign-in page", async () => {
    const registration = await registerClaudeClient(harness.baseUrl);
    const { challenge } = makePkce();
    const url = new URL(`${harness.baseUrl}/authorize`);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", registration.body.client_id as string);
    url.searchParams.set("redirect_uri", CLAUDE_CALLBACK);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");

    const html = await (await fetch(url)).text();
    assert.ok(html.includes("claude.ai"), "redirect host should be shown");
  });

  it("refreshes, rotating the refresh token", async () => {
    const first = await completeAuthorizationFlow(harness);
    const refreshToken = first.body.refresh_token as string;

    const response = await fetch(`${harness.baseUrl}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    });

    assert.equal(response.status, 200);
    const body = (await response.json()) as Record<string, unknown>;
    assert.notEqual(body.refresh_token, refreshToken);

    const call = await fetch(`${harness.baseUrl}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${body.access_token as string}` },
      body: "{}",
    });
    assert.equal(call.status, 200);
  });

  it("answers invalid_grant, not a custom code, when a refresh token is dead", async () => {
    // Anthropic's documentation is specific: anything other than invalid_grant
    // stops Claude recovering by re-authorizing.
    const response = await fetch(`${harness.baseUrl}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: "long-since-expired",
      }),
    });
    assert.equal(response.status, 400);
    const body = (await response.json()) as { error: string };
    assert.equal(body.error, "invalid_grant");
  });

  it("revokes the session when a rotated refresh token is replayed", async () => {
    const first = await completeAuthorizationFlow(harness);
    const original = first.body.refresh_token as string;

    const rotated = await fetch(`${harness.baseUrl}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: original }),
    });
    const successor = ((await rotated.json()) as Record<string, string>).refresh_token;

    const replay = await fetch(`${harness.baseUrl}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: original }),
    });
    assert.equal(replay.status, 400);

    // The successor must die with it: one of the two holders is an attacker.
    const afterRevocation = await fetch(`${harness.baseUrl}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: successor }),
    });
    assert.equal(afterRevocation.status, 400);
  });
});

describe("the token endpoint", () => {
  it("accepts form-urlencoded, which is what Claude sends", async () => {
    // A single express.json() mount — what the connector uses — would make this
    // return 415 or see an empty body.
    const response = await fetch(`${harness.baseUrl}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code" }),
    });
    assert.notEqual(response.status, 415);
    const body = (await response.json()) as { error: string };
    assert.equal(body.error, "invalid_request");
  });

  it("marks its responses no-store", async () => {
    const result = await completeAuthorizationFlow(harness);
    assert.equal(result.status, 200);
    const response = await fetch(`${harness.baseUrl}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "nonsense" }),
    });
    assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  });

  it("rejects an unsupported grant type", async () => {
    const response = await fetch(`${harness.baseUrl}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials" }),
    });
    assert.equal(response.status, 400);
    const body = (await response.json()) as { error: string };
    assert.equal(body.error, "unsupported_grant_type");
  });
});

describe("revoking a single session", () => {
  /**
   * The assertion that matters is the last one: not that the session record left
   * the store, but that the access token the client is already holding stops
   * reaching the connector. Asserting only the former is what let this ship —
   * the store is emptied either way, so a test written against it passes whether
   * or not the token was actually withdrawn.
   *
   * Its own harness, not the module-scoped one, so revoking here cannot reach
   * the sessions the other tests in this file opened.
   */
  it("stops the access token that session already handed out", async () => {
    const own = await startHarness();
    try {
      const issued = await completeAuthorizationFlow(own);
      const accessToken = issued.body.access_token as string;

      const before = await callMcp(own, accessToken);
      assert.equal(before.status, 200, "the token works before the revoke");

      const cookie = await own.signIn();
      const csrf = extractCsrf(await (await getClients(own, cookie)).text());
      const [sid] = Object.keys(own.store.sessions);
      assert.ok(sid, "the flow opened a session to revoke");
      const revoke = await postForm(own, `/settings/sessions/${sid}/revoke`, cookie, {
        _csrf: csrf,
      });
      assert.equal(revoke.status, 303);
      assert.equal(own.store.getSession(sid), undefined, "the session record is gone");

      const upstreamCalls = own.upstream.requests.length;
      const after = await callMcp(own, accessToken);
      assert.equal(after.status, 401, "the access token is refused straight away");
      assert.equal(
        own.upstream.requests.length,
        upstreamCalls,
        "and nothing was proxied to the connector"
      );
      const challenge = after.headers.get("www-authenticate") ?? "";
      assert.match(challenge, /error="invalid_token"/);
      assert.match(challenge, /session/i, "the challenge says why");
    } finally {
      await own.close();
    }
  });

  it("leaves another session's access token working", async () => {
    const own = await startHarness();
    try {
      const kept = await completeAuthorizationFlow(own);
      const doomed = await completeAuthorizationFlow(own);
      const keptSid = sidOfClient(own, kept.clientId);
      const doomedSid = sidOfClient(own, doomed.clientId);
      assert.notEqual(keptSid, doomedSid);

      const cookie = await own.signIn();
      const csrf = extractCsrf(await (await getClients(own, cookie)).text());
      await postForm(own, `/settings/sessions/${doomedSid}/revoke`, cookie, { _csrf: csrf });

      assert.equal((await callMcp(own, doomed.body.access_token as string)).status, 401);
      assert.equal((await callMcp(own, kept.body.access_token as string)).status, 200);
    } finally {
      await own.close();
    }
  });

  it("survives a refresh: the rotated access token keeps the same session", async () => {
    // Rotation reuses the sid rather than opening a new session, so the claim the
    // new access token carries has to be the one the settings page revokes.
    const own = await startHarness();
    try {
      const issued = await completeAuthorizationFlow(own);
      const refreshed = await fetch(`${own.baseUrl}/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: issued.body.refresh_token as string,
        }),
      });
      const body = (await refreshed.json()) as Record<string, unknown>;
      const rotatedAccess = body.access_token as string;
      assert.equal((await callMcp(own, rotatedAccess)).status, 200);

      const cookie = await own.signIn();
      const csrf = extractCsrf(await (await getClients(own, cookie)).text());
      const [sid] = Object.keys(own.store.sessions);
      await postForm(own, `/settings/sessions/${sid}/revoke`, cookie, { _csrf: csrf });

      assert.equal((await callMcp(own, rotatedAccess)).status, 401);
    } finally {
      await own.close();
    }
  });
});

/** POST a JSON-RPC call to /mcp with the given bearer token. */
async function callMcp(target: Harness, accessToken: string): Promise<Response> {
  return fetch(`${target.baseUrl}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
}

/** The one open session belonging to a given client. */
function sidOfClient(target: Harness, clientId: string): string {
  const found = Object.entries(target.store.sessions).find(
    ([, session]) => session.clientId === clientId
  );
  assert.ok(found, `no session for ${clientId}`);
  return found[0];
}
