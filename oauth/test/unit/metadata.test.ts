import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  MCP_SCOPE,
  authorizationServerMetadata,
  protectedResourceMetadata,
  wwwAuthenticate,
} from "../../src/metadata.js";

const OPTIONS = {
  issuer: "https://mail.example.com",
  resource: "https://mail.example.com/mcp",
} as const;

describe("protectedResourceMetadata", () => {
  it("names the resource exactly as the operator enters it in Claude", () => {
    const doc = protectedResourceMetadata(OPTIONS);
    assert.equal(doc.resource, "https://mail.example.com/mcp");
  });

  it("lists exactly one authorization server", () => {
    // Claude uses the first entry and does not fall back to later ones, so a
    // second entry could only ever be dead weight or a misdirection.
    const doc = protectedResourceMetadata(OPTIONS);
    assert.deepEqual(doc.authorization_servers, ["https://mail.example.com"]);
  });

  it("advertises header-borne bearer tokens only", () => {
    const doc = protectedResourceMetadata(OPTIONS);
    assert.deepEqual(doc.bearer_methods_supported, ["header"]);
  });

  it("does not advertise offline_access as a resource scope", () => {
    const doc = protectedResourceMetadata(OPTIONS);
    assert.deepEqual(doc.scopes_supported, [MCP_SCOPE]);
  });
});

describe("authorizationServerMetadata", () => {
  it("advertises S256, which the MCP spec requires it to", () => {
    const doc = authorizationServerMetadata(OPTIONS);
    assert.deepEqual(doc.code_challenge_methods_supported, ["S256"]);
  });

  it("advertises a registration endpoint so Claude can obtain a client identity", () => {
    const doc = authorizationServerMetadata(OPTIONS);
    assert.equal(doc.registration_endpoint, "https://mail.example.com/register");
  });

  it("does not claim CIMD support, which would divert Claude off the DCR path", () => {
    const doc = authorizationServerMetadata(OPTIONS) as unknown as Record<string, unknown>;
    assert.equal("client_id_metadata_document_supported" in doc, false);
  });

  it("declares public clients only", () => {
    const doc = authorizationServerMetadata(OPTIONS);
    assert.deepEqual(doc.token_endpoint_auth_methods_supported, ["none"]);
  });

  it("advertises offline_access so Claude requests a refresh token", () => {
    const doc = authorizationServerMetadata(OPTIONS);
    assert.ok(doc.scopes_supported.includes("offline_access"));
  });

  it("declares the iss parameter it actually sends", () => {
    const doc = authorizationServerMetadata(OPTIONS);
    assert.equal(doc.authorization_response_iss_parameter_supported, true);
  });

  it("builds every endpoint from the issuer", () => {
    const doc = authorizationServerMetadata(OPTIONS);
    for (const endpoint of [
      doc.authorization_endpoint,
      doc.token_endpoint,
      doc.registration_endpoint,
    ]) {
      assert.ok(endpoint.startsWith(`${OPTIONS.issuer}/`), endpoint);
    }
  });
});

describe("wwwAuthenticate", () => {
  const url = "https://mail.example.com/.well-known/oauth-protected-resource/mcp";

  it("carries the resource_metadata pointer and the scope", () => {
    const header = wwwAuthenticate({ resourceMetadataUrl: url });
    assert.match(header, /^Bearer /);
    assert.ok(header.includes(`resource_metadata="${url}"`));
    assert.ok(header.includes('scope="mcp"'));
  });

  it("includes an error and description when given one", () => {
    const header = wwwAuthenticate({
      resourceMetadataUrl: url,
      error: "invalid_token",
      errorDescription: "The access token has expired.",
    });
    assert.ok(header.includes('error="invalid_token"'));
    assert.ok(header.includes('error_description="The access token has expired."'));
  });

  it("escapes a quote in the description instead of breaking the header", () => {
    const header = wwwAuthenticate({
      resourceMetadataUrl: url,
      errorDescription: 'a "quoted" value',
    });
    assert.ok(header.includes('error_description="a \\"quoted\\" value"'));
  });

  it("escapes a backslash without double-escaping its own output", () => {
    const header = wwwAuthenticate({
      resourceMetadataUrl: url,
      errorDescription: "back\\slash",
    });
    assert.ok(header.includes('error_description="back\\\\slash"'));
  });

  it("strips newlines, which would split the header", () => {
    const header = wwwAuthenticate({
      resourceMetadataUrl: url,
      errorDescription: "line one\r\nX-Injected: yes",
    });
    assert.equal(header.includes("\n"), false);
    assert.equal(header.includes("\r"), false);
  });
});
