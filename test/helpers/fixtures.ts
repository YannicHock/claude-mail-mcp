/**
 * Shared test fixtures and small async helpers for the unit test suite.
 *
 * Kept dependency-free (Node standard library only) so the test foundation
 * doesn't pull in a test-utility package just for a handful of helpers.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { AccountsStore, type Account } from "../../src/accounts.js";

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

/**
 * Serialize a version-1 accounts.json body. Takes `unknown[]` rather than
 * `Account[]` so schema-validation tests can pass deliberately-broken,
 * non-Account shapes through the same serialization path as valid fixtures.
 */
export function serializeAccountsFile(accounts: unknown[]): string {
  return JSON.stringify({ version: 1, accounts }, null, 2);
}

/** Write a well-formed accounts.json (version 1) into `dir`. Returns its path. */
export async function makeAccountsFile(
  dir: string,
  accounts: Account[],
  filename = "accounts.json"
): Promise<string> {
  const filePath = path.join(dir, filename);
  await fs.writeFile(filePath, serializeAccountsFile(accounts), "utf8");
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

/**
 * Own the full lifecycle of a temp-dir-backed AccountsStore: writes
 * `accounts` (version 1) into a fresh temp dir — or writes no file at all
 * when `accounts` is `undefined`, for "missing accounts.json" scenarios —
 * starts the store, hands it to `fn`, and *guarantees* `store.stop()` and
 * temp-dir removal afterwards regardless of how `fn` or `store.start()`
 * itself exits.
 *
 * This exists so no test has to remember to call `store.stop()` by hand: on
 * Windows, an AccountsStore that was start()'d (which begins an
 * `fs.watch()`) but never stop()'d hangs the whole `node --test` process
 * even though the watcher is created with `persistent: false` — a nasty,
 * silent way to reintroduce a CI hang. Routing every accounts.test.ts case
 * through this helper (and withAccountsFileContent below) makes that
 * cleanup structural instead of a convention someone can forget.
 */
export async function withAccountsStore<T>(
  accounts: Account[] | undefined,
  fn: (store: AccountsStore, dir: string) => Promise<T> | T,
  onChange?: (next: Account[], prev: Account[]) => void
): Promise<T> {
  const dir = await makeTmpDir();
  try {
    const file = path.join(dir, "accounts.json");
    if (accounts !== undefined) {
      await fs.writeFile(file, serializeAccountsFile(accounts), "utf8");
    }
    const store = new AccountsStore(file);
    try {
      await store.start(onChange);
      return await fn(store, dir);
    } finally {
      store.stop();
    }
  } finally {
    await cleanupTmpDir(dir);
  }
}

/**
 * Like {@link withAccountsStore}, but for scenarios where the accounts file
 * itself is malformed and `store.start()` is expected to reject (bad JSON,
 * wrong version, missing required fields, duplicate ids, ...). `fn` only
 * runs if `start()` actually succeeds; typical callers instead wrap the
 * whole call in `assert.rejects(...)`. `store.stop()` and temp-dir cleanup
 * are still guaranteed either way.
 */
export async function withAccountsFileContent<T>(
  rawContent: string,
  fn: (store: AccountsStore, dir: string) => Promise<T> | T = () => undefined as T
): Promise<T> {
  const dir = await makeTmpDir();
  try {
    const file = path.join(dir, "accounts.json");
    await fs.writeFile(file, rawContent, "utf8");
    const store = new AccountsStore(file);
    try {
      await store.start();
      return await fn(store, dir);
    } finally {
      store.stop();
    }
  } finally {
    await cleanupTmpDir(dir);
  }
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
