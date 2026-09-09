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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
  renderSetupPlaceholder,
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

  it("deletes a claim token left on an instance that is already claimed", () => {
    const dir = tempDir();
    writeOperatorRecord(join(dir, "operator.json"));
    const tokenFile = join(dir, "claim-token.txt");
    writeFileSync(tokenFile, "a-stale-bearer-credential\n");
    const { lines, log } = capturingLogger();

    Bootstrap.open(configFor(dir), log);

    assert.ok(
      lines.some((line) => line.message.includes("discarded the claim token")),
      "says so rather than deleting silently"
    );
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

describe("complete() — the seam issue #22 calls", () => {
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

describe("the setup placeholder", () => {
  it("says the instance is unclaimed and that the wizard is not built yet", () => {
    const html = renderSetupPlaceholder();
    assert.match(html, /not been claimed yet/);
    assert.match(html, /not implemented yet/);
    assert.match(html, /noindex, nofollow/);
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
