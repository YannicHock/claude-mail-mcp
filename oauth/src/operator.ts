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
