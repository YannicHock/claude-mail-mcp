/**
 * Shared test fixtures and small async helpers for the unit test suite.
 *
 * Kept dependency-free (Node standard library only) so the test foundation
 * doesn't pull in a test-utility package just for a handful of helpers.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { Account, AccountsFile } from "../../src/accounts.js";

/** Create a fresh, empty temp directory for a test to use as its sandbox. */
export async function makeTmpDir(prefix = "mail-mcp-test-"): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/** Recursively remove a temp directory created by {@link makeTmpDir}. */
export async function cleanupTmpDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

/**
 * Build a syntactically valid Account with sane defaults, overridable per
 * field for the scenario under test. None of the hosts/ports are real
 * services — tests must never depend on outbound network access.
 */
export function makeAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: "work",
    label: "Work",
    imap: {
      host: "imap.example.invalid",
      port: 993,
      user: "user@example.invalid",
      pass: "test-imap-secret",
      tls: true,
    },
    smtp: {
      host: "smtp.example.invalid",
      port: 465,
      user: "user@example.invalid",
      pass: "test-smtp-secret",
      tls: true,
    },
    mail: {
      defaultFrom: "user@example.invalid",
      draftsFolder: "Drafts",
      sentFolder: "Sent",
    },
    ...overrides,
  };
}

/** Write a well-formed accounts.json (version 1) into `dir`. Returns its path. */
export async function makeAccountsFile(
  dir: string,
  accounts: Account[],
  filename = "accounts.json"
): Promise<string> {
  const filePath = path.join(dir, filename);
  const data: AccountsFile = { version: 1, accounts };
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
  return filePath;
}

/** Write arbitrary raw text as the accounts file — for malformed-input tests. */
export async function writeRawAccountsFile(
  dir: string,
  content: string,
  filename = "accounts.json"
): Promise<string> {
  const filePath = path.join(dir, filename);
  await fs.writeFile(filePath, content, "utf8");
  return filePath;
}

/** A promise plus its externally-callable resolve/reject, for callback-driven tests. */
export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
}

export function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Race a promise against a timeout, rejecting with `message` if the timeout
 * wins. Used to wait for event-driven behavior (e.g. fs.watch callbacks)
 * without resorting to a fixed sleep.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message = `timed out after ${ms}ms`
): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

/**
 * Recursively assert that no object key in `value` is named `forbiddenKey`.
 * Used to prove a serialized structure never carries a credential field,
 * independent of where it's nested.
 */
export function assertNoKeyNamed(value: unknown, forbiddenKey: string, path = "$"): void {
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertNoKeyNamed(item, forbiddenKey, `${path}[${i}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (key === forbiddenKey) {
        throw new Error(`Forbidden key "${forbiddenKey}" found at ${path}.${key}`);
      }
      assertNoKeyNamed(v, forbiddenKey, `${path}.${key}`);
    }
  }
}
