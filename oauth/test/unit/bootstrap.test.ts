/**
 * The claim token's lifecycle, and the state check the route gate reads.
 *
 * The route table itself is pinned in test/integration/bootstrap-gate.test.ts,
 * against the real middleware chain. What is here is everything that happens
 * before a request arrives: what counts as unbootstrapped, where the token comes
 * from, that a restart does not move it, and that completing setup closes the
 * door for good.
 */

import { strict as assert } from "node:assert";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  Bootstrap,
  BootstrapError,
  CLAIM_TOKEN_BYTES,
  generateClaimToken,
  operatorSeed,
  parseSetupPath,
  setupBanner,
  setupUrlFor,
} from "../../src/bootstrap.js";
import type { OAuthConfig } from "../../src/config.js";
import type { LogLevel, Logger } from "../../src/logger.js";
import { silentLogger } from "../../src/logger.js";
import { HOSTED_CLAUDE_REDIRECT_URIS } from "../../src/urls.js";

const VALID_HASH =
  "scrypt$1024$8$1$c2FsdHNhbHRzYWx0c2E$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhcw";

const ISSUER = "https://mail.example.com";

/** Node reports a crude, non-POSIX mode on Windows; the mode only matters in the image. */
const posixOnly = process.platform === "win32" ? { skip: "POSIX file modes only" } : {};

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "oauth-bootstrap-"));
}

/** A config in the shape loadConfig produces, with the fields this module reads. */
function configFor(dir: string, overrides: Partial<OAuthConfig> = {}): OAuthConfig {
  return {
    port: 8080,
    host: "0.0.0.0",
    issuer: ISSUER,
    mcpPath: "/mcp",
    resource: `${ISSUER}/mcp`,
    upstreamMcpUrl: "http://mail-mcp:3220",
    upstreamAuthToken: "connector-token",
    signingKey: new TextEncoder().encode("a".repeat(48)),
    authUsername: "operator",
    authPasswordHash: null,
    stateFile: join(dir, "oauth-state.json"),
    settingsSigningKey: null,
    operatorFile: join(dir, "operator.json"),
    claimTokenFile: join(dir, "claim-token.txt"),
    wizardStateFile: join(dir, "setup-wizard.json"),
    trustProxy: 1,
    accessTokenTtl: 3600,
    refreshTokenTtl: 2592000,
    redirectAllowlist: [...HOSTED_CLAUDE_REDIRECT_URIS],
    logLevel: "info",
    secretReport: [],
    ...overrides,
  };
}

interface LoggedLine {
  level: LogLevel;
  message: string;
  extra: Record<string, unknown>;
}

function capturingLogger(): { lines: LoggedLine[]; log: Logger } {
  const lines: LoggedLine[] = [];
  return {
    lines,
    log: (level, message, extra) => {
      lines.push({ level, message, extra: extra ?? {} });
    },
  };
}

/** Write an operator record the way the wizard will, so complete() has one to find. */
function writeOperatorRecord(path: string): void {
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      username: "operator",
      passwordHash: VALID_HASH,
      sessionEpoch: 0,
    })
  );
}

describe("what counts as unbootstrapped", () => {
  it("is unbootstrapped with no operator record and no password hash", () => {
    const bootstrap = Bootstrap.open(configFor(tempDir()), silentLogger);
    assert.equal(bootstrap.bootstrapped, false);
    assert.ok(bootstrap.setupUrl);
  });

  it("is bootstrapped once the operator record exists", () => {
    const dir = tempDir();
    writeOperatorRecord(join(dir, "operator.json"));

    const bootstrap = Bootstrap.open(configFor(dir), silentLogger);

    assert.equal(bootstrap.bootstrapped, true);
    assert.equal(bootstrap.setupUrl, null);
    assert.equal(existsSync(join(dir, "claim-token.txt")), false, "no token was minted");
  });

  it("is bootstrapped when a password hash is configured, record or not", () => {
    // The manual install path, still the documented one: an operator who hashed a
    // password by hand before the first boot has configured this instance, and
    // gating it would lock them out of a server they set up correctly.
    const dir = tempDir();
    const bootstrap = Bootstrap.open(
      configFor(dir, { authPasswordHash: VALID_HASH }),
      silentLogger
    );

    assert.equal(bootstrap.bootstrapped, true);
    assert.equal(existsSync(join(dir, "claim-token.txt")), false);
  });

  it("is bootstrapped when OPERATOR_FILE is none", () => {
    // The credential comes from the secret and cannot be changed from the
    // browser. There is nothing to bootstrap.
    const bootstrap = Bootstrap.open(
      configFor(tempDir(), { operatorFile: null, authPasswordHash: VALID_HASH }),
      silentLogger
    );
    assert.equal(bootstrap.bootstrapped, true);
  });

  it("refuses to boot unclaimable: no credential and nowhere to write a token", () => {
    assert.throws(
      () => Bootstrap.open(configFor(tempDir(), { claimTokenFile: null }), silentLogger),
      (err: unknown) => err instanceof BootstrapError && err.message.includes("CLAIM_TOKEN_FILE")
    );
  });

  it("stays unbootstrapped while the claim token is still on the volume", () => {
    // The trap this rule exists for. Wizard step 1 writes the operator record
    // with two screens still to go; reading the record alone would mean a
    // container that restarted at that moment came back deciding it was claimed,
    // 404ing every /setup path and deleting the token as litter — locking the
    // operator out of steps 2 and 3 with no way back in.
    const dir = tempDir();
    const first = Bootstrap.open(configFor(dir), silentLogger);
    writeOperatorRecord(join(dir, "operator.json"));

    const second = Bootstrap.open(configFor(dir), silentLogger);

    assert.equal(second.bootstrapped, false);
    assert.equal(second.setupUrl, first.setupUrl, "the same token, still live");
    assert.equal(existsSync(join(dir, "claim-token.txt")), true);
  });

  it("deletes a claim token left on an instance that was never claimable", () => {
    // Only the two configurations that are bootstrapped without ever having been
    // claimed reach this: a configured hash, and OPERATOR_FILE=none. A token
    // there can open nothing, but it is still a bearer credential in a file.
    const dir = tempDir();
    const tokenFile = join(dir, "claim-token.txt");
    writeFileSync(tokenFile, "a-stale-bearer-credential\n");
    const { lines, log } = capturingLogger();

    Bootstrap.open(configFor(dir, { authPasswordHash: VALID_HASH }), log);

    // The deletion itself is best-effort and asynchronous; the promise it says
    // so on is the log line.
    assert.ok(
      lines.some((line) => line.message.includes("discarded the claim token")),
      "says so rather than deleting silently"
    );
  });
});

describe("a data volume that has been used before is not a first boot", () => {
  /**
   * The state file, written the way the store writes it. Nothing creates this
   * file at boot — `Store.open` reads it and, finding it absent, starts empty
   * without writing anything — so its presence means a client registered or a
   * refresh session was issued against this volume. That only happens on an
   * instance somebody claimed: `/register` is a 404 while the gate is closed.
   */
  function seedPriorUse(dir: string): string {
    const path = join(dir, "oauth-state.json");
    writeFileSync(
      path,
      JSON.stringify({ version: 1, clients: {}, sessions: {}, tokenEpoch: 0 })
    );
    return path;
  }

  it("refuses to start when the hash vanished from a volume that has served traffic", () => {
    // The corner #58 is about. An instance that authenticated from
    // AUTH_PASSWORD_HASH alone and never wrote an operator record: a secrets
    // mount that breaks with ENOENT — a renamed host directory, a volume that
    // did not attach — used to leave it booting as an unclaimed instance and
    // printing a setup URL to whoever can read the logs.
    const dir = tempDir();
    const stateFile = seedPriorUse(dir);
    const hashFile = join(dir, "auth_password_hash.txt");

    assert.throws(
      () => Bootstrap.open(configFor(dir, { authPasswordHashFile: hashFile }), silentLogger),
      (err: unknown) =>
        err instanceof BootstrapError &&
        err.message.includes(hashFile) &&
        err.message.includes(join(dir, "operator.json")) &&
        err.message.includes(stateFile)
    );
    assert.equal(existsSync(join(dir, "claim-token.txt")), false, "nothing was minted");
  });

  it("names the secret even when it was never given as a file path", () => {
    const dir = tempDir();
    seedPriorUse(dir);

    assert.throws(
      () => Bootstrap.open(configFor(dir), silentLogger),
      (err: unknown) =>
        err instanceof BootstrapError && err.message.includes("AUTH_PASSWORD_HASH")
    );
  });

  it("counts a state file the store quarantined moments earlier", () => {
    // index.ts opens the store before it opens this, and a state file the store
    // cannot parse is renamed to <path>.corrupt-<ts> on the way. Without this,
    // one unparseable byte would erase the evidence between the two calls and
    // hand a configured instance back to the claim token.
    const dir = tempDir();
    writeFileSync(join(dir, "oauth-state.json.corrupt-1757000000000"), "{ not json");

    assert.throws(() => Bootstrap.open(configFor(dir), silentLogger), BootstrapError);
  });

  it("still mints a claim token on a genuinely empty data volume", () => {
    const dir = tempDir();

    const bootstrap = Bootstrap.open(configFor(dir), silentLogger);

    assert.equal(bootstrap.bootstrapped, false);
    assert.ok(bootstrap.setupUrl, "the setup URL an operator is meant to receive");
  });

  it("still boots mid-wizard, before step 1 has written the operator record", () => {
    // A live claim token and the wizard's own progress note are the litter of an
    // unfinished setup, not of an instance that has run. Counting either would
    // turn a half-finished wizard into a refusal to boot, which is the one thing
    // the claim token was built to survive.
    const dir = tempDir();
    const first = Bootstrap.open(configFor(dir), silentLogger);
    writeFileSync(
      join(dir, "setup-wizard.json"),
      JSON.stringify({ version: 1, furthest: "credentials" })
    );

    const second = Bootstrap.open(configFor(dir), silentLogger);

    assert.equal(second.bootstrapped, false);
    assert.equal(second.setupUrl, first.setupUrl, "the same token, still live");
  });

  it("refuses even with a claim token present, once the volume shows real traffic", () => {
    // The instance a boot under the old rule has already downgraded: it minted a
    // token and printed a setup URL. The token must not now excuse the fault it
    // is a symptom of, or the fix would skip the only instances that need it.
    const dir = tempDir();
    writeFileSync(join(dir, "claim-token.txt"), "minted-by-an-earlier-boot\n");
    seedPriorUse(dir);

    assert.throws(() => Bootstrap.open(configFor(dir), silentLogger), BootstrapError);
  });

  it("leaves OPERATOR_FILE=none, a configured hash and a claimed volume alone", () => {
    const dir = tempDir();
    seedPriorUse(dir);

    for (const overrides of [
      { operatorFile: null, authPasswordHash: VALID_HASH },
      { authPasswordHash: VALID_HASH },
    ]) {
      assert.equal(Bootstrap.open(configFor(dir, overrides), silentLogger).bootstrapped, true);
    }

    writeOperatorRecord(join(dir, "operator.json"));
    assert.equal(Bootstrap.open(configFor(dir), silentLogger).bootstrapped, true);
  });

  it("has nothing to go on when STATE_FILE is none, and mints as before", () => {
    // An in-memory deployment leaves no trace of prior use to find. Documented
    // rather than worked around: the check is only ever as good as the volume.
    const dir = tempDir();
    seedPriorUse(dir);

    const bootstrap = Bootstrap.open(configFor(dir, { stateFile: null }), silentLogger);

    assert.equal(bootstrap.bootstrapped, false);
  });
});

describe("the claim token", () => {
  it("is 32 random bytes, base64url", () => {
    const token = generateClaimToken();
    assert.equal(CLAIM_TOKEN_BYTES, 32);
    assert.match(token, /^[A-Za-z0-9_-]+$/, "base64url: safe in a URL unencoded");
    assert.equal(Buffer.from(token, "base64url").length, 32);
    assert.notEqual(token, generateClaimToken());
  });

  it("is written to the data volume and reported like every other secret", () => {
    const dir = tempDir();
    const { lines, log } = capturingLogger();

    const bootstrap = Bootstrap.open(configFor(dir), log);

    const onDisk = readFileSync(join(dir, "claim-token.txt"), "utf8").trim();
    assert.equal(bootstrap.setupUrl, setupUrlFor(ISSUER, onDisk));
    const report = lines.find((line) => line.message === "secret resolved");
    assert.deepEqual(report?.extra, {
      secret: "CLAIM_TOKEN",
      source: "generated",
      path: join(dir, "claim-token.txt"),
    });
    assert.ok(
      !lines.some((line) => JSON.stringify(line).includes(onDisk)),
      "the token itself is never a log field"
    );
  });

  it("is written 0600, not at the shared secrets' mode", posixOnly, () => {
    // Whoever holds this token can claim the instance and set the operator
    // password, and only this service ever reads it — so it goes on the volume
    // at the same mode as operator.json and setup-wizard.json beside it, rather
    // than at the 640 the two images need for the secrets they share.
    const dir = tempDir();

    Bootstrap.open(configFor(dir), silentLogger);

    assert.equal(statSync(join(dir, "claim-token.txt")).mode & 0o777, 0o600);
  });

  it("survives a restart mid-wizard, rather than being regenerated", () => {
    // The tab the operator has open on step 2 must still work after the container
    // comes back. This is the reason the token is persisted at all.
    const dir = tempDir();
    const first = Bootstrap.open(configFor(dir), silentLogger);
    const { lines, log } = capturingLogger();

    const second = Bootstrap.open(configFor(dir), log);

    assert.equal(second.setupUrl, first.setupUrl);
    assert.equal(
      lines.find((line) => line.message === "secret resolved")?.extra.source,
      "file",
      "read back, not created"
    );
  });

  it("prints the same setup URL on every boot while still unbootstrapped", () => {
    const dir = tempDir();
    const printed: string[] = [];
    Bootstrap.open(configFor(dir), silentLogger).announce((chunk) => printed.push(chunk));
    Bootstrap.open(configFor(dir), silentLogger).announce((chunk) => printed.push(chunk));

    const url = Bootstrap.open(configFor(dir), silentLogger).setupUrl ?? "";
    assert.equal(printed.length, 2);
    for (const banner of printed) assert.ok(banner.includes(url), banner);
  });

  it("prints nothing once the instance is claimed", () => {
    const dir = tempDir();
    writeOperatorRecord(join(dir, "operator.json"));
    const printed: string[] = [];

    Bootstrap.open(configFor(dir), silentLogger).announce((chunk) => printed.push(chunk));

    assert.deepEqual(printed, []);
  });

  it("builds a complete, clickable URL from PUBLIC_URL", () => {
    // The operator copies a link; they do not assemble one out of an env var and
    // a file they would have to read inside the container.
    assert.equal(setupUrlFor("https://mail.example.com", "tok"), "https://mail.example.com/setup/tok");
  });

  it("says in the banner that the link is a bearer credential", () => {
    const banner = setupBanner(setupUrlFor(ISSUER, "tok"));
    assert.ok(banner.includes(`${ISSUER}/setup/tok`));
    assert.match(banner, /Anyone with this link can claim this instance/);
  });

  it("treats an empty token file as no token at all", () => {
    // A truncated write would otherwise gate the instance behind a credential
    // nobody can present.
    const dir = tempDir();
    writeFileSync(join(dir, "claim-token.txt"), "   \n");

    const bootstrap = Bootstrap.open(configFor(dir), silentLogger);

    assert.ok(bootstrap.setupUrl);
    assert.notEqual(readFileSync(join(dir, "claim-token.txt"), "utf8").trim(), "");
  });

  it("fails loudly on a token file it cannot read, rather than minting a second one", () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    const dir = tempDir();
    const tokenFile = join(dir, "claim-token.txt");
    writeFileSync(tokenFile, "the-live-token\n");
    chmodSync(tokenFile, 0o000);

    assert.throws(() => Bootstrap.open(configFor(dir), silentLogger), BootstrapError);
  });
});

describe("accepts()", () => {
  it("accepts the live token and nothing else", () => {
    const dir = tempDir();
    const bootstrap = Bootstrap.open(configFor(dir), silentLogger);
    const token = readFileSync(join(dir, "claim-token.txt"), "utf8").trim();

    assert.equal(bootstrap.accepts(token), true);
    assert.equal(bootstrap.accepts(""), false);
    assert.equal(bootstrap.accepts(`${token}x`), false);
    assert.equal(bootstrap.accepts(token.slice(0, -1)), false);
    assert.equal(bootstrap.accepts(generateClaimToken()), false);
  });

  it("accepts nothing at all on a claimed instance", () => {
    const dir = tempDir();
    writeOperatorRecord(join(dir, "operator.json"));
    const bootstrap = Bootstrap.open(configFor(dir), silentLogger);

    assert.equal(bootstrap.accepts(""), false);
    assert.equal(bootstrap.accepts(generateClaimToken()), false);
  });
});

describe("complete() — what the wizard's Finish button does", () => {
  it("deletes the token and flips the state check", async () => {
    const dir = tempDir();
    const bootstrap = Bootstrap.open(configFor(dir), silentLogger);
    const token = readFileSync(join(dir, "claim-token.txt"), "utf8").trim();
    // The wizard writes the record first; complete() is the second half of that
    // pair, never the first.
    writeOperatorRecord(join(dir, "operator.json"));

    await bootstrap.complete();

    assert.equal(bootstrap.bootstrapped, true);
    assert.equal(bootstrap.setupUrl, null);
    assert.equal(bootstrap.accepts(token), false);
    assert.equal(existsSync(join(dir, "claim-token.txt")), false);
  });

  it("stays closed across a restart", async () => {
    const dir = tempDir();
    const bootstrap = Bootstrap.open(configFor(dir), silentLogger);
    writeOperatorRecord(join(dir, "operator.json"));
    await bootstrap.complete();

    const next = Bootstrap.open(configFor(dir), silentLogger);

    assert.equal(next.bootstrapped, true);
    assert.equal(next.setupUrl, null);
    assert.equal(existsSync(join(dir, "claim-token.txt")), false, "no token is minted again");
  });

  it("refuses to run before the operator record exists", async () => {
    // Ordering, checked rather than merely documented: deleting the token first
    // and crashing before the record was written would leave an instance nobody —
    // operator included — could ever claim.
    const dir = tempDir();
    const bootstrap = Bootstrap.open(configFor(dir), silentLogger);

    await assert.rejects(() => bootstrap.complete(), BootstrapError);
    assert.equal(bootstrap.bootstrapped, false);
    assert.equal(existsSync(join(dir, "claim-token.txt")), true, "the token is still live");
  });

  it("leaves the instance exactly as it was when the token cannot be deleted", async () => {
    // The partial failure the wizard has to have an answer for: the operator
    // record is written and the token will not go. The state must not flip on a
    // half-done claim — a process that reported itself claimed with the token
    // still on the volume would hand the next boot back to the claim token.
    const dir = tempDir();
    const bootstrap = Bootstrap.open(configFor(dir), silentLogger);
    const token = readFileSync(join(dir, "claim-token.txt"), "utf8").trim();
    writeOperatorRecord(join(dir, "operator.json"));

    // A directory where the file was: unlink refuses it with something that is
    // not ENOENT, which is what a read-only volume looks like from here.
    rmSync(join(dir, "claim-token.txt"));
    mkdirSync(join(dir, "claim-token.txt"));

    await assert.rejects(
      () => bootstrap.complete(),
      (err: unknown) => {
        assert.ok(err instanceof BootstrapError);
        // The message is shown to the operator by step 3, so it has to name the
        // file they are being asked to deal with.
        assert.match(err.message, /claim-token\.txt/);
        return true;
      }
    );

    assert.equal(bootstrap.bootstrapped, false, "still unclaimed");
    assert.equal(bootstrap.accepts(token), true, "and the setup link still works");
    assert.notEqual(bootstrap.setupUrl, null);
  });

  it("is idempotent, so a retried request cannot fail on the second attempt", async () => {
    const dir = tempDir();
    const bootstrap = Bootstrap.open(configFor(dir), silentLogger);
    writeOperatorRecord(join(dir, "operator.json"));

    await bootstrap.complete();
    await bootstrap.complete();

    assert.equal(bootstrap.bootstrapped, true);
  });
});

describe("parseSetupPath", () => {
  it("splits the token from the wizard's own sub-path", () => {
    assert.deepEqual(parseSetupPath("/setup/abc"), { token: "abc", rest: "" });
    assert.deepEqual(parseSetupPath("/setup/abc/"), { token: "abc", rest: "" });
    assert.deepEqual(parseSetupPath("/setup/abc/mailbox"), { token: "abc", rest: "/mailbox" });
  });

  it("is null for anything that is not a token-bearing setup path", () => {
    assert.equal(parseSetupPath("/setup"), null);
    assert.equal(parseSetupPath("/setup/"), null);
    assert.equal(parseSetupPath("/health"), null);
    assert.equal(parseSetupPath("/setupsomething/abc"), null);
    assert.equal(parseSetupPath("/"), null);
  });
});

describe("operatorSeed", () => {
  it("prefers the configured hash, as operator.ts documents", () => {
    const dir = tempDir();
    const seed = operatorSeed(configFor(dir, { authPasswordHash: VALID_HASH }));
    assert.deepEqual(seed, { username: "operator", passwordHash: VALID_HASH });
  });

  it("hands the record its own hash back when no secret is configured", () => {
    // Otherwise OperatorRecord.open would warn "AUTH_PASSWORD_HASH differs" on
    // every boot of a healthy post-wizard instance, and teach its operator to
    // ignore the one line that means something.
    const dir = tempDir();
    writeOperatorRecord(join(dir, "operator.json"));
    assert.equal(operatorSeed(configFor(dir)).passwordHash, VALID_HASH);
  });

  it("yields a hash that verifies against nothing when the record is unreadable", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "operator.json"), "{ not json");
    assert.equal(operatorSeed(configFor(dir)).passwordHash, "");
  });
});

describe("a data directory that does not exist yet", () => {
  it("reports the failure against the path, rather than booting unclaimable", () => {
    const dir = join(tempDir(), "never-created");
    assert.throws(() => Bootstrap.open(configFor(dir), silentLogger), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /CLAIM_TOKEN/);
      return true;
    });
  });

  it("works once the directory is there", () => {
    const dir = join(tempDir(), "created-later");
    mkdirSync(dir);
    assert.ok(Bootstrap.open(configFor(dir), silentLogger).setupUrl);
  });
});

describe("a data volume the claim token cannot be written to", () => {
  // #105. The single failure the setup flow cannot survive: an unclaimed
  // instance has to write the claim token before it has anything to print, so a
  // data directory it cannot write means no setup URL at all — and under
  // `restart: unless-stopped` the operator watches that scroll past while
  // waiting for a link that is never coming. Docker made exactly this state on
  // every clean clone, by creating the missing bind-mount source as root:root.
  //
  // What fixed the clean clone is the named volume in docker-compose.yml. What
  // is pinned here is the other half: for anyone who bind-mounts the path
  // anyway, the boot fails with one readable block naming the fix.

  // Dropping write permission needs POSIX modes, and root ignores them.
  const asUnprivilegedPosixUser =
    process.platform === "win32"
      ? { skip: "POSIX directory modes only" }
      : (process.getuid?.() ?? 0) === 0
        ? { skip: "root writes into a directory whatever its mode says" }
        : {};

  it("refuses to start, naming the mkdir and the chown", asUnprivilegedPosixUser, () => {
    const dir = tempDir();
    chmodSync(dir, 0o500);
    let thrown: unknown;
    try {
      Bootstrap.open(configFor(dir), silentLogger);
    } catch (err) {
      thrown = err;
    } finally {
      chmodSync(dir, 0o700);
    }

    // A BootstrapError, not the SecretError the writer used to throw four frames
    // down: index.ts prints one of those as a plain line and exits, and lets the
    // other reach node, which dumps a stack trace over the message.
    assert.ok(
      thrown instanceof BootstrapError,
      `expected a BootstrapError, got ${String(thrown)}`
    );
    assert.match((thrown as BootstrapError).message, /has not been claimed yet/);
    assert.match(
      (thrown as BootstrapError).message,
      /mkdir -p \.\/oauth-data && sudo chown \d+:\d+ \.\/oauth-data/,
      "the message has to end in a command the operator can paste"
    );
    // The advice createExclusively gives is about secrets/ — a shared group, mode
    // 2770, the setgid bit — and none of it is true of the data volume. It was
    // reaching operators whose actual problem was this one.
    assert.doesNotMatch((thrown as BootstrapError).message, /SECRETS_GID|2770|setgid/);
  });

  it("says nothing about it when the token is already there", asUnprivilegedPosixUser, () => {
    // A restart mid-wizard, on a volume that has since been made read-only: the
    // token is read back, the operator keeps the tab they still have open, and
    // nothing has to be written for that to work.
    const dir = tempDir();
    writeFileSync(join(dir, "claim-token.txt"), "a-token-from-the-first-boot\n");
    chmodSync(dir, 0o500);
    let bootstrap: Bootstrap | undefined;
    try {
      bootstrap = Bootstrap.open(configFor(dir), silentLogger);
    } finally {
      chmodSync(dir, 0o700);
    }

    assert.equal(bootstrap?.bootstrapped, false);
    assert.equal(bootstrap?.setupUrl, `${ISSUER}/setup/a-token-from-the-first-boot`);
  });
});
