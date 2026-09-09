/**
 * The precedence rule from src/secrets.ts, pinned.
 *
 * Deliberately a near-copy of oauth/test/unit/secrets.test.ts: the module under
 * test is duplicated across the two packages, so the guarantee has to be pinned
 * on both sides rather than on whichever one a contributor happens to run.
 *
 * "A present file wins, an absent one is generated" is the entire safety
 * property of self-generating secrets: get it backwards and every already-running
 * deployment comes back up with a new AUTH_TOKEN and drops every connected
 * Claude client. These tests exist so that cannot regress quietly.
 */

import { strict as assert } from "node:assert";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import type { LogLevel } from "../../src/app.js";
import {
  GENERATED_SECRET_MODE,
  SHARED_SECRET_GID,
  SecretError,
  createExclusively,
  logSecretReport,
  resolveSecret,
  type SecretReportEntry,
} from "../../src/secrets.js";

/** Node reports a crude, non-POSIX mode on Windows; the mode only matters in the images. */
const posixOnly = process.platform === "win32" ? { skip: "POSIX file modes only" } : {};

function workdir(): string {
  return mkdtempSync(join(tmpdir(), "mailmcp-secrets-"));
}

describe("resolveSecret", () => {
  describe("a present file wins", () => {
    it("reads the file and writes nothing", () => {
      const dir = workdir();
      const path = join(dir, "auth_token.txt");
      writeFileSync(path, "already-deployed\n");
      const before = statSync(path).mtimeMs;

      const resolved = resolveSecret({ AUTH_TOKEN_FILE: path }, "AUTH_TOKEN");

      assert.equal(resolved.value, "already-deployed");
      assert.equal(resolved.source, "file");
      assert.equal(resolved.path, path);
      assert.equal(statSync(path).mtimeMs, before);
      assert.equal(readFileSync(path, "utf8"), "already-deployed\n");
    });

    it("wins over an inline value, and over generating one", () => {
      // The upgrade case that must not break: a deployment with both a mounted
      // secret and a stale inline value keeps the mounted one.
      const dir = workdir();
      const path = join(dir, "auth_token.txt");
      writeFileSync(path, "from-file");

      const resolved = resolveSecret(
        { AUTH_TOKEN: "from-env", AUTH_TOKEN_FILE: path },
        "AUTH_TOKEN"
      );

      assert.equal(resolved.value, "from-file");
      assert.equal(resolved.source, "file");
    });

    it("trims the file's trailing newline", () => {
      // Both services derive an HMAC key from the same bytes; a newline that
      // survives on one side and not the other fails every verification.
      const dir = workdir();
      const path = join(dir, "key.txt");
      writeFileSync(path, "  padded-value  \n");
      assert.equal(resolveSecret({ K_FILE: path }, "K").value, "padded-value");
    });

    it("stays fatal when the file exists but cannot be read", () => {
      // A directory where a file was expected: a typo in a secret mount must stop
      // the service, not quietly generate a replacement for a secret that is
      // really there.
      const dir = workdir();
      const path = join(dir, "not-a-file");
      mkdirSync(path);
      assert.throws(
        () => resolveSecret({ K_FILE: path }, "K"),
        (err: unknown) => err instanceof SecretError && err.message.includes("K_FILE")
      );
    });
  });

  describe("an absent file is generated", () => {
    it("creates the file and reports it as generated", () => {
      const dir = workdir();
      const path = join(dir, "oauth_signing_key.txt");

      const resolved = resolveSecret({ SIGNING_KEY_FILE: path }, "SIGNING_KEY");

      assert.equal(resolved.source, "generated");
      assert.equal(resolved.path, path);
      assert.ok(resolved.value);
      assert.equal(readFileSync(path, "utf8").trim(), resolved.value);
    });

    it("generates a key long enough to pass the 32-byte signing-key check", () => {
      const dir = workdir();
      const value = resolveSecret({ K_FILE: join(dir, "k.txt") }, "K").value ?? "";
      assert.ok(new TextEncoder().encode(value).length >= 32);
    });

    it("generates a different value each time", () => {
      const dir = workdir();
      const first = resolveSecret({ K_FILE: join(dir, "one.txt") }, "K").value;
      const second = resolveSecret({ K_FILE: join(dir, "two.txt") }, "K").value;
      assert.notEqual(first, second);
    });

    it("reads back the same value on the next boot, rather than rotating", () => {
      const dir = workdir();
      const env = { K_FILE: join(dir, "k.txt") };
      const first = resolveSecret(env, "K");
      const second = resolveSecret(env, "K");
      assert.equal(second.value, first.value);
      assert.equal(second.source, "file");
    });

    it("leaves no temp file behind", () => {
      const dir = workdir();
      resolveSecret({ K_FILE: join(dir, "k.txt") }, "K");
      assert.deepEqual(readdirSync(dir), ["k.txt"]);
    });

    it("declares a mode the other image's uid can read, and nobody else", () => {
      // 0600 is the intuitive mode for a secret and the documented crash loop:
      // the two images run as different non-root uids, and both read the shared
      // auth_token and settings_signing_key. They read it through the group they
      // share (see SHARED_SECRET_GID), which is why this is 0640 and not 0644 —
      // a world-readable secret hands every account on the host the connector's
      // token. Asserted on every platform, because the constant is the decision.
      assert.equal(GENERATED_SECRET_MODE & 0o040, 0o040, "must be group-readable");
      assert.equal(GENERATED_SECRET_MODE & 0o007, 0, "must be closed to other");
      assert.equal(GENERATED_SECRET_MODE & 0o020, 0, "must not be group-writable");
    });

    it("writes that mode to disk", posixOnly, () => {
      const dir = workdir();
      const path = join(dir, "k.txt");
      resolveSecret({ K_FILE: path }, "K");
      assert.equal(statSync(path).mode & 0o777, GENERATED_SECRET_MODE);
    });

    it("seeds the file from an inline value instead of generating a second one", () => {
      // An Option A install carries AUTH_TOKEN in .env and has no secrets file.
      // Generating here would hand the OAuth layer a different token and 401
      // every proxied request; the inline value has to reach the file.
      const dir = workdir();
      const path = join(dir, "auth_token.txt");

      const resolved = resolveSecret(
        { AUTH_TOKEN: "existing-deployment-token", AUTH_TOKEN_FILE: path },
        "AUTH_TOKEN"
      );

      assert.equal(resolved.value, "existing-deployment-token");
      assert.equal(resolved.source, "seeded");
      assert.equal(readFileSync(path, "utf8").trim(), "existing-deployment-token");
    });

    it("is fatal when the file cannot be created", () => {
      // Not a warning: a secret this process could not persist is one the other
      // service will never see, and the failure would surface as an unexplained
      // 401 hours later instead of a line in `docker compose logs`.
      assert.throws(
        () => resolveSecret({ K_FILE: "/nonexistent-directory/k.txt" }, "K"),
        (err: unknown) =>
          err instanceof SecretError &&
          err.message.includes("K_FILE") &&
          // and says what to do about it, since the usual cause is a secrets
          // directory the shared group cannot write to
          err.message.includes("chmod 2770")
      );
    });

    it("refuses to generate a secret marked as never generated", () => {
      const dir = workdir();
      assert.throws(
        () =>
          resolveSecret({ AUTH_PASSWORD_HASH_FILE: join(dir, "h.txt") }, "AUTH_PASSWORD_HASH", {
            generate: false,
          }),
        (err: unknown) =>
          err instanceof SecretError && err.message.includes("never generated")
      );
      assert.equal(existsSync(join(dir, "h.txt")), false);
    });

  });

  describe("a concurrent first boot", () => {
    // Both services generate the shared auth_token and settings_signing_key at
    // the same moment on a first `docker compose up`. The loser must adopt the
    // winner's bytes: two different settings signing keys means every settings
    // request fails its assertion, with nothing in the log to explain it.
    it("adopts the winner's value instead of clobbering it", () => {
      const dir = workdir();
      const path = join(dir, "settings_signing_key.txt");
      writeFileSync(path, "written-by-the-other-service\n");

      const created = createExclusively(path, "mine", "SETTINGS_SIGNING_KEY");

      assert.equal(created.raced, true);
      assert.equal(created.value, "written-by-the-other-service");
      assert.equal(readFileSync(path, "utf8"), "written-by-the-other-service\n");
      assert.deepEqual(readdirSync(dir), ["settings_signing_key.txt"]);
    });
  });

  describe("without a NAME_FILE", () => {
    it("uses the inline value and writes nothing", () => {
      const resolved = resolveSecret({ K: "  inline  " }, "K");
      assert.equal(resolved.value, "inline");
      assert.equal(resolved.source, "environment");
      assert.equal(resolved.path, null);
    });

    it("reports nothing at all when the secret is not configured", () => {
      const resolved = resolveSecret({}, "K");
      assert.equal(resolved.value, undefined);
      assert.equal(resolved.source, undefined);
    });

    it("treats a blank NAME_FILE as unset", () => {
      const resolved = resolveSecret({ K: "inline", K_FILE: "   " }, "K");
      assert.equal(resolved.value, "inline");
      assert.equal(resolved.source, "environment");
    });
  });
});

describe("logSecretReport", () => {
  it("states, per secret, whether it was read or generated", () => {
    const lines: Array<{ level: LogLevel; message: string; extra?: Record<string, unknown> }> = [];
    const report: SecretReportEntry[] = [
      { name: "UPSTREAM_AUTH_TOKEN", source: "file", path: "/secrets/auth_token.txt" },
      { name: "SIGNING_KEY", source: "generated", path: "/secrets/oauth_signing_key.txt" },
      { name: "AUTH_PASSWORD_HASH", source: "environment", path: null },
    ];

    logSecretReport(report, (level, message, extra) => lines.push({ level, message, extra }));

    assert.equal(lines.length, 3);
    assert.deepEqual(
      lines.map((line) => [line.extra?.secret, line.extra?.source]),
      [
        ["UPSTREAM_AUTH_TOKEN", "file"],
        ["SIGNING_KEY", "generated"],
        ["AUTH_PASSWORD_HASH", "environment"],
      ]
    );
    assert.equal(lines[0]?.level, "info");
    assert.equal(lines[0]?.extra?.path, "/secrets/auth_token.txt");
    assert.equal("path" in (lines[2]?.extra ?? {}), false);
  });

  it("never logs the value itself", () => {
    const lines: string[] = [];
    logSecretReport(
      [{ name: "SIGNING_KEY", source: "generated", path: "/secrets/oauth_signing_key.txt" }],
      (_level, message, extra) => lines.push(JSON.stringify({ message, extra }))
    );
    assert.equal(lines.length, 1);
    assert.ok(!lines[0]?.includes("value"));
  });
});

describe("the two copies of this module", () => {
  // Nothing in the build stops the connector's copy and the OAuth layer's from
  // drifting, and drift here stays invisible until the day a settings assertion
  // stops verifying between two services that derive their key differently.
  it("stay identical below the header comment", () => {
    const body = (url: URL): string =>
      readFileSync(url, "utf8")
        // Line endings first. On a CRLF checkout the header ends `*/\r\n`, the
        // regex below does not match it, and the comparison then fails on the
        // one paragraph that is supposed to differ.
        .replace(/\r\n/g, "\n")
        // The header names the *other* package, so it differs on purpose.
        .replace(/^\/\*\*[\s\S]*?\*\/\n/, "")
        // The Logger type lives in a different module in each package.
        .replace('from "./app.js"', 'from "./logger.js"');

    assert.equal(
      body(new URL("../../src/secrets.ts", import.meta.url)),
      body(new URL("../../oauth/src/secrets.ts", import.meta.url)),
      "src/secrets.ts and oauth/src/secrets.ts have drifted — change one, change the other"
    );
  });
});

describe("the shared group contract", () => {
  // SHARED_SECRET_GID is written down in three places: here, Dockerfile and
  // oauth/Dockerfile. It is the only group the two images have in common, and a
  // mode-640 secret written by one is unreadable to the other the moment those
  // numbers disagree — as an EACCES crash loop at startup, in whichever service
  // did not write the file. Nothing else in the build would notice.
  const dockerfiles = {
    "Dockerfile": new URL("../../Dockerfile", import.meta.url),
    "oauth/Dockerfile": new URL("../../oauth/Dockerfile", import.meta.url),
  };

  for (const [name, url] of Object.entries(dockerfiles)) {
    it(`${name} creates mailsecrets with gid ${SHARED_SECRET_GID}`, () => {
      const dockerfile = readFileSync(url, "utf8");
      assert.match(
        dockerfile,
        new RegExp(`addgroup -S -g ${SHARED_SECRET_GID} mailsecrets`),
        `${name} must pin gid ${SHARED_SECRET_GID} for mailsecrets`
      );
    });

    it(`${name} puts its runtime user in mailsecrets`, () => {
      // Creating the group is not enough — the runtime user has to be *in* it.
      const dockerfile = readFileSync(url, "utf8");
      assert.match(dockerfile, /addgroup mail(mcp|oauth) mailsecrets/);
    });

    it(`${name} publishes the gid as a label`, () => {
      const dockerfile = readFileSync(url, "utf8");
      assert.match(dockerfile, new RegExp(`secrets-gid="${SHARED_SECRET_GID}"`));
    });
  }
});
