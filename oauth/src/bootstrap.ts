/**
 * The unbootstrapped state, and the claim token that is the only way out of it.
 *
 * An instance that configures itself from the browser is, for the window between
 * `docker compose up` and the first login, an unauthenticated form on the public
 * internet that hands out control of a mail connector. This module is what makes
 * that window safe. The mechanism is the one Jupyter uses: the instance is
 * claimable only by someone who can read its logs.
 *
 * **Unbootstrapped** means nobody has claimed this instance yet: the claim token
 * is still on the data volume, or there is no operator credential at all. Not
 * "the secrets are missing": since #17 the three random secrets generate
 * themselves, so their absence says nothing about whether anyone has claimed
 * this instance. Not "no operator record" on its own either, in either
 * direction — an instance whose operator supplied a password hash by hand is
 * configured whether or not `operator.json` exists, and an instance whose wizard
 * wrote that record in step 1 is *not* configured until the wizard finishes. See
 * `isBootstrapped` at the foot of this file for why the token is the half of the
 * pair that decides.
 *
 * In that state the surface is `/health` and `/setup/<token>`, `/mcp` answers
 * 503, the settings UI is not mounted, and everything else — including
 * `/setup/<anything-else>` — is a 404. See {@link Bootstrap} and the gate in
 * app.ts for the route table.
 *
 * The transition is one-way. Completing setup deletes the token and there is no
 * route back into the wizard; an operator who wants to start over deletes the
 * data volume.
 *
 * ## What this defends, and what it does not
 *
 * It reduces takeover to *an attacker who can read your container logs*, who has
 * already won by other means. It does **not** defend against an operator who
 * pastes the setup URL somewhere public before using it: the token is a bearer
 * credential, and {@link setupBanner} says so rather than pretending otherwise.
 */

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { unlink } from "node:fs/promises";

import type { OAuthConfig } from "./config.js";
import type { Logger } from "./logger.js";
import { constantTimeEquals } from "./passwords.js";
import { createExclusively, logSecretReport, type SecretSource } from "./secrets.js";

/**
 * 32 random bytes, base64url.
 *
 * Shorter than the 48 of the three shared secrets in secrets.ts, deliberately:
 * this one is pasted into a URL bar by a human, and 32 bytes is already far
 * beyond guessing for a credential whose lifetime is measured in minutes.
 */
export const CLAIM_TOKEN_BYTES = 32;

/** The path prefix every setup route lives under. */
export const SETUP_PREFIX = "/setup";

/** Thrown when bootstrap cannot be completed. Surfaces as a 500, never to a client. */
export class BootstrapError extends Error {}

/** A `/setup/*` request, split into the token and whatever the wizard routes on. */
export interface SetupRequest {
  /** The first path segment after `/setup/`. Never empty. */
  token: string;
  /** The remainder, with a leading slash, or "" for `/setup/<token>` itself. */
  rest: string;
}

/**
 * Split a request path into a claim token and the wizard's own sub-path.
 *
 * `/setup/<token>` → `{ token, rest: "" }`, `/setup/<token>/mailbox` →
 * `{ token, rest: "/mailbox" }`. Anything that is not under `/setup/` at all, and
 * a bare `/setup` with no token, return null.
 *
 * Note that the token is *not* validated here — telling a valid token from an
 * invalid one is {@link Bootstrap.accepts}'s job, and it is the only place that
 * comparison happens, in constant time.
 */
export function parseSetupPath(path: string): SetupRequest | null {
  if (path !== SETUP_PREFIX && !path.startsWith(`${SETUP_PREFIX}/`)) return null;
  const remainder = path.slice(SETUP_PREFIX.length + 1);
  const slash = remainder.indexOf("/");
  const token = slash === -1 ? remainder : remainder.slice(0, slash);
  if (token === "") return null;
  const rest = slash === -1 ? "" : remainder.slice(slash);
  // A single trailing slash is the same screen, not a sub-path of it.
  return { token, rest: rest === "/" ? "" : rest };
}

/** 32 random bytes, base64url. Exported for this package's own tests. */
export function generateClaimToken(): string {
  return randomBytes(CLAIM_TOKEN_BYTES).toString("base64url");
}

/**
 * The complete, clickable setup URL — the whole reason the token is printed
 * rather than merely stored. An operator copies a link; they do not assemble one
 * out of `PUBLIC_URL` and a file they have to `cat` inside a container.
 */
export function setupUrlFor(issuer: string, token: string): string {
  return `${issuer}${SETUP_PREFIX}/${token}`;
}

/**
 * The banner an unclaimed instance prints on every boot.
 *
 * Written to stdout directly rather than through the {@link Logger}, and that is
 * not an oversight: `LOG_LEVEL=warn` would suppress an `info` line and leave the
 * operator with no way at all to claim their own instance, and `createLogger`
 * sends `warn` to stderr, which is not where the issue says this belongs. A
 * credential the operator cannot find is the same as no credential.
 *
 * The last line is load-bearing. The token is a bearer credential and anyone who
 * gets the link owns the instance until setup completes; saying so is cheaper
 * than the support thread that follows an operator pasting it into a chat.
 */
export function setupBanner(url: string): string {
  const rule = "─".repeat(64);
  return (
    `${rule}\n` +
    `  Setup required. Open this once to configure the instance:\n` +
    `\n` +
    `    ${url}\n` +
    `\n` +
    `  Anyone with this link can claim this instance. It stops\n` +
    `  working as soon as setup completes.\n` +
    `${rule}\n`
  );
}

/** Where a claim token came from, in the vocabulary secrets.ts already uses. */
type ClaimTokenSource = Extract<SecretSource, "file" | "generated">;

/**
 * The live bootstrap state of this process.
 *
 * Built once at startup by {@link Bootstrap.open} and handed to `createApp`,
 * which consults it on every request. It is mutable in exactly one direction:
 * {@link Bootstrap.complete} flips it to bootstrapped and nothing flips it back.
 */
export class Bootstrap {
  #bootstrapped: boolean;
  readonly #issuer: string;
  readonly #operatorFile: string | null;
  readonly #claimTokenFile: string | null;
  #token: string | null;

  private constructor(options: {
    bootstrapped: boolean;
    issuer: string;
    operatorFile: string | null;
    claimTokenFile: string | null;
    token: string | null;
  }) {
    this.#bootstrapped = options.bootstrapped;
    this.#issuer = options.issuer;
    this.#operatorFile = options.operatorFile;
    this.#claimTokenFile = options.claimTokenFile;
    this.#token = options.token;
  }

  /**
   * Decide the state and, when unclaimed, resolve the claim token.
   *
   * Synchronous, like secrets.ts and for the same reason: this runs once, before
   * the socket is bound, and everything downstream — whether to open the operator
   * record at all — depends on the answer.
   *
   * The token follows the same rule as every other generated secret: **a present
   * file wins, an absent one is created.** That is what makes a restart
   * mid-wizard harmless. A container that comes back up while the operator is on
   * step 2 must not invalidate the tab they still have open, so the token is read
   * back from the data volume rather than regenerated.
   *
   * A claim token found on an instance that is *already* claimed is deleted. It
   * can no longer open anything — the gate is off — but it is still a bearer
   * credential sitting in a file, and leaving it there would mean an operator who
   * later inspects the volume cannot tell whether it is live. Since the state
   * rule made a live token mean "setup is unfinished", the only instances that
   * reach this branch are the ones that were never claimable: `OPERATOR_FILE=none`
   * and a configured `AUTH_PASSWORD_HASH`.
   */
  static open(config: OAuthConfig, log: Logger): Bootstrap {
    const bootstrapped = isBootstrapped(config);
    const claimTokenFile = config.claimTokenFile;

    if (bootstrapped) {
      if (claimTokenFile !== null && existsSync(claimTokenFile)) {
        // Best-effort: a token that cannot be removed is inert either way, and
        // failing startup over it would be worse than the file lying there.
        void unlink(claimTokenFile).catch(() => {});
        log("info", "discarded the claim token of an already configured instance", {
          path: claimTokenFile,
        });
      }
      return new Bootstrap({
        bootstrapped: true,
        issuer: config.issuer,
        operatorFile: config.operatorFile,
        claimTokenFile,
        token: null,
      });
    }

    if (claimTokenFile === null) {
      // No data volume to persist a token on, and no operator either. There is
      // nothing this process could hand the operator, so refuse rather than boot
      // an instance nobody can ever claim.
      throw new BootstrapError(
        "This instance has no operator credential and no CLAIM_TOKEN_FILE to write " +
          "a setup token to. Set AUTH_PASSWORD_HASH, or give the service a writable " +
          "data volume so it can generate a claim token."
      );
    }

    const { value, source } = resolveClaimToken(claimTokenFile);
    // The same line every other secret gets, from the same helper: an operator
    // debugging a setup link that stopped working needs to know whether this
    // boot read the token or created it.
    logSecretReport([{ name: "CLAIM_TOKEN", source, path: claimTokenFile }], log);

    return new Bootstrap({
      bootstrapped: false,
      issuer: config.issuer,
      operatorFile: config.operatorFile,
      claimTokenFile,
      token: value,
    });
  }

  /** True once an operator credential exists. Never returns to false. */
  get bootstrapped(): boolean {
    return this.#bootstrapped;
  }

  /** The complete setup URL to print, or null once the instance is claimed. */
  get setupUrl(): string | null {
    return this.#token === null ? null : setupUrlFor(this.#issuer, this.#token);
  }

  /**
   * Whether a token from a URL is *the* claim token.
   *
   * Constant time, via the same comparison the login form uses for the username:
   * a byte-at-a-time compare would let an attacker who can measure the difference
   * recover the token one character at a time, which is the one attack a random
   * 32-byte credential is otherwise immune to.
   *
   * Always false once bootstrapped, so `/setup/*` closes permanently and does not
   * merely stop being useful.
   */
  accepts(candidate: string): boolean {
    if (this.#bootstrapped || this.#token === null) return false;
    return constantTimeEquals(candidate, this.#token);
  }

  /**
   * Finish the claim. **This is the seam issue #22 calls** when the wizard's last
   * step has written the operator record.
   *
   * Ordering is the whole point and it is checked rather than documented: the
   * operator record must already exist. Deleting the token first and crashing
   * before the record was written would leave an instance nobody — operator
   * included — could ever claim, recoverable only by deleting the data volume. A
   * crash the other way round leaves a claimable instance for one more boot,
   * which is merely the state it was already in.
   *
   * Idempotent: calling it on an already-claimed instance does nothing, so a
   * retried request cannot fail on the second attempt.
   */
  async complete(): Promise<void> {
    if (this.#bootstrapped) return;

    if (this.#operatorFile !== null && !existsSync(this.#operatorFile)) {
      throw new BootstrapError(
        "Cannot complete setup before the operator record exists. Write it first, " +
          "then delete the claim token — never the other way round."
      );
    }

    if (this.#claimTokenFile !== null) {
      try {
        await unlink(this.#claimTokenFile);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          throw new BootstrapError(
            `Cannot delete the claim token at ${this.#claimTokenFile}: ` +
              `${err instanceof Error ? err.message : String(err)}. Setup is not complete ` +
              `while the token is still readable.`
          );
        }
      }
    }

    this.#token = null;
    this.#bootstrapped = true;
  }

  /**
   * Print the setup banner. Called on first boot and on **every** subsequent boot
   * while still unbootstrapped — a restart must not cost the operator the link.
   *
   * The sink is injectable so the tests can read what an operator would see
   * without capturing the process's own stdout.
   */
  announce(write: (chunk: string) => void = defaultWrite): void {
    const url = this.setupUrl;
    if (url === null) return;
    write(setupBanner(url));
  }
}

function defaultWrite(chunk: string): void {
  process.stdout.write(chunk);
}

/**
 * Has this instance been claimed?
 *
 * Two ways it is configured without ever having been claimable, and either one
 * means the gate must not close around it:
 *
 *  - `OPERATOR_FILE=none`, which says the credential comes from the secret and
 *    the password-change page is off. Nothing to bootstrap.
 *  - `AUTH_PASSWORD_HASH` is configured. The manual install path: the operator
 *    hashed a password by hand before the first boot, and the record will be
 *    seeded from it moments later by `OperatorRecord.open`.
 *
 * Otherwise the answer is the pair #18 describes — *the token file is deleted
 * and the operator record exists* — and it is a pair on purpose. The operator
 * record on its own is not the end of setup: **wizard step 1 writes it, with two
 * screens still to go.** Reading the record alone would mean a container that
 * restarted at that moment came back deciding it was claimed, 404ing every
 * `/setup/*` path and deleting the claim token as litter — locking the operator
 * out of steps 2 and 3 with no route back in, and breaking #18's own promise
 * that the token survives a restart mid-wizard.
 *
 * So a live claim token keeps the instance unclaimed regardless of the record,
 * and {@link Bootstrap.complete} — which refuses to delete the token before the
 * record exists — is the single moment the two line up and the door shuts.
 *
 * Note what this deliberately does *not* change: an instance with neither a hash
 * nor a record is still a first boot here, whatever else is on the data volume.
 * That is issue #58's question and is left exactly as it was.
 */
function isBootstrapped(config: OAuthConfig): boolean {
  if (config.operatorFile === null) return true;
  if (config.authPasswordHash !== null) return true;
  if (!existsSync(config.operatorFile)) return false;
  return !claimTokenPresent(config);
}

/** A claim token on disk means setup was started and never finished. */
function claimTokenPresent(config: OAuthConfig): boolean {
  return config.claimTokenFile !== null && existsSync(config.claimTokenFile);
}

/**
 * Read the token back, or create it — the precedence rule from secrets.ts,
 * reusing its writer rather than inventing a second file-writing idiom.
 *
 * The claim token is not one of the three shared secrets: only the OAuth layer
 * ever reads it, so it does not need the shared group. But it needs exactly the
 * same guarantee — the path either does not exist or holds the complete value,
 * never a half-written one — and `createExclusively` is where that guarantee
 * already lives.
 */
function resolveClaimToken(path: string): { value: string; source: ClaimTokenSource } {
  const existing = readIfPresent(path);
  if (existing !== undefined) return { value: existing, source: "file" };

  // A blank file is the one case where "a present file wins" must not apply:
  // createExclusively links a temp file into place and would refuse, leaving the
  // instance gated behind an empty token nobody can present. Clear it first.
  if (existsSync(path)) unlinkSync(path);

  const created = createExclusively(path, generateClaimToken(), "CLAIM_TOKEN");
  return { value: created.value, source: created.raced ? "file" : "generated" };
}

function readIfPresent(path: string): string | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new BootstrapError(
      `Cannot read the claim token at ${path}: ` +
        `${err instanceof Error ? err.message : String(err)}`
    );
  }
  const trimmed = raw.trim();
  // An empty file is not a token. Treating it as one would gate the instance
  // behind a credential nobody can present.
  return trimmed === "" ? undefined : trimmed;
}

/**
 * The seed to open the operator record with.
 *
 * `AUTH_PASSWORD_HASH` when there is one — the arrangement operator.ts documents,
 * where the secret seeds the record once and the record wins from then on.
 *
 * When there is not, the record's own stored hash is handed back to it. That
 * reads circular and is not: `OperatorRecord.open` warns by name when the seed
 * and the stored hash differ, because the usual cause is an operator editing the
 * secret and wondering why nothing happened. After the setup wizard there *is* no
 * secret, so a placeholder seed would fire that warning on every boot of a
 * perfectly healthy instance and teach its operator to ignore it.
 *
 * An unreadable or malformed record yields an empty hash, which verifies against
 * nothing. `OperatorRecord.open` logs the file as unreadable and falls back to
 * that seed, so a corrupted record locks the operator out rather than opening the
 * instance up — the safe direction.
 */
export function operatorSeed(config: OAuthConfig): { username: string; passwordHash: string } {
  const username = config.authUsername;
  if (config.authPasswordHash !== null) {
    return { username, passwordHash: config.authPasswordHash };
  }
  return { username, passwordHash: storedPasswordHash(config.operatorFile) ?? "" };
}

function storedPasswordHash(path: string | null): string | undefined {
  if (path === null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const hash = (parsed as { passwordHash?: unknown }).passwordHash;
  return typeof hash === "string" && hash !== "" ? hash : undefined;
}
