/**
 * The live operator credential.
 *
 * AUTH_PASSWORD_HASH cannot be the live value: it arrives as a Docker file-secret
 * mounted read-only under /run/secrets, and a password change has to be able to
 * write somewhere. So the secret seeds this record once and the record wins from
 * then on. `OPERATOR_FILE=none` keeps the old arrangement — hash from the secret,
 * password change unavailable — for a deployment that would rather manage the hash
 * out of band.
 *
 * The trap that arrangement creates is an operator who edits the secret file and
 * wonders why nothing happened. open() therefore logs which source is live and
 * warns by name when the two differ.
 */

import { randomUUID } from "node:crypto";
import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { Logger } from "./logger.js";
import { constantTimeEquals, hashPassword, verifyPassword } from "./passwords.js";

const CURRENT_VERSION = 1;

interface OperatorData {
  version: number;
  username: string;
  passwordHash: string;
  sessionEpoch: number;
}

export interface OperatorSeed {
  username: string;
  passwordHash: string;
}

/**
 * The shortest password this service will accept for the operator account.
 *
 * Twelve, and enforced rather than advised, because the instance becomes
 * internet-reachable the moment setup completes: this credential is what stands
 * between a mail connector and anyone who finds the address. Rejecting here
 * costs a retype; rejecting later costs an exposed instance.
 */
export const MIN_PASSWORD_LENGTH = 12;

/**
 * An upper bound, so that a submitted form cannot choose how much CPU this
 * process spends. scrypt at N=2^16 hashes the whole input, and nothing about a
 * password beyond this length is worth the memory.
 */
export const MAX_PASSWORD_LENGTH = 1024;

/** And one on the username, which is compared, stored and rendered. */
export const MAX_USERNAME_LENGTH = 64;

/** Which field a rejection belongs next to, so the form can say it in place. */
export type CredentialField = "username" | "password" | "confirmation";

export interface CredentialProblem {
  field: CredentialField;
  message: string;
}

/**
 * Check a username and password before either becomes this instance's only
 * credential.
 *
 * Returns every problem it finds rather than the first, so an operator fixing a
 * form is not sent round the loop once per mistake. An empty array means the
 * input is acceptable.
 *
 * The password-equals-username rule compares case-insensitively and after the
 * same NFKC normalisation the hash uses. `Operator`/`operator` is the same
 * guess to anyone trying it, and a check that only caught the exact spelling
 * would be a rule that reads strict and is not.
 */
export function validateNewCredentials(input: {
  username: string;
  password: string;
  confirmation: string;
}): CredentialProblem[] {
  const problems: CredentialProblem[] = [];
  const username = input.username.trim();

  if (username === "") {
    problems.push({ field: "username", message: "Enter a username." });
  } else if (username.length > MAX_USERNAME_LENGTH) {
    problems.push({
      field: "username",
      message: `Use at most ${MAX_USERNAME_LENGTH} characters.`,
    });
  } else if (/\s/.test(username)) {
    problems.push({ field: "username", message: "A username cannot contain spaces." });
  }

  if (input.password.length < MIN_PASSWORD_LENGTH) {
    problems.push({
      field: "password",
      message: `Use at least ${MIN_PASSWORD_LENGTH} characters.`,
    });
  } else if (input.password.length > MAX_PASSWORD_LENGTH) {
    problems.push({
      field: "password",
      message: `Use at most ${MAX_PASSWORD_LENGTH} characters.`,
    });
  } else if (username !== "" && sameSecretAs(input.password, username)) {
    problems.push({
      field: "password",
      message: "The password cannot be the same as the username.",
    });
  }

  if (input.confirmation !== input.password) {
    problems.push({ field: "confirmation", message: "The two passwords do not match." });
  }

  return problems;
}

function sameSecretAs(password: string, username: string): boolean {
  return (
    password.normalize("NFKC").toLowerCase() === username.normalize("NFKC").toLowerCase()
  );
}

export class OperatorRecord {
  #data: OperatorData;
  readonly #path: string | null;
  readonly #log: Logger;
  #writeChain: Promise<void> = Promise.resolve();

  private constructor(path: string | null, data: OperatorData, log: Logger) {
    this.#path = path;
    this.#data = data;
    this.#log = log;
  }

  static async open(
    path: string | null,
    seed: OperatorSeed,
    log: Logger
  ): Promise<OperatorRecord> {
    const fresh: OperatorData = {
      version: CURRENT_VERSION,
      username: seed.username,
      passwordHash: seed.passwordHash,
      sessionEpoch: 0,
    };

    if (path === null) {
      log("info", "operator credential source", { source: "secret", writable: false });
      return new OperatorRecord(null, fresh, log);
    }

    let raw: string | null = null;
    try {
      raw = await readFile(path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }

    if (raw === null) {
      const record = new OperatorRecord(path, fresh, log);
      try {
        await record.#persist();
        log("info", "operator credential source", { source: "secret (seeded)", path });
      } catch (err) {
        // A misconfigured OPERATOR_FILE (e.g. a directory the deployment never
        // created) must not crash startup: fall back to the secret in memory for
        // this process rather than locking the operator out of their own server.
        log("error", "cannot create operator file, continuing with the secret for this process", {
          path,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return record;
    }

    const parsed = parse(raw);
    if (!parsed) {
      log("error", "operator file unreadable, falling back to the secret", { path });
      return new OperatorRecord(path, fresh, log);
    }

    if (parsed.passwordHash !== seed.passwordHash) {
      // The most common cause is an operator who changed the password here and
      // later edited the secret expecting it to take effect. Say so by name.
      log("warn", "AUTH_PASSWORD_HASH differs from the stored operator hash and is ignored", {
        path,
      });
    }
    log("info", "operator credential source", { source: "file", path });
    return new OperatorRecord(path, parsed, log);
  }

  /**
   * Write a brand-new operator credential from a plaintext password.
   *
   * This is what the setup wizard's first step calls, and it is deliberately not
   * `open()` plus `changePassword()`: while the instance is unclaimed there is no
   * `OperatorRecord` in the process at all — index.ts opens one only once the
   * state check says the instance is claimed — and there is no username to seed
   * `open()` with, because choosing it is exactly what this step is for.
   *
   * An existing record is replaced, not merged, and its session epoch is bumped
   * past whatever it was. Re-running step 1 is a legitimate thing to do — the
   * operator went Back, or mistyped and returned — and it must not leave a
   * session signed against the old credential valid.
   *
   * Unlike `changePassword`, a failed write is thrown rather than only logged.
   * The wizard has to be able to tell the operator that their credential was not
   * saved; a screen that says "continue" over a record that was never written
   * would produce an instance nobody can sign in to.
   */
  static async create(
    path: string,
    credentials: { username: string; password: string },
    log: Logger
  ): Promise<OperatorRecord> {
    const previous = await readExisting(path);
    const record = new OperatorRecord(
      path,
      {
        version: CURRENT_VERSION,
        username: credentials.username.trim(),
        passwordHash: await hashPassword(credentials.password),
        sessionEpoch: (previous?.sessionEpoch ?? -1) + 1,
      },
      log
    );
    await record.#persist();
    return record;
  }

  get username(): string {
    return this.#data.username;
  }

  get sessionEpoch(): number {
    return this.#data.sessionEpoch;
  }

  get canChangePassword(): boolean {
    return this.#path !== null;
  }

  /**
   * Check a submitted username and password. The username is compared in constant
   * time and the password is verified regardless, so a wrong username and a wrong
   * password take the same path and the same time.
   */
  async verify(username: string, password: string): Promise<boolean> {
    const nameOk = constantTimeEquals(username, this.#data.username);
    const passwordOk = await verifyPassword(password, this.#data.passwordHash);
    return nameOk && passwordOk;
  }

  async changePassword(next: string): Promise<void> {
    if (this.#path === null) {
      throw new Error(
        "Password change is disabled because OPERATOR_FILE is set to none. " +
          "Rotate AUTH_PASSWORD_HASH instead."
      );
    }
    const passwordHash = await hashPassword(next);
    this.#data = {
      ...this.#data,
      passwordHash,
      sessionEpoch: this.#data.sessionEpoch + 1,
    };
    await this.#persist();
  }

  /** Invalidate every outstanding session without touching the password. */
  async bumpSessionEpoch(): Promise<void> {
    this.#data = { ...this.#data, sessionEpoch: this.#data.sessionEpoch + 1 };
    if (this.#path !== null) await this.#persist();
  }

  /**
   * Temp file, then rename. The same recipe as store.ts: a crash mid-write leaves
   * the previous credential intact rather than a truncated one that would lock the
   * operator out of their own server.
   *
   * The chain itself must never become a rejected promise: once a `.then()`-only
   * chain rejects, every later `.then()` on it skips its callback and re-throws
   * the same stale error forever, so a single transient failure (ENOSPC, EACCES,
   * a missing directory) would silently stop every future write for the rest of
   * the process's life. So the chain always resolves — failures are caught and
   * logged inside it — while this specific attempt's own outcome, success or
   * failure, is what the caller of #persist() awaits.
   */
  async #persist(): Promise<void> {
    const path = this.#path;
    if (path === null) return;
    const payload = JSON.stringify(this.#data, null, 2);
    const doWrite = async () => {
      const temp = join(dirname(path), `.${randomUUID()}.tmp`);
      await writeFile(temp, payload, { encoding: "utf8", mode: 0o600 });
      await chmod(temp, 0o600);
      await rename(temp, path);
    };
    const attempt = this.#writeChain.catch(() => {}).then(doWrite);
    this.#writeChain = attempt.catch((err) => {
      this.#log("error", "failed to persist operator record", {
        path,
        error: err instanceof Error ? err.message : String(err),
      });
    });
    return attempt;
  }
}

/** The stored record, or null when there is none this build can read. */
async function readExisting(path: string): Promise<OperatorData | null> {
  try {
    return parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

function parse(raw: string): OperatorData | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Partial<OperatorData>;
  if (candidate.version !== CURRENT_VERSION) return null;
  if (typeof candidate.username !== "string" || candidate.username === "") return null;
  if (typeof candidate.passwordHash !== "string" || candidate.passwordHash === "") return null;
  if (typeof candidate.sessionEpoch !== "number" || !Number.isInteger(candidate.sessionEpoch)) {
    return null;
  }
  return {
    version: CURRENT_VERSION,
    username: candidate.username,
    passwordHash: candidate.passwordHash,
    sessionEpoch: candidate.sessionEpoch,
  };
}
