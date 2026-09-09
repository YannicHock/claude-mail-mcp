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
import { dirname, join } from "node:path";
import { describe, it } from "node:test";

import type { LogLevel } from "../../src/app.js";
import {
  GENERATED_SECRET_MODE,
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
      // share — the one that owns the setgid directory the file is created in,
      // named to the stack as SECRETS_GID — which is why this is 0640 and not 0644 —
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
          err.message.includes("2770")
      );
    });

    it("names the directory it failed in, and the operator's own group", () => {
      // This message is read at the exact moment somebody is stuck, so what it
      // names has to still be true. #76 removed the pinned gid — the group is
      // the operator's now and this stack knows it only as SECRETS_GID — and
      // #77 split secrets/ into secrets/shared and secrets/oauth, so "the
      // secrets directory" is no longer one place. Naming dirname(path) is the
      // only phrasing that survives both: it is the directory the write
      // actually failed in, whichever of the two that was.
      const path = "/nonexistent-directory/k.txt";
      assert.throws(
        () => resolveSecret({ K_FILE: path }, "K"),
        (err: unknown) =>
          err instanceof SecretError &&
          err.message.includes(dirname(path)) &&
          err.message.includes("SECRETS_GID") &&
          // The gid #76 removed, and the flat directory #77 replaced. Either one
          // in this message sends an operator to fix a thing that is not there.
          !/\b105\b/.test(err.message) &&
          !/chgrp/.test(err.message)
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

  describe("an empty file is replaced, not adopted", () => {
    // The defect this block exists for. A file that was there but held nothing
    // resolved to "" with source "file", and `bearerAuth`'s /^Bearer\s+(.+)$/
    // can never produce the empty string — so every /mcp and /settings request
    // answered 401 for the life of the container, while the only line in the
    // log said the secret had been read from its file.

    it("generates a real secret over a file that holds nothing", () => {
      const dir = workdir();
      const path = join(dir, "auth_token.txt");
      writeFileSync(path, "");

      const resolved = resolveSecret({ AUTH_TOKEN_FILE: path }, "AUTH_TOKEN");

      assert.notEqual(resolved.value, "");
      assert.ok((resolved.value ?? "").length > 0);
      assert.equal(resolved.source, "replaced");
      assert.equal(readFileSync(path, "utf8").trim(), resolved.value);
      // Replaced in place, not left beside a temp file or a second copy.
      assert.deepEqual(readdirSync(dir), ["auth_token.txt"]);
    });

    it("treats a file of whitespace as empty", () => {
      const dir = workdir();
      const path = join(dir, "k.txt");
      writeFileSync(path, "\n \t\n");

      const resolved = resolveSecret({ K_FILE: path }, "K");

      assert.ok((resolved.value ?? "").length > 0);
      assert.equal(resolved.source, "replaced");
    });

    it("seeds the inline value into it rather than generating a second one", () => {
      // A blank file must not cost an Option A upgrade its token: the OAuth
      // layer reads this same file, and a generated value here would 401 every
      // proxied request.
      const dir = workdir();
      const path = join(dir, "auth_token.txt");
      writeFileSync(path, "\n");

      const resolved = resolveSecret(
        { AUTH_TOKEN: "token-from-dot-env", AUTH_TOKEN_FILE: path },
        "AUTH_TOKEN"
      );

      assert.equal(resolved.value, "token-from-dot-env");
      assert.equal(resolved.source, "replaced");
      assert.equal(readFileSync(path, "utf8").trim(), "token-from-dot-env");
    });

    it("writes the replacement at the shared-group mode", posixOnly, () => {
      // The file it replaces may well be a 600 one an operator created by hand.
      const dir = workdir();
      const path = join(dir, "k.txt");
      writeFileSync(path, "", { mode: 0o600 });

      resolveSecret({ K_FILE: path }, "K");

      assert.equal(statSync(path).mode & 0o777, GENERATED_SECRET_MODE);
    });

    it("says the file is empty, not missing, for a secret that is never generated", () => {
      // AUTH_PASSWORD_HASH is not invented by this process. "ENOENT: no such
      // file or directory" would send the operator hunting for a file that is
      // sitting right there.
      const dir = workdir();
      const path = join(dir, "auth_password_hash.txt");
      writeFileSync(path, "\n");

      assert.throws(
        () =>
          resolveSecret({ AUTH_PASSWORD_HASH_FILE: path }, "AUTH_PASSWORD_HASH", {
            generate: false,
          }),
        (err: unknown) =>
          err instanceof SecretError &&
          err.message.includes("is empty") &&
          !err.message.includes("ENOENT")
      );
      // And left alone: this process does not delete a file it cannot refill.
      assert.equal(readFileSync(path, "utf8"), "\n");
    });

    it("reads the replacement back on the next boot rather than rotating again", () => {
      const dir = workdir();
      const path = join(dir, "k.txt");
      writeFileSync(path, "");

      const first = resolveSecret({ K_FILE: path }, "K");
      const second = resolveSecret({ K_FILE: path }, "K");

      assert.equal(second.value, first.value);
      assert.equal(second.source, "file");
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

    it("refuses an empty file rather than adopting it as the winner's value", () => {
      // Nothing in this module ever links an empty file into place, so an empty
      // target here was not written by the other service. Adopting it would gate
      // both services behind a secret nobody can present — the same failure the
      // empty-file rule above exists to stop, arriving by the other door.
      const dir = workdir();
      const path = join(dir, "auth_token.txt");
      writeFileSync(path, "\n");

      assert.throws(
        () => createExclusively(path, "mine", "AUTH_TOKEN"),
        (err: unknown) => err instanceof SecretError && err.message.includes("empty")
      );
      assert.deepEqual(readdirSync(dir), ["auth_token.txt"]);
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

  it("warns, rather than reassures, when the file was found empty", () => {
    // The line an operator who truncated a live secret by accident has to see:
    // the old "secret resolved … source:file" said the opposite of what happened.
    const lines: Array<{ level: LogLevel; message: string; extra?: Record<string, unknown> }> = [];

    logSecretReport(
      [{ name: "AUTH_TOKEN", source: "replaced", path: "/secrets/auth_token.txt" }],
      (level, message, extra) => lines.push({ level, message, extra })
    );

    assert.equal(lines.length, 1);
    assert.equal(lines[0]?.level, "warn");
    assert.equal(lines[0]?.extra?.source, "replaced");
    assert.match(lines[0]?.message ?? "", /empty/);
    assert.match(String(lines[0]?.extra?.note ?? ""), /restart both services/);
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
  // The two images still need one group in common — a mode-640 secret written by
  // one is unreadable to the other without it — but that group is *not* a
  // build-time constant any more, and this suite now pins the absence.
  //
  // It used to be gid 105, pinned in both Dockerfiles and published as a
  // `secrets-gid` label, with the deployment saying `chgrp 105 secrets`. 105 is
  // genuinely free in node:24-alpine; the chgrp runs on the host, where 100-999
  // is the system range and 105 is usually a real system group with a daemon in
  // it. `2770` then gave that group unlink rights over auth_token.txt, and "a
  // present file wins" adopted whatever it put there (#76).
  //
  // The group is the operator's own now, created with `groupadd --system` and
  // applied to both container processes by docker-compose.yml's `group_add`.
  // What has to be pinned is therefore the wiring: the two images must bake no
  // gid of their own, and both services must actually be put in the host's.
  //
  // src/secrets.ts used to chown each secret it created to a `SHARED_SECRET_GID`
  // of its own, which made an image-side numeric `mailsecrets` riding alongside
  // the host-side `group_add` worse than either scheme alone. That constant is
  // gone (#89) — the setgid bit on secrets/shared and secrets/oauth is the only
  // mechanism now — but a baked gid remains wrong for the reason #76 gives: a
  // number chosen against node:24-alpine is a guess about a host it has never
  // seen, and on the host it usually names somebody else's daemon.
  const dockerfiles = {
    "Dockerfile": new URL("../../Dockerfile", import.meta.url),
    "oauth/Dockerfile": new URL("../../oauth/Dockerfile", import.meta.url),
  };

  for (const [name, url] of Object.entries(dockerfiles)) {
    it(`${name} pins no gid for the shared secrets group`, () => {
      const dockerfile = readFileSync(url, "utf8");
      assert.doesNotMatch(
        dockerfile,
        /addgroup\s+(-\S+\s+)*-g\s+\d+\s+mailsecrets/,
        `${name} must not bake a numeric gid for mailsecrets into the image — ` +
          `the group belongs to the host, and docker-compose.yml supplies it ` +
          `with group_add: ["\${SECRETS_GID}"]. See #76.`
      );
    });

    it(`${name} puts its runtime user in no shared secrets group`, () => {
      const dockerfile = readFileSync(url, "utf8");
      assert.doesNotMatch(dockerfile, /addgroup\s+mail(mcp|oauth)\s+mailsecrets/);
    });

    it(`${name} publishes no secrets-gid label`, () => {
      // The label was a promise about a number that no longer exists. Anything
      // reading it would be reading a stale one.
      const dockerfile = readFileSync(url, "utf8");
      assert.doesNotMatch(dockerfile, /secrets-gid=/);
    });
  }

  it("docker-compose.yml puts both services in ${SECRETS_GID}", () => {
    // Both, not one: the group exists precisely so each service can read what
    // the other wrote, so a group_add on a single service is the same EACCES
    // crash loop by another route.
    const compose = readFileSync(new URL("../../docker-compose.yml", import.meta.url), "utf8");
    const entries = compose.match(/^\s*-\s*"\$\{SECRETS_GID[:?}]/gm) ?? [];
    assert.equal(entries.length, 2, "both services need group_add: [\"${SECRETS_GID}\"]");
    assert.equal(
      (compose.match(/^\s*group_add:/gm) ?? []).length,
      2,
      "both services need a group_add block"
    );
  });

  it("docker-compose.yml refuses to start without SECRETS_GID", () => {
    // `${SECRETS_GID}` on its own interpolates to the empty string and the stack
    // comes up with no shared group at all, which fails later and elsewhere. The
    // `:?` form makes `docker compose up` say so instead.
    const compose = readFileSync(new URL("../../docker-compose.yml", import.meta.url), "utf8");
    for (const entry of compose.match(/\$\{SECRETS_GID[^}]*\}/g) ?? []) {
      assert.match(entry, /^\$\{SECRETS_GID:\?/, `${entry} must use the required-variable form`);
    }
  });

  it(".env.docker.example carries SECRETS_GID", () => {
    // It has to be *this* file: Compose interpolates only from the project's
    // .env, never from a service's env_file, so putting it in .env.oauth would
    // leave mail-oauth's group_add empty.
    const example = readFileSync(new URL("../../.env.docker.example", import.meta.url), "utf8");
    assert.match(example, /^SECRETS_GID=/m);
  });
});

describe("each service is mounted only the secrets it names", () => {
  // The shared group is what lets the two services read each other's *shared*
  // secrets. It is not a licence for the connector to see the OAuth layer's, and
  // for one release it was: `./secrets` was one directory mounted read-write into
  // both, so the process that parses attacker-supplied MIME off the public
  // internet could read oauth_signing_key.txt (forge an access token for /mcp)
  // and auth_password_hash.txt (crack it offline, then own /authorize and
  // /settings). Its environment names neither. The mount is now split by
  // audience, and what keeps the connector out of secrets/oauth is the mount
  // rather than the group — so it is the mount that has to be pinned (#77).
  const compose = readFileSync(new URL("../../docker-compose.yml", import.meta.url), "utf8").replace(
    /\r\n/g,
    "\n"
  );

  // Everything from `  mail-mcp:` to `  mail-oauth:`, and everything after it up
  // to the trailing top-level comment block. Crude, and deliberately so: a real
  // YAML parse would need a dependency this package does not have, and the two
  // service keys are the only two-space keys in the file.
  const services = compose.split(/^ {2}mail-oauth:$/m);
  const connector = services[0] ?? "";
  const oauth = (services[1] ?? "").split(/^# ---/m)[0] ?? "";

  it("neither service mounts a flat ./secrets", () => {
    assert.doesNotMatch(
      compose,
      /^\s*-\s*\.\/secrets:/m,
      "./secrets:/secrets hands every service all four secrets — mount ./secrets/shared " +
        "and ./secrets/oauth separately. See #77."
    );
  });

  /** Just the `- ./host:/container` entries, so a mention in a comment or in the
   *  `group_add` error message is not mistaken for a mount. */
  const mounts = (block: string): string[] =>
    (block.match(/^\s*-\s*\.\/\S+:\/\S+$/gm) ?? []).map((line) => line.replace(/^\s*-\s*/, ""));

  it("the connector mounts the shared half and nothing else", () => {
    assert.ok(mounts(connector).includes("./secrets/shared:/secrets/shared"));
    assert.deepEqual(
      mounts(connector).filter((m) => m.startsWith("./secrets/oauth")),
      [],
      "mail-mcp must not mount ./secrets/oauth — the signing key and the password " +
        "hash are no business of the connector's"
    );
  });

  it("the OAuth layer mounts both halves", () => {
    // Both, and both writable: it generates whatever of the three random secrets
    // is missing, and replacing a blank file means unlinking it first.
    assert.ok(mounts(oauth).includes("./secrets/shared:/secrets/shared"));
    assert.ok(mounts(oauth).includes("./secrets/oauth:/secrets/oauth"));
    assert.deepEqual(
      mounts(oauth).filter((m) => m.startsWith("./secrets/") && m.endsWith(":ro")),
      [],
      "mail-oauth's secrets mounts must stay writable"
    );
  });

  it("every secret path a service names is inside a directory it mounts", () => {
    // The check that would have caught the original defect from the other end:
    // the connector's two _FILE paths were already only the shared pair, and the
    // mount handed it more than they named.
    for (const [name, block, allowed] of [
      ["mail-mcp", connector, ["/secrets/shared/"]],
      ["mail-oauth", oauth, ["/secrets/shared/", "/secrets/oauth/"]],
    ] as const) {
      const paths = block.match(/^\s*\w+_FILE:\s*(\/secrets\/\S+)$/gm) ?? [];
      assert.ok(paths.length > 0, `${name} names no *_FILE secret paths at all`);
      for (const line of paths) {
        const path = line.split(":")[1]?.trim() ?? "";
        assert.ok(
          allowed.some((prefix) => path.startsWith(prefix)),
          `${name} names ${path}, which is not under a directory it mounts`
        );
      }
    }
  });
});
