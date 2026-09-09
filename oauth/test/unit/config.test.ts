import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
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

  describe("the claim token file", () => {
    it("defaults to the data volume, beside the operator record", () => {
      const config = loadConfig(baseEnv());
      assert.equal(config.operatorFile, "/data/operator.json");
      assert.equal(config.claimTokenFile, "/data/claim-token.txt");
    });

    it("follows STATE_FILE onto whatever volume that names", () => {
      const config = loadConfig(baseEnv({ STATE_FILE: "/srv/oauth/state.json" }));
      assert.equal(config.claimTokenFile, "/srv/oauth/claim-token.txt");
    });

    it("is null when there is no state file, and when set to none", () => {
      assert.equal(loadConfig(baseEnv({ STATE_FILE: "none" })).claimTokenFile, null);
      assert.equal(loadConfig(baseEnv({ CLAIM_TOKEN_FILE: "none" })).claimTokenFile, null);
    });

    it("honours an explicit CLAIM_TOKEN_FILE", () => {
      assert.equal(
        loadConfig(baseEnv({ CLAIM_TOKEN_FILE: "/data/claim.txt" })).claimTokenFile,
        "/data/claim.txt"
      );
    });
  });

  describe("required values", () => {
    for (const name of ["PUBLIC_URL", "UPSTREAM_AUTH_TOKEN", "SIGNING_KEY"]) {
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

    it("starts without AUTH_PASSWORD_HASH, unconfigured rather than broken", () => {
      // Since the claim-token gate, a missing password hash is a *state* — an
      // instance nobody has claimed yet — not a misconfiguration. bootstrap.ts
      // decides what such an instance is allowed to answer.
      const config = loadConfig(baseEnv({ AUTH_PASSWORD_HASH: undefined }));
      assert.equal(config.authPasswordHash, null);
    });

    it("remembers the AUTH_PASSWORD_HASH_FILE path even when nothing is there", () => {
      // The expectation outlives the file. bootstrap.ts refuses to boot a used
      // data volume whose hash has gone missing, and the one thing that message
      // has to carry is the path the operator can go and look at.
      const dir = mkdtempSync(join(tmpdir(), "oauth-config-"));
      const path = join(dir, "auth_password_hash.txt");

      const config = loadConfig(
        baseEnv({ AUTH_PASSWORD_HASH: undefined, AUTH_PASSWORD_HASH_FILE: path })
      );

      assert.equal(config.authPasswordHash, null, "nothing was read");
      assert.equal(config.authPasswordHashFile, path);
      assert.equal(existsSync(path), false, "and nothing was written either");
    });

    it("has no hash path to name when the hash was given inline or not at all", () => {
      assert.equal(loadConfig(baseEnv()).authPasswordHashFile, null);
      assert.equal(
        loadConfig(baseEnv({ AUTH_PASSWORD_HASH: undefined })).authPasswordHashFile,
        null
      );
    });

    it("still refuses a malformed AUTH_PASSWORD_HASH", () => {
      // Absent is a state; present-but-wrong is a typo, and stays fatal.
      assert.throws(
        () => loadConfig(baseEnv({ AUTH_PASSWORD_HASH: "not-a-hash" })),
        ConfigError
      );
    });
  });

  describe("a password hash file that holds nothing", () => {
    // The one thing the layer's two readers disagreed about. The reader this
    // module used to carry called an empty file "no hash" outright; resolveSecret
    // calls it an absent file, which is what the rule in ./secrets.ts says and
    // means the inline value still counts. There is one answer now.
    it("is an unclaimed instance rather than a boot failure", () => {
      const dir = mkdtempSync(join(tmpdir(), "oauth-config-"));
      const path = join(dir, "auth_password_hash.txt");
      writeFileSync(path, "\n");

      const config = loadConfig(
        baseEnv({ AUTH_PASSWORD_HASH: undefined, AUTH_PASSWORD_HASH_FILE: path })
      );

      assert.equal(config.authPasswordHash, null);
      assert.equal(config.authPasswordHashFile, path);
      assert.equal(readFileSync(path, "utf8"), "\n", "and is never generated over");
    });

    it("still lets an inline hash through, exactly as an absent file does", () => {
      const dir = mkdtempSync(join(tmpdir(), "oauth-config-"));
      const path = join(dir, "auth_password_hash.txt");
      writeFileSync(path, "   \n");

      const config = loadConfig(baseEnv({ AUTH_PASSWORD_HASH_FILE: path }));

      assert.equal(config.authPasswordHash, VALID_HASH);
      assert.equal(
        config.secretReport.find((entry) => entry.name === "AUTH_PASSWORD_HASH")?.source,
        "environment"
      );
    });
  });

  describe("plain settings are not secrets", () => {
    // Routing `optional()` through a secret reader gave every plain setting an
    // accidental `_FILE` twin: HOST_FILE, STATE_FILE_FILE, MCP_PATH_FILE and the
    // rest were live, undocumented environment variables that nothing set and
    // nothing meant. A path is not a secret and has no business being loadable
    // from a secret file.
    it("ignores the _FILE twin of a plain setting", () => {
      const dir = mkdtempSync(join(tmpdir(), "oauth-config-"));
      const path = join(dir, "not-a-secret.txt");
      writeFileSync(path, "10.0.0.1\n");

      const config = loadConfig(
        baseEnv({ HOST_FILE: path, STATE_FILE_FILE: path, MCP_PATH_FILE: path })
      );

      assert.equal(config.host, "0.0.0.0");
      assert.equal(config.stateFile, "/data/oauth-state.json");
      assert.equal(config.mcpPath, "/mcp");
    });

    it("does not read PUBLIC_URL out of a file either", () => {
      const dir = mkdtempSync(join(tmpdir(), "oauth-config-"));
      const path = join(dir, "public-url.txt");
      writeFileSync(path, "https://mail.example.com\n");

      assert.throws(
        () => loadConfig(baseEnv({ PUBLIC_URL: undefined, PUBLIC_URL_FILE: path })),
        (err: unknown) => err instanceof ConfigError && err.message.includes("PUBLIC_URL")
      );
    });

    it("names only the variable that is missing, not a file form that is not read", () => {
      assert.throws(
        () => loadConfig(baseEnv({ PUBLIC_URL: undefined })),
        (err: unknown) =>
          err instanceof ConfigError &&
          err.message === "Missing required configuration: PUBLIC_URL. See oauth/.env.example."
      );
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

  describe("secrets that generate themselves", () => {
    /** The four secret files a deployment mounts, as env pointing at `dir`. */
    function secretFiles(dir: string) {
      return {
        UPSTREAM_AUTH_TOKEN: undefined,
        UPSTREAM_AUTH_TOKEN_FILE: join(dir, "auth_token.txt"),
        SIGNING_KEY: undefined,
        SIGNING_KEY_FILE: join(dir, "oauth_signing_key.txt"),
        AUTH_PASSWORD_HASH: undefined,
        AUTH_PASSWORD_HASH_FILE: join(dir, "auth_password_hash.txt"),
        SETTINGS_SIGNING_KEY_FILE: join(dir, "settings_signing_key.txt"),
      };
    }

    function sources(config: { secretReport: { name: string; source: string }[] }) {
      return Object.fromEntries(config.secretReport.map((e) => [e.name, e.source]));
    }

    it("boots with an empty secrets directory, generating the three random ones", () => {
      const dir = mkdtempSync(join(tmpdir(), "oauth-config-"));
      // Only the password hash is supplied by hand; it is never generated.
      writeFileSync(join(dir, "auth_password_hash.txt"), `${VALID_HASH}\n`);

      const config = loadConfig(baseEnv(secretFiles(dir)));

      assert.deepEqual(sources(config), {
        UPSTREAM_AUTH_TOKEN: "generated",
        SIGNING_KEY: "generated",
        AUTH_PASSWORD_HASH: "file",
        SETTINGS_SIGNING_KEY: "generated",
      });
      assert.ok(config.upstreamAuthToken.length > 0);
      assert.ok(config.signingKey.length >= 32);
      assert.ok(config.settingsSigningKey);
      assert.equal(
        readFileSync(join(dir, "auth_token.txt"), "utf8").trim(),
        config.upstreamAuthToken
      );
    });

    it("uses all four files unchanged when they are all present, writing nothing", () => {
      // The upgrade path. A new AUTH_TOKEN here drops every connected Claude
      // client at once, so this is the test that matters most in this file.
      const dir = mkdtempSync(join(tmpdir(), "oauth-config-"));
      writeFileSync(join(dir, "auth_token.txt"), "live-connector-token\n");
      writeFileSync(join(dir, "oauth_signing_key.txt"), `${"s".repeat(48)}\n`);
      writeFileSync(join(dir, "auth_password_hash.txt"), `${VALID_HASH}\n`);
      writeFileSync(join(dir, "settings_signing_key.txt"), `${"t".repeat(48)}\n`);
      const before = readdirSync(dir).map((name) => [name, statSync(join(dir, name)).mtimeMs]);

      const config = loadConfig(baseEnv(secretFiles(dir)));

      assert.equal(config.upstreamAuthToken, "live-connector-token");
      assert.deepEqual(new TextDecoder().decode(config.signingKey), "s".repeat(48));
      assert.deepEqual(
        new TextDecoder().decode(config.settingsSigningKey ?? new Uint8Array()),
        "t".repeat(48)
      );
      assert.deepEqual(sources(config), {
        UPSTREAM_AUTH_TOKEN: "file",
        SIGNING_KEY: "file",
        AUTH_PASSWORD_HASH: "file",
        SETTINGS_SIGNING_KEY: "file",
      });
      assert.deepEqual(
        readdirSync(dir).map((name) => [name, statSync(join(dir, name)).mtimeMs]),
        before
      );
    });

    it("replaces a blank auth_token.txt instead of proxying with an empty token", () => {
      // UPSTREAM_AUTH_TOKEN has no length check to catch this, so "" reached the
      // proxy intact and the connector rejected every forwarded request.
      const dir = mkdtempSync(join(tmpdir(), "oauth-config-"));
      writeFileSync(join(dir, "auth_token.txt"), "");
      writeFileSync(join(dir, "auth_password_hash.txt"), `${VALID_HASH}\n`);

      const config = loadConfig(baseEnv(secretFiles(dir)));

      assert.notEqual(config.upstreamAuthToken, "");
      assert.equal(sources(config).UPSTREAM_AUTH_TOKEN, "replaced");
      assert.equal(
        readFileSync(join(dir, "auth_token.txt"), "utf8").trim(),
        config.upstreamAuthToken
      );
    });

    it("replaces a blank signing key instead of failing its own length check", () => {
      // SIGNING_KEY was saved from the silent version of this defect by its
      // 32-byte floor — as a fatal ConfigError, which is better than a quiet 401
      // and still a service that will not boot until somebody edits a file.
      const dir = mkdtempSync(join(tmpdir(), "oauth-config-"));
      writeFileSync(join(dir, "oauth_signing_key.txt"), "   \n");
      writeFileSync(join(dir, "auth_password_hash.txt"), `${VALID_HASH}\n`);

      const config = loadConfig(baseEnv(secretFiles(dir)));

      assert.ok(config.signingKey.length >= 32);
      assert.equal(sources(config).SIGNING_KEY, "replaced");
    });

    it("keeps the present ones and generates only the rest", () => {
      const dir = mkdtempSync(join(tmpdir(), "oauth-config-"));
      writeFileSync(join(dir, "auth_token.txt"), "live-connector-token\n");
      writeFileSync(join(dir, "auth_password_hash.txt"), `${VALID_HASH}\n`);

      const config = loadConfig(baseEnv(secretFiles(dir)));

      assert.equal(config.upstreamAuthToken, "live-connector-token");
      assert.deepEqual(sources(config), {
        UPSTREAM_AUTH_TOKEN: "file",
        SIGNING_KEY: "generated",
        AUTH_PASSWORD_HASH: "file",
        SETTINGS_SIGNING_KEY: "generated",
      });
    });

    it("reads back what the previous boot generated, rather than rotating it", () => {
      const dir = mkdtempSync(join(tmpdir(), "oauth-config-"));
      writeFileSync(join(dir, "auth_password_hash.txt"), `${VALID_HASH}\n`);
      const env = baseEnv(secretFiles(dir));

      const first = loadConfig(env);
      const second = loadConfig(env);

      assert.equal(second.upstreamAuthToken, first.upstreamAuthToken);
      assert.deepEqual(second.signingKey, first.signingKey);
      assert.deepEqual(sources(second), {
        UPSTREAM_AUTH_TOKEN: "file",
        SIGNING_KEY: "file",
        AUTH_PASSWORD_HASH: "file",
        SETTINGS_SIGNING_KEY: "file",
      });
    });

    it("never generates the password hash", () => {
      // The one secret with a meaning outside this deployment. An absent file is
      // an unclaimed instance, not something this process can invent a value for,
      // so it boots with a null hash and writes nothing.
      const dir = mkdtempSync(join(tmpdir(), "oauth-config-"));

      const config = loadConfig(baseEnv(secretFiles(dir)));

      assert.equal(config.authPasswordHash, null);
      assert.equal(existsSync(join(dir, "auth_password_hash.txt")), false);
      assert.ok(
        !config.secretReport.some((entry) => entry.name === "AUTH_PASSWORD_HASH"),
        "nothing to report about a secret that was not configured"
      );
    });

    it("still fails loudly on a password hash file it cannot read", () => {
      // ENOENT is a state; anything else is a broken mount and must stop the
      // service rather than silently downgrade it to unclaimed.
      const dir = mkdtempSync(join(tmpdir(), "oauth-config-"));
      assert.throws(
        () =>
          loadConfig(
            baseEnv({
              ...secretFiles(dir),
              AUTH_PASSWORD_HASH_FILE: dir,
            })
          ),
        (err: unknown) =>
          err instanceof ConfigError && err.message.includes("AUTH_PASSWORD_HASH_FILE")
      );
    });

    it("seeds the file from an inline UPSTREAM_AUTH_TOKEN rather than generating one", () => {
      // Upgrading an install that carried the token in .env only: the OAuth layer
      // must keep that token, and write it where the connector will read it.
      const dir = mkdtempSync(join(tmpdir(), "oauth-config-"));
      writeFileSync(join(dir, "auth_password_hash.txt"), `${VALID_HASH}\n`);

      const config = loadConfig(
        baseEnv({ ...secretFiles(dir), UPSTREAM_AUTH_TOKEN: "token-from-dot-env" })
      );

      assert.equal(config.upstreamAuthToken, "token-from-dot-env");
      assert.equal(sources(config).UPSTREAM_AUTH_TOKEN, "seeded");
      assert.equal(
        readFileSync(join(dir, "auth_token.txt"), "utf8").trim(),
        "token-from-dot-env"
      );
    });

    it("reports nothing for a secret that is not configured at all", () => {
      // SETTINGS_SIGNING_KEY is optional: absent means the settings UI is off,
      // not that something needs generating.
      const config = loadConfig(baseEnv());
      assert.equal(config.settingsSigningKey, null);
      assert.equal(sources(config).SETTINGS_SIGNING_KEY, undefined);
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

  it("trims an inline value, matching the connector's SETTINGS_SIGNING_KEY handling", () => {
    // Both services must derive byte-identical keys from the same secret. A
    // trailing newline pasted from `openssl rand -base64 48` output must not
    // change the key on one side but not the other.
    const key = "x".repeat(32);
    const config = loadConfig(
      baseEnv({ SETTINGS_SIGNING_KEY: `  ${key}  \n` })
    );
    assert.deepEqual(config.settingsSigningKey, new TextEncoder().encode(key));
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
