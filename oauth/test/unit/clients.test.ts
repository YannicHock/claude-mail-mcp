import { strict as assert } from "node:assert";
import { beforeEach, describe, it } from "node:test";

import { registerClient } from "../../src/clients.js";
import { silentLogger } from "../../src/logger.js";
import { MAX_CLIENTS, Store } from "../../src/store.js";
import { HOSTED_CLAUDE_REDIRECT_URIS, LOOPBACK_REDIRECT_URIS } from "../../src/urls.js";

const ALLOWLIST = [...HOSTED_CLAUDE_REDIRECT_URIS];
const CLAUDE_CALLBACK = "https://claude.ai/api/mcp/auth_callback";

/** The registration body Claude's hosted surfaces send. */
function claudeRegistration(overrides: Record<string, unknown> = {}) {
  return {
    client_name: "Claude",
    redirect_uris: [CLAUDE_CALLBACK],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    ...overrides,
  };
}

describe("registerClient", () => {
  let store: Store;

  beforeEach(async () => {
    store = await Store.open(null, silentLogger);
  });

  it("registers a client sending Claude's own metadata", () => {
    const result = registerClient(claudeRegistration(), ALLOWLIST, store);
    assert.ok(result.ok);
    assert.equal(result.client.token_endpoint_auth_method, "none");
    assert.deepEqual(result.client.redirect_uris, [CLAUDE_CALLBACK]);
    assert.equal(result.client.client_name, "Claude");
    assert.ok(result.client.client_id.length > 0);
    assert.ok(result.client.client_id_issued_at > 0);
  });

  it("never issues a client secret", () => {
    const result = registerClient(claudeRegistration(), ALLOWLIST, store);
    assert.ok(result.ok);
    assert.equal("client_secret" in result.client, false);
  });

  it("issues a distinct client_id per registration", () => {
    const a = registerClient(claudeRegistration(), ALLOWLIST, store);
    const b = registerClient(claudeRegistration(), ALLOWLIST, store);
    assert.ok(a.ok && b.ok);
    assert.notEqual(a.client.client_id, b.client.client_id);
  });

  it("persists the registration so /authorize can find it", () => {
    const result = registerClient(claudeRegistration(), ALLOWLIST, store);
    assert.ok(result.ok);
    assert.deepEqual(store.getClient(result.client.client_id), result.client);
  });

  it("defaults grant_types and response_types when the client omits them", () => {
    const result = registerClient(
      { redirect_uris: [CLAUDE_CALLBACK] },
      ALLOWLIST,
      store
    );
    assert.ok(result.ok);
    assert.deepEqual(result.client.grant_types, [
      "authorization_code",
      "refresh_token",
    ]);
    assert.deepEqual(result.client.response_types, ["code"]);
  });

  describe("redirect URI validation", () => {
    it("rejects a redirect_uri outside the allowlist", () => {
      const result = registerClient(
        claudeRegistration({ redirect_uris: ["https://evil.example.com/cb"] }),
        ALLOWLIST,
        store
      );
      assert.ok(!result.ok);
      assert.equal(result.error, "invalid_redirect_uri");
    });

    it("rejects when only one of several redirect_uris is foreign", () => {
      const result = registerClient(
        claudeRegistration({
          redirect_uris: [CLAUDE_CALLBACK, "https://evil.example.com/cb"],
        }),
        ALLOWLIST,
        store
      );
      assert.ok(!result.ok);
      assert.equal(result.error, "invalid_redirect_uri");
    });

    it("writes nothing to the store when it rejects", () => {
      registerClient(
        claudeRegistration({ redirect_uris: ["https://evil.example.com/cb"] }),
        ALLOWLIST,
        store
      );
      assert.equal(Object.keys(store.clients).length, 0);
    });

    it("does not name the allowlist in the error it returns", () => {
      const result = registerClient(
        claudeRegistration({ redirect_uris: ["https://evil.example.com/cb"] }),
        ALLOWLIST,
        store
      );
      assert.ok(!result.ok);
      assert.equal(result.error_description.includes("claude.ai"), false);
    });

    it("rejects a missing or empty redirect_uris", () => {
      for (const value of [undefined, [], "not-an-array", null]) {
        const result = registerClient(
          { ...claudeRegistration(), redirect_uris: value },
          ALLOWLIST,
          store
        );
        assert.ok(!result.ok);
        assert.equal(result.error, "invalid_redirect_uri");
      }
    });

    it("rejects a non-string redirect_uri entry", () => {
      const result = registerClient(
        claudeRegistration({ redirect_uris: [42] }),
        ALLOWLIST,
        store
      );
      assert.ok(!result.ok);
      assert.equal(result.error, "invalid_redirect_uri");
    });

    it("rejects plain http on a public host even if it were allowlisted", () => {
      const result = registerClient(
        claudeRegistration({ redirect_uris: ["http://claude.ai/api/mcp/auth_callback"] }),
        [...ALLOWLIST, "http://claude.ai/api/mcp/auth_callback"],
        store
      );
      assert.ok(!result.ok);
      assert.equal(result.error, "invalid_redirect_uri");
    });

    it("caps how many redirect_uris one registration may claim", () => {
      const result = registerClient(
        claudeRegistration({
          redirect_uris: Array.from({ length: 50 }, () => CLAUDE_CALLBACK),
        }),
        ALLOWLIST,
        store
      );
      assert.ok(!result.ok);
      assert.equal(result.error, "invalid_redirect_uri");
    });

    it("accepts an ephemeral loopback port when loopback is allowlisted", () => {
      const result = registerClient(
        claudeRegistration({ redirect_uris: ["http://127.0.0.1:51234/callback"] }),
        [...ALLOWLIST, ...LOOPBACK_REDIRECT_URIS],
        store
      );
      assert.ok(result.ok);
    });
  });

  describe("client metadata validation", () => {
    it("rejects an unsupported grant_type instead of silently defaulting", () => {
      const result = registerClient(
        claudeRegistration({ grant_types: ["client_credentials"] }),
        ALLOWLIST,
        store
      );
      assert.ok(!result.ok);
      assert.equal(result.error, "invalid_client_metadata");
    });

    it("rejects an unsupported response_type", () => {
      const result = registerClient(
        claudeRegistration({ response_types: ["token"] }),
        ALLOWLIST,
        store
      );
      assert.ok(!result.ok);
      assert.equal(result.error, "invalid_client_metadata");
    });

    it("rejects a confidential client asking for secret-based authentication", () => {
      const result = registerClient(
        claudeRegistration({ token_endpoint_auth_method: "client_secret_post" }),
        ALLOWLIST,
        store
      );
      assert.ok(!result.ok);
      assert.equal(result.error, "invalid_client_metadata");
    });

    it("rejects malformed grant_types and response_types", () => {
      for (const field of ["grant_types", "response_types"]) {
        for (const value of ["authorization_code", [], [1, 2]]) {
          const result = registerClient(
            claudeRegistration({ [field]: value }),
            ALLOWLIST,
            store
          );
          assert.ok(!result.ok, `${field}=${JSON.stringify(value)} should be rejected`);
          assert.equal(result.error, "invalid_client_metadata");
        }
      }
    });

    it("rejects a non-object body", () => {
      for (const body of [null, "string", 42, ["array"]]) {
        const result = registerClient(body, ALLOWLIST, store);
        assert.ok(!result.ok);
        assert.equal(result.error, "invalid_client_metadata");
      }
    });

    it("rejects a non-string client_name and scope", () => {
      assert.ok(!registerClient(claudeRegistration({ client_name: 1 }), ALLOWLIST, store).ok);
      assert.ok(!registerClient(claudeRegistration({ scope: [] }), ALLOWLIST, store).ok);
    });

    it("ignores unknown metadata fields rather than refusing the registration", () => {
      const result = registerClient(
        claudeRegistration({ software_id: "claude", contacts: ["x@example.com"] }),
        ALLOWLIST,
        store
      );
      assert.ok(result.ok);
    });
  });

  it("evicts the oldest registrations rather than growing without bound", () => {
    // Claude registers a fresh client on every new connection, so this is a real
    // growth path, not a hypothetical one.
    for (let i = 0; i < MAX_CLIENTS + 25; i += 1) {
      const result = registerClient(claudeRegistration(), ALLOWLIST, store);
      assert.ok(result.ok);
    }
    assert.equal(Object.keys(store.clients).length, MAX_CLIENTS);
  });
});
