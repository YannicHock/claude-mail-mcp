import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  escapeHtml,
  isSameOrigin,
  renderErrorPage,
  renderLoginPage,
  signAuthorizationRequest,
  verifyAuthorizationRequest,
  type AuthorizationRequest,
} from "../../src/login.js";

const KEY = new TextEncoder().encode("test-signing-key-at-least-32-bytes-long");
const ISSUER = "https://mail.example.com";

const REQUEST: AuthorizationRequest = {
  clientId: "client-1",
  redirectUri: "https://claude.ai/api/mcp/auth_callback",
  codeChallenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  scope: "mcp",
  resource: "https://mail.example.com/mcp",
  state: "opaque",
  clientName: "Claude",
};

describe("authorization request tokens", () => {
  it("round-trips every field the token endpoint later relies on", async () => {
    const token = await signAuthorizationRequest(REQUEST, KEY, ISSUER);
    const verified = await verifyAuthorizationRequest(token, KEY, ISSUER);
    assert.deepEqual(verified, REQUEST);
  });

  it("round-trips without the optional fields", async () => {
    const minimal: AuthorizationRequest = {
      clientId: "c",
      redirectUri: "https://claude.ai/api/mcp/auth_callback",
      codeChallenge: REQUEST.codeChallenge,
      scope: "mcp",
      resource: REQUEST.resource,
    };
    const token = await signAuthorizationRequest(minimal, KEY, ISSUER);
    assert.deepEqual(await verifyAuthorizationRequest(token, KEY, ISSUER), minimal);
  });

  it("rejects a token signed with a different key, which is what makes it a CSRF token", async () => {
    const token = await signAuthorizationRequest(REQUEST, KEY, ISSUER);
    const otherKey = new TextEncoder().encode("a-completely-different-key-32-bytes!!");
    assert.equal(await verifyAuthorizationRequest(token, otherKey, ISSUER), null);
  });

  it("rejects a token from a different issuer", async () => {
    const token = await signAuthorizationRequest(REQUEST, KEY, "https://other.example.com");
    assert.equal(await verifyAuthorizationRequest(token, KEY, ISSUER), null);
  });

  it("rejects garbage and empty input", async () => {
    for (const bad of ["", "not.a.jwt", "a.b.c"]) {
      assert.equal(await verifyAuthorizationRequest(bad, KEY, ISSUER), null);
    }
  });

  it("rejects an access token presented as a request token", async () => {
    // Both are signed with the same key, so the token_use claim is the only thing
    // keeping the two apart.
    const { SignJWT } = await import("jose");
    const foreign = await new SignJWT({ token_use: "access", client_id: "c" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer(ISSUER)
      .setAudience(ISSUER)
      .setExpirationTime("10m")
      .sign(KEY);
    assert.equal(await verifyAuthorizationRequest(foreign, KEY, ISSUER), null);
  });
});

describe("isSameOrigin", () => {
  it("accepts a matching Origin", () => {
    assert.equal(isSameOrigin({ origin: ISSUER }, ISSUER), true);
  });

  it("accepts a Referer when Origin is absent", () => {
    assert.equal(isSameOrigin({ referer: `${ISSUER}/authorize?x=1` }, ISSUER), true);
  });

  it("prefers Origin over Referer", () => {
    assert.equal(
      isSameOrigin({ origin: "https://evil.example.com", referer: ISSUER }, ISSUER),
      false
    );
  });

  it("rejects a foreign origin", () => {
    assert.equal(isSameOrigin({ origin: "https://evil.example.com" }, ISSUER), false);
  });

  it("rejects an origin that merely starts with the expected one", () => {
    assert.equal(
      isSameOrigin({ origin: "https://mail.example.com.evil.example.com" }, ISSUER),
      false
    );
  });

  it("rejects a request carrying neither header", () => {
    assert.equal(isSameOrigin({}, ISSUER), false);
    assert.equal(isSameOrigin({ origin: "", referer: "" }, ISSUER), false);
  });

  it("rejects the literal 'null' origin a sandboxed frame sends", () => {
    assert.equal(isSameOrigin({ origin: "null" }, ISSUER), false);
  });

  it("rejects an unparseable header", () => {
    assert.equal(isSameOrigin({ origin: "://" }, ISSUER), false);
  });
});

describe("escapeHtml", () => {
  it("escapes every character that could break out of markup", () => {
    assert.equal(
      escapeHtml(`<script>alert("x")&'`),
      "&lt;script&gt;alert(&quot;x&quot;)&amp;&#39;"
    );
  });

  it("leaves ordinary text alone", () => {
    assert.equal(escapeHtml("Claude"), "Claude");
  });
});

describe("renderLoginPage", () => {
  it("shows the redirect host so the operator can see where this goes", () => {
    const html = renderLoginPage({
      requestToken: "token",
      redirectHost: "claude.ai",
    });
    assert.ok(html.includes("claude.ai"));
  });

  it("escapes a hostile client_name instead of rendering it", () => {
    // client_name is whatever the registering client claimed it was.
    const html = renderLoginPage({
      requestToken: "token",
      redirectHost: "claude.ai",
      clientName: '<img src=x onerror="alert(1)">',
    });
    assert.equal(html.includes("<img src=x"), false);
    assert.ok(html.includes("&lt;img src=x"));
  });

  it("escapes the request token in the hidden field", () => {
    const html = renderLoginPage({
      requestToken: 'abc" autofocus onfocus="alert(1)',
      redirectHost: "claude.ai",
    });
    assert.equal(html.includes('onfocus="alert(1)'), false);
  });

  it("escapes an error message", () => {
    const html = renderLoginPage({
      requestToken: "t",
      redirectHost: "claude.ai",
      error: "<b>bad</b>",
    });
    assert.equal(html.includes("<b>bad</b>"), false);
  });

  it("posts back to /authorize", () => {
    const html = renderLoginPage({ requestToken: "t", redirectHost: "claude.ai" });
    assert.ok(html.includes('method="post"'));
    assert.ok(html.includes('action="/authorize"'));
  });

  it("asks not to be indexed", () => {
    const html = renderLoginPage({ requestToken: "t", redirectHost: "claude.ai" });
    assert.ok(html.includes("noindex"));
  });
});

describe("renderErrorPage", () => {
  it("escapes its title and detail", () => {
    const html = renderErrorPage("<b>t</b>", "<i>d</i>");
    assert.equal(html.includes("<b>t</b>"), false);
    assert.equal(html.includes("<i>d</i>"), false);
  });
});
