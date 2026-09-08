import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { ConfigError, loadConfig } from "../../src/config.js";

const VALID_HASH =
  "scrypt$1024$8$1$c2FsdHNhbHRzYWx0c2E$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhcw";

function baseEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    PUBLIC_URL: "https://mail.example.com",
    UPSTREAM_MCP_URL: "http://mail-mcp:3220",
    UPSTREAM_AUTH_TOKEN: "connector-token",
    SIGNING_KEY: "a".repeat(48),
    AUTH_PASSWORD_HASH: VALID_HASH,
    ...overrides,
  };
}

describe("loadConfig", () => {
  it("derives the issuer and the canonical resource", () => {
    const config = loadConfig(baseEnv());
    assert.equal(config.issuer, "https://mail.example.com");
    assert.equal(config.resource, "https://mail.example.com/mcp");
  });

  it("normalises a PUBLIC_URL with a trailing slash and mixed case", () => {
    const config = loadConfig(baseEnv({ PUBLIC_URL: "HTTPS://Mail.Example.com/" }));
    assert.equal(config.issuer, "https://mail.example.com");
    assert.equal(config.resource, "https://mail.example.com/mcp");
  });

  it("honours a custom MCP_PATH in both the path and the resource", () => {
    const config = loadConfig(baseEnv({ MCP_PATH: "/connector/mcp" }));
    assert.equal(config.mcpPath, "/connector/mcp");
    assert.equal(config.resource, "https://mail.example.com/connector/mcp");
  });

  it("treats a root MCP_PATH as an empty path component", () => {
    const config = loadConfig(baseEnv({ MCP_PATH: "/" }));
    assert.equal(config.mcpPath, "");
    assert.equal(config.resource, "https://mail.example.com");
  });

  it("applies documented defaults", () => {
    const config = loadConfig(baseEnv());
    assert.equal(config.port, 8080);
    assert.equal(config.host, "0.0.0.0");
    assert.equal(config.mcpPath, "/mcp");
    assert.equal(config.accessTokenTtl, 3600);
    assert.equal(config.refreshTokenTtl, 30 * 24 * 3600);
    assert.equal(config.authUsername, "operator");
    assert.equal(config.stateFile, "/data/oauth-state.json");
    assert.equal(config.logLevel, "info");
  });

  describe("required values", () => {
    for (const name of [
      "PUBLIC_URL",
      "UPSTREAM_AUTH_TOKEN",
      "SIGNING_KEY",
      "AUTH_PASSWORD_HASH",
    ]) {
      it(`refuses to start without ${name}`, () => {
        assert.throws(
          () => loadConfig(baseEnv({ [name]: undefined })),
          (err: unknown) =>
            err instanceof ConfigError && err.message.includes(name)
        );
      });
    }

    it("treats a blank value as absent", () => {
      assert.throws(() => loadConfig(baseEnv({ SIGNING_KEY: "   " })), ConfigError);
    });
  });

  describe("secrets from files", () => {
    it("reads a value from NAME_FILE", () => {
      const dir = mkdtempSync(join(tmpdir(), "oauth-config-"));
      const path = join(dir, "token.txt");
      writeFileSync(path, "token-from-file\n");
      const config = loadConfig(
        baseEnv({ UPSTREAM_AUTH_TOKEN: undefined, UPSTREAM_AUTH_TOKEN_FILE: path })
      );
      assert.equal(config.upstreamAuthToken, "token-from-file");
    });

    it("lets NAME_FILE win over an inline NAME", () => {
      const dir = mkdtempSync(join(tmpdir(), "oauth-config-"));
      const path = join(dir, "token.txt");
      writeFileSync(path, "from-file");
      const config = loadConfig(
        baseEnv({ UPSTREAM_AUTH_TOKEN: "inline", UPSTREAM_AUTH_TOKEN_FILE: path })
      );
      assert.equal(config.upstreamAuthToken, "from-file");
    });

    it("fails loudly on an unreadable NAME_FILE rather than falling back", () => {
      // A typo in a secret mount must stop the service, not silently downgrade it.
      assert.throws(
        () =>
          loadConfig(
            baseEnv({
              UPSTREAM_AUTH_TOKEN: "inline",
              UPSTREAM_AUTH_TOKEN_FILE: "/nonexistent/token.txt",
            })
          ),
        (err: unknown) =>
          err instanceof ConfigError && err.message.includes("UPSTREAM_AUTH_TOKEN_FILE")
      );
    });
  });

  describe("validation", () => {
    it("requires https for a public PUBLIC_URL", () => {
      assert.throws(
        () => loadConfig(baseEnv({ PUBLIC_URL: "http://mail.example.com" })),
        (err: unknown) => err instanceof ConfigError && err.message.includes("https")
      );
    });

    it("permits plain http on localhost for a local run", () => {
      const config = loadConfig(baseEnv({ PUBLIC_URL: "http://localhost:8080" }));
      assert.equal(config.issuer, "http://localhost:8080");
    });

    it("rejects a PUBLIC_URL that is not a URL", () => {
      assert.throws(() => loadConfig(baseEnv({ PUBLIC_URL: "mail.example.com" })), ConfigError);
    });

    it("rejects a signing key that is too short to be one", () => {
      assert.throws(
        () => loadConfig(baseEnv({ SIGNING_KEY: "short" })),
        (err: unknown) => err instanceof ConfigError && err.message.includes("32 bytes")
      );
    });

    it("rejects a password hash that is not a scrypt hash", () => {
      assert.throws(
        () => loadConfig(baseEnv({ AUTH_PASSWORD_HASH: "plaintext-password" })),
        (err: unknown) =>
          err instanceof ConfigError && err.message.includes("hash-password")
      );
    });

    it("rejects an unusable UPSTREAM_MCP_URL", () => {
      assert.throws(
        () => loadConfig(baseEnv({ UPSTREAM_MCP_URL: "mail-mcp:3220" })),
        ConfigError
      );
    });

    it("rejects a non-integer or non-positive port", () => {
      for (const value of ["abc", "0", "-1", "8080.5"]) {
        assert.throws(() => loadConfig(baseEnv({ PORT: value })), ConfigError);
      }
    });

    it("rejects an unknown log level", () => {
      assert.throws(() => loadConfig(baseEnv({ LOG_LEVEL: "verbose" })), ConfigError);
    });
  });

  describe("redirect allowlist", () => {
    it("always includes both Claude callbacks", () => {
      const config = loadConfig(baseEnv());
      assert.deepEqual(config.redirectAllowlist, [
        "https://claude.ai/api/mcp/auth_callback",
        "https://claude.com/api/mcp/auth_callback",
      ]);
    });

    it("leaves loopback out unless it is asked for", () => {
      const config = loadConfig(baseEnv());
      assert.equal(
        config.redirectAllowlist.some((uri) => uri.includes("127.0.0.1")),
        false
      );
    });

    it("adds loopback when ALLOW_LOOPBACK_REDIRECT is set", () => {
      const config = loadConfig(baseEnv({ ALLOW_LOOPBACK_REDIRECT: "true" }));
      assert.ok(config.redirectAllowlist.includes("http://127.0.0.1/callback"));
      assert.ok(config.redirectAllowlist.includes("http://localhost/callback"));
    });

    it("accepts extra entries", () => {
      const config = loadConfig(
        baseEnv({ EXTRA_REDIRECT_URIS: "https://a.example.com/cb, https://b.example.com/cb" })
      );
      assert.ok(config.redirectAllowlist.includes("https://a.example.com/cb"));
      assert.ok(config.redirectAllowlist.includes("https://b.example.com/cb"));
    });

    it("rejects an extra entry that could not be a redirect URI", () => {
      assert.throws(
        () => loadConfig(baseEnv({ EXTRA_REDIRECT_URIS: "http://evil.example.com/cb" })),
        ConfigError
      );
    });

    it("rejects a malformed boolean rather than guessing", () => {
      assert.throws(
        () => loadConfig(baseEnv({ ALLOW_LOOPBACK_REDIRECT: "maybe" })),
        ConfigError
      );
    });
  });
});

describe("settings signing key", () => {
  it("is absent by default", () => {
    const config = loadConfig(baseEnv());
    assert.equal(config.settingsSigningKey, null);
  });

  it("is read from SETTINGS_SIGNING_KEY", () => {
    const key = "x".repeat(32);
    const config = loadConfig(baseEnv({ SETTINGS_SIGNING_KEY: key }));
    assert.deepEqual(config.settingsSigningKey, new TextEncoder().encode(key));
  });

  it("refuses a short settings signing key", () => {
    assert.throws(
      () => loadConfig(baseEnv({ SETTINGS_SIGNING_KEY: "too-short" })),
      /at least 32 bytes/
    );
  });
});

describe("operator file", () => {
  it("defaults next to the state file", () => {
    const config = loadConfig(baseEnv({ STATE_FILE: "/data/oauth-state.json" }));
    assert.equal(config.operatorFile, "/data/operator.json");
  });

  it("can be disabled", () => {
    const config = loadConfig(baseEnv({ OPERATOR_FILE: "none" }));
    assert.equal(config.operatorFile, null);
  });
});

describe("trust proxy", () => {
  it("defaults to a single hop, not to trusting the whole chain", () => {
    // `trust proxy: true` would let a client pick its own req.ip through
    // X-Forwarded-For and step around the login throttle one address at a time.
    assert.equal(loadConfig(baseEnv()).trustProxy, 1);
  });

  it("accepts a different hop count", () => {
    assert.equal(loadConfig(baseEnv({ TRUST_PROXY: "2" })).trustProxy, 2);
  });

  it("accepts 0 for a service nothing proxies", () => {
    assert.equal(loadConfig(baseEnv({ TRUST_PROXY: "0" })).trustProxy, 0);
  });

  it("rejects a boolean or a negative value", () => {
    for (const value of ["true", "-1", "yes", "1.5"]) {
      assert.throws(
        () => loadConfig(baseEnv({ TRUST_PROXY: value })),
        ConfigError,
        `TRUST_PROXY=${value} should be rejected`
      );
    }
  });
});
