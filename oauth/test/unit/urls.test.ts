import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  HOSTED_CLAUDE_REDIRECT_URIS,
  LOOPBACK_REDIRECT_URIS,
  canonicalResource,
  isTransportSafeRedirectUri,
  normalisePublicUrl,
  redirectUriAllowed,
  sameResource,
} from "../../src/urls.js";

describe("canonicalResource", () => {
  it("lowercases scheme and host", () => {
    assert.equal(
      canonicalResource("HTTPS://Mail.Example.COM/mcp"),
      "https://mail.example.com/mcp"
    );
  });

  it("drops a default port but keeps a non-default one", () => {
    assert.equal(
      canonicalResource("https://mail.example.com:443/mcp"),
      "https://mail.example.com/mcp"
    );
    assert.equal(
      canonicalResource("https://mail.example.com:8443/mcp"),
      "https://mail.example.com:8443/mcp"
    );
  });

  it("drops a trailing slash, including on a bare origin", () => {
    assert.equal(
      canonicalResource("https://mail.example.com/mcp/"),
      "https://mail.example.com/mcp"
    );
    assert.equal(
      canonicalResource("https://mail.example.com/"),
      "https://mail.example.com"
    );
  });

  it("preserves a multi-segment path", () => {
    assert.equal(
      canonicalResource("https://mail.example.com/server/mcp"),
      "https://mail.example.com/server/mcp"
    );
  });

  it("rejects input the MCP spec lists as invalid", () => {
    // Both examples are taken verbatim from the spec's "invalid canonical URIs".
    assert.throws(() => canonicalResource("mcp.example.com"), /absolute URI/);
    assert.throws(
      () => canonicalResource("https://mcp.example.com#fragment"),
      /fragment/
    );
  });

  it("rejects a non-http scheme", () => {
    assert.throws(() => canonicalResource("ftp://mail.example.com"), /http/);
  });
});

describe("sameResource", () => {
  it("treats the operator's typed form and the canonical form as equal", () => {
    assert.equal(
      sameResource("HTTPS://Mail.Example.com/mcp/", "https://mail.example.com/mcp"),
      true
    );
  });

  it("does not equate different paths", () => {
    assert.equal(
      sameResource("https://mail.example.com/mcp", "https://mail.example.com/other"),
      false
    );
  });

  it("does not equate different hosts", () => {
    assert.equal(
      sameResource("https://mail.example.com/mcp", "https://evil.example.com/mcp"),
      false
    );
  });

  it("returns false rather than throwing on unparseable input", () => {
    assert.equal(sameResource("not a url", "https://mail.example.com/mcp"), false);
  });
});

describe("normalisePublicUrl", () => {
  it("produces a stable issuer with no trailing slash", () => {
    assert.equal(
      normalisePublicUrl("https://mail.example.com/"),
      "https://mail.example.com"
    );
  });
});

describe("redirectUriAllowed", () => {
  const hosted = [...HOSTED_CLAUDE_REDIRECT_URIS];
  const withLoopback = [...hosted, ...LOOPBACK_REDIRECT_URIS];

  it("accepts the hosted Claude callback", () => {
    assert.equal(
      redirectUriAllowed("https://claude.ai/api/mcp/auth_callback", hosted),
      true
    );
  });

  it("accepts the claude.com callback Anthropic asks to be allowlisted", () => {
    assert.equal(
      redirectUriAllowed("https://claude.com/api/mcp/auth_callback", hosted),
      true
    );
  });

  it("rejects a foreign host", () => {
    assert.equal(
      redirectUriAllowed("https://evil.example.com/api/mcp/auth_callback", hosted),
      false
    );
  });

  it("rejects a lookalike host that merely contains the allowed one", () => {
    assert.equal(
      redirectUriAllowed("https://claude.ai.evil.example.com/api/mcp/auth_callback", hosted),
      false
    );
  });

  it("rejects the right host with a different path", () => {
    assert.equal(
      redirectUriAllowed("https://claude.ai/api/mcp/evil", hosted),
      false
    );
  });

  it("rejects an open-redirect payload appended as a query string", () => {
    assert.equal(
      redirectUriAllowed(
        "https://claude.ai/api/mcp/auth_callback?next=https://evil.example.com",
        hosted
      ),
      false
    );
  });

  it("rejects loopback when loopback is not allowlisted", () => {
    assert.equal(redirectUriAllowed("http://127.0.0.1:3118/callback", hosted), false);
  });

  it("matches loopback with the port ignored, per RFC 8252 section 7.3", () => {
    assert.equal(
      redirectUriAllowed("http://127.0.0.1:3118/callback", withLoopback),
      true
    );
    assert.equal(
      redirectUriAllowed("http://127.0.0.1:54321/callback", withLoopback),
      true
    );
  });

  it("applies the same port-agnostic match to localhost, which Claude Code uses", () => {
    assert.equal(
      redirectUriAllowed("http://localhost:3118/callback", withLoopback),
      true
    );
  });

  it("does not let a loopback allowlist entry admit a different loopback path", () => {
    assert.equal(
      redirectUriAllowed("http://127.0.0.1:3118/evil", withLoopback),
      false
    );
  });

  it("does not let a loopback allowlist entry admit a public host", () => {
    assert.equal(
      redirectUriAllowed("http://evil.example.com/callback", withLoopback),
      false
    );
  });

  it("rejects a fragment", () => {
    assert.equal(
      redirectUriAllowed("https://claude.ai/api/mcp/auth_callback#x", hosted),
      false
    );
  });

  it("rejects unparseable input", () => {
    assert.equal(redirectUriAllowed("///", hosted), false);
  });
});

describe("isTransportSafeRedirectUri", () => {
  it("accepts https", () => {
    assert.equal(
      isTransportSafeRedirectUri("https://claude.ai/api/mcp/auth_callback"),
      true
    );
  });

  it("accepts plain http only on loopback", () => {
    assert.equal(isTransportSafeRedirectUri("http://127.0.0.1:3118/callback"), true);
    assert.equal(isTransportSafeRedirectUri("http://localhost:3118/callback"), true);
    assert.equal(isTransportSafeRedirectUri("http://evil.example.com/cb"), false);
  });

  it("rejects a non-http scheme, including custom app schemes", () => {
    assert.equal(isTransportSafeRedirectUri("myapp://callback"), false);
    assert.equal(isTransportSafeRedirectUri("javascript:alert(1)"), false);
  });
});
