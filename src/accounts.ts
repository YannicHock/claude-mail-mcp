/**
 * Accounts store — multi-account credential management.
 *
 * Replaces the single-account .env approach from v0.1. Accounts live in a JSON
 * file whose path comes from ACCOUNTS_FILE — /var/lib/mail-mcp/accounts.json
 * for the systemd deployment, /data/accounts.json in the container. You write
 * it by hand; no setup UI ships with this repository. The backend reads the
 * file on startup and re-reads it whenever the file changes (fs.watch), so
 * credentials can be added or rotated without restarting the server.
 *
 * File format (version 1):
 *   {
 *     "version": 1,
 *     "accounts": [
 *       {
 *         "id": "work",
 *         "label": "Work (markusstoeger.com)",
 *         "default": true,
 *         "imap": { "host": "...", "port": 993, "user": "...", "pass": "...", "tls": true },
 *         "smtp": { "host": "...", "port": 465, "user": "...", "pass": "...", "tls": true },
 *         "mail": { "defaultFrom": "...", "defaultFromName": "", "draftsFolder": "Drafts", "sentFolder": "Sent" },
 *         "caldav": { "url": "...", "user": "...", "pass": "..." }   // optional
 *       }
 *     ]
 *   }
 *
 * Storage security: the file is expected to be chmod 600, owned by the user
 * the server runs as, and to live on a partition the systemd unit's
 * ProtectSystem= can write to. No app-level
 * encryption — filesystem perms + systemd hardening are the security
 * boundary. (This matches how SSH keys, GPG keys and most service-credential
 * files are handled.)
 */

import { promises as fs } from "node:fs";
import { watch, FSWatcher } from "node:fs";
import path from "node:path";

import { readStamp, writeAccountsFile, StaleStampError } from "./accounts-writer.js";

export interface ImapCreds {
  host: string;
  port: number;
  user: string;
  pass: string;
  tls: boolean;
}

export interface SmtpCreds {
  host: string;
  port: number;
  user: string;
  pass: string;
  tls: boolean;
}

export interface CalDavCreds {
  url: string;
  user: string;
  pass: string;
}

export interface MailDefaults {
  defaultFrom: string;
  defaultFromName?: string;
  draftsFolder: string;
  sentFolder: string | null;
}

export interface Account {
  id: string;
  label: string;
  default?: boolean;
  imap: ImapCreds;
  smtp: SmtpCreds;
  mail: MailDefaults;
  caldav?: CalDavCreds;
}

export interface AccountsFile {
  version: 1;
  accounts: Account[];
}

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/**
 * Ids the settings UI's routing cannot serve. `settings-pages.ts` builds its edit
 * form's action and its "test connection" `formaction` as `/settings/mailboxes/${id}`
 * and `/settings/mailboxes/${id}/test`; `settings-routes.ts` registers the literal
 * single-segment `/settings/mailboxes/new` (GET) and `/settings/mailboxes/test`
 * (POST) ahead of the `:id` routes they would otherwise collide with, so the literal
 * always wins. An account named "test" can still be *viewed* via
 * `GET /settings/mailboxes/test` (that route has no literal collision), but its edit
 * form posts to a URL that is actually the create-probe route, so saving through the
 * browser silently never persists. An account named "new" can't even be opened.
 *
 * `AccountsStore.create()` below refuses these at the one place every new account
 * — programmatic or via the form — has to pass through. This is deliberately *not*
 * enforced in `parseAccount()`/`parseAccountsFile()`, which both load an existing
 * accounts.json and validate one being written back out: rejecting a reserved id
 * there would make a file that already has an account called "test" fail to load
 * at all, taking every other configured mailbox down with it. An operator who
 * already has such an account keeps a broken in-place edit until they delete and
 * recreate it under another id — worse than ideal, but far better than the
 * connector refusing to start.
 */
export const RESERVED_IDS = new Set(["new", "test"]);

export class AccountsStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccountsStoreError";
  }
}

export class NoSuchAccountError extends Error {
  constructor(public readonly accountId: string, availableIds: string[]) {
    super(
      availableIds.length === 0
        ? `No mailbox accounts configured yet. Open the setup page at the connector's /settings URL to add one.`
        : `Account "${accountId}" is not configured. Available: ${availableIds.join(", ")}.`
    );
    this.name = "NoSuchAccountError";
  }
}

export class AccountsStore {
  private accounts: Account[] = [];
  private byId: Map<string, Account> = new Map();
  private watcher: FSWatcher | null = null;
  private readonly filePath: string;
  private onChange?: (next: Account[], prev: Account[]) => void;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  /**
   * Initial load from disk. Returns the loaded accounts list (which may be
   * empty if the file doesn't exist yet — that's a valid "first run" state).
   * Then starts watching the file for changes.
   */
  async start(onChange?: (next: Account[], prev: Account[]) => void): Promise<void> {
    this.onChange = onChange;
    await this.reload();
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    } catch {
      // Best-effort; reload would have already failed for permission issues.
    }
    this.watchFile();
  }

  /** Shut down the fs.watch listener. */
  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }

  /**
   * Re-read accounts.json from disk. Safe to call repeatedly. If the file
   * is missing the store reverts to an empty account list (not an error).
   */
  async reload(): Promise<void> {
    const prev = this.accounts;
    const { accounts: next, present } = await this.readFromDisk();
    this.accounts = next;
    this.byId = new Map(next.map((a) => [a.id, a]));
    // reload()'s own dispatch contract, unchanged from before: fire whenever
    // the file was actually present and parsed (even if content is
    // unchanged — the fs.watch debounce path relies on that), and also on a
    // missing-file transition away from having had accounts. This is
    // deliberately unrelated to applyMutation()'s single, success-only fire
    // below — reload() is also the watcher's path, and its semantics are
    // out of scope for the write path added here.
    if (this.onChange && (present || prev.length > 0)) {
      this.onChange(next, prev);
    }
  }

  /**
   * The read-and-parse half of {@link reload}, without the memory
   * assignment or the `onChange` dispatch. Used by {@link applyMutation} to
   * get a fresh, current view of the file without reload()'s unconditional
   * notification firing before a mutation is even known to succeed.
   */
  private async readFromDisk(): Promise<{ accounts: Account[]; present: boolean }> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return { accounts: [], present: false };
      }
      throw err;
    }
    const parsed = parseAccountsFile(raw);
    return { accounts: parsed.accounts, present: true };
  }

  /** All currently-loaded accounts. */
  list(): Account[] {
    return this.accounts;
  }

  /** Just the IDs — handy for error messages. */
  ids(): string[] {
    return this.accounts.map((a) => a.id);
  }

  /**
   * Resolve an account ID to a full Account. If no ID is given, returns the
   * `default: true` account, or the first one if none is marked default.
   * Throws NoSuchAccountError if the ID is unknown or the store is empty.
   */
  resolve(accountId?: string): Account {
    if (accountId) {
      const acc = this.byId.get(accountId);
      if (!acc) throw new NoSuchAccountError(accountId, this.ids());
      return acc;
    }
    const def = this.accounts.find((a) => a.default) ?? this.accounts[0];
    if (!def) throw new NoSuchAccountError("(default)", []);
    return def;
  }

  /**
   * Public summaries for the list_accounts MCP tool — never include
   * credentials in the response.
   */
  publicSummaries(): Array<{
    id: string;
    label: string;
    default: boolean;
    smtp_from: string;
    imap_host: string;
    caldav_enabled: boolean;
  }> {
    return this.accounts.map((a) => ({
      id: a.id,
      label: a.label,
      default: Boolean(a.default),
      smtp_from: a.mail.defaultFrom,
      imap_host: a.imap.host,
      caldav_enabled: Boolean(a.caldav?.url),
    }));
  }

  /** The on-disk version this store currently reflects. Pass it back into a
   * mutation to prove the form it came from hasn't gone stale. */
  async stamp(): Promise<string> {
    return readStamp(this.filePath);
  }

  /** Add a new account. Rejects if `account.id` is already taken or reserved
   * (see {@link RESERVED_IDS}) — the one entry point every new account, whether
   * created through the settings form or programmatically, has to pass through. */
  async create(account: Account, stamp: string): Promise<void> {
    if (RESERVED_IDS.has(account.id)) {
      throw new AccountsStoreError(
        `"${account.id}" is a reserved id and can't be used for a mailbox. Choose another id.`
      );
    }
    await this.mutate(stamp, (accounts) => {
      if (accounts.some((a) => a.id === account.id)) {
        throw new AccountsStoreError(`An account with id "${account.id}" already exists.`);
      }
      return [...accounts, account];
    });
  }

  /** Replace an existing account wholesale. Rejects if `id` is unknown. */
  async update(id: string, account: Account, stamp: string): Promise<void> {
    await this.mutate(stamp, (accounts) => {
      const index = accounts.findIndex((a) => a.id === id);
      if (index === -1) {
        throw new NoSuchAccountError(
          id,
          accounts.map((a) => a.id)
        );
      }
      const next = [...accounts];
      next[index] = account;
      return next;
    });
  }

  /** Remove an account. Rejects if `id` is unknown. */
  async remove(id: string, stamp: string): Promise<void> {
    await this.mutate(stamp, (accounts) => {
      if (!accounts.some((a) => a.id === id)) {
        throw new NoSuchAccountError(
          id,
          accounts.map((a) => a.id)
        );
      }
      return accounts.filter((a) => a.id !== id);
    });
  }

  /** Mark `id` as the default account, clearing the flag on every other one
   * first — the flag moves rather than accumulating a second holder. */
  async setDefault(id: string, stamp: string): Promise<void> {
    await this.mutate(stamp, (accounts) => {
      if (!accounts.some((a) => a.id === id)) {
        throw new NoSuchAccountError(
          id,
          accounts.map((a) => a.id)
        );
      }
      return accounts.map((a) => ({ ...a, default: a.id === id ? true : undefined }));
    });
  }

  /**
   * Shared mutation path for create/update/remove/setDefault.
   *
   * Writes are serialised through `writeChain` so two concurrent form
   * submissions cannot interleave — each waits for the previous one to
   * settle before it re-reads the stamp. A failure must not poison later
   * writes, so the chain itself always resolves; only the promise handed
   * back to this call's caller carries the rejection.
   */
  private mutate(stamp: string, change: (accounts: Account[]) => Account[]): Promise<void> {
    const attempt = this.writeChain.then(() => this.applyMutation(stamp, change));
    this.writeChain = attempt.then(
      () => undefined,
      () => undefined
    );
    return attempt;
  }

  private async applyMutation(
    stamp: string,
    change: (accounts: Account[]) => Account[]
  ): Promise<void> {
    // Re-read rather than trusting memory: a hand edit since the last load is
    // a change the operator meant, and the stamp check is what tells them
    // apart from a stale form submission. Uses the non-dispatching read, not
    // reload(), so a rejected mutation (duplicate id, unknown id, a failed
    // round-trip parse, a stale stamp) never fires onChange as a side
    // effect — only a write that actually completes does, exactly once,
    // below.
    const current = await readStamp(this.filePath);
    if (current !== stamp) throw new StaleStampError();
    const { accounts: prev } = await this.readFromDisk();

    const next = change(prev);
    const file: AccountsFile = { version: 1, accounts: next };

    // Only after the rename returns does memory move — a failed write must
    // leave both the file and the in-memory list untouched.
    await writeAccountsFile(this.filePath, file);

    this.accounts = next;
    this.byId = new Map(next.map((a) => [a.id, a]));
    if (this.onChange) {
      this.onChange(next, prev);
    }
  }

  private watchFile(): void {
    // fs.watch on a missing file throws; watch the parent directory and
    // filter to our basename for robustness across editor save patterns
    // (vim writes with a swap-and-rename, which fires on the directory).
    const dir = path.dirname(this.filePath);
    const base = path.basename(this.filePath);
    let pending: NodeJS.Timeout | null = null;
    try {
      this.watcher = watch(dir, { persistent: false }, (_evt, filename) => {
        if (!filename || filename !== base) return;
        if (pending) clearTimeout(pending);
        // Debounce: editors can fire multiple events for a single save.
        pending = setTimeout(() => {
          this.reload().catch((err) => {
            // Don't crash the server on a malformed save; just keep the old
            // accounts in memory.
            console.error(
              JSON.stringify({
                ts: new Date().toISOString(),
                level: "error",
                msg: "accounts.json reload failed",
                error: err instanceof Error ? err.message : String(err),
              })
            );
          });
        }, 150);
      });
    } catch (err) {
      console.error(
        JSON.stringify({
          ts: new Date().toISOString(),
          level: "warn",
          msg: "accounts.json watch failed; hot reload disabled",
          error: err instanceof Error ? err.message : String(err),
        })
      );
    }
  }
}

export function parseAccountsFile(raw: string): AccountsFile {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new AccountsStoreError(
      `accounts.json is not valid JSON: ${err instanceof Error ? err.message : err}`
    );
  }
  if (!json || typeof json !== "object") {
    throw new AccountsStoreError("accounts.json must be a JSON object");
  }
  const obj = json as { version?: unknown; accounts?: unknown };
  if (obj.version !== 1) {
    throw new AccountsStoreError(`Unsupported accounts.json version: ${obj.version}. Expected 1.`);
  }
  if (!Array.isArray(obj.accounts)) {
    throw new AccountsStoreError("accounts.json must have an `accounts` array");
  }
  const accounts: Account[] = obj.accounts.map((a, i) => parseAccount(a, i));
  const ids = new Set<string>();
  for (const a of accounts) {
    if (ids.has(a.id)) {
      throw new AccountsStoreError(`Duplicate account id: ${a.id}`);
    }
    ids.add(a.id);
  }
  return { version: 1, accounts };
}

function parseAccount(raw: unknown, index: number): Account {
  if (!raw || typeof raw !== "object") {
    throw new AccountsStoreError(`accounts[${index}] must be an object`);
  }
  const a = raw as Record<string, unknown>;
  const id = expectStr(a.id, `accounts[${index}].id`);
  if (!ID_PATTERN.test(id)) {
    throw new AccountsStoreError(
      `accounts[${index}].id must match ${ID_PATTERN} (a-z, 0-9, _, -; 1-32 chars; start alphanumeric)`
    );
  }
  return {
    id,
    label: expectStr(a.label, `accounts[${index}].label`),
    default: a.default === true ? true : undefined,
    imap: parseImap(a.imap, `accounts[${index}].imap`),
    smtp: parseSmtp(a.smtp, `accounts[${index}].smtp`),
    mail: parseMail(a.mail, `accounts[${index}].mail`),
    caldav: a.caldav ? parseCalDav(a.caldav, `accounts[${index}].caldav`) : undefined,
  };
}

function parseImap(raw: unknown, where: string): ImapCreds {
  if (!raw || typeof raw !== "object") {
    throw new AccountsStoreError(`${where} must be an object`);
  }
  const o = raw as Record<string, unknown>;
  return {
    host: expectStr(o.host, `${where}.host`),
    port: expectInt(o.port, `${where}.port`),
    user: expectStr(o.user, `${where}.user`),
    pass: expectStr(o.pass, `${where}.pass`),
    tls: typeof o.tls === "boolean" ? o.tls : true,
  };
}

function parseSmtp(raw: unknown, where: string): SmtpCreds {
  if (!raw || typeof raw !== "object") {
    throw new AccountsStoreError(`${where} must be an object`);
  }
  const o = raw as Record<string, unknown>;
  return {
    host: expectStr(o.host, `${where}.host`),
    port: expectInt(o.port, `${where}.port`),
    user: expectStr(o.user, `${where}.user`),
    pass: expectStr(o.pass, `${where}.pass`),
    tls: typeof o.tls === "boolean" ? o.tls : true,
  };
}

function parseMail(raw: unknown, where: string): MailDefaults {
  if (!raw || typeof raw !== "object") {
    throw new AccountsStoreError(`${where} must be an object`);
  }
  const o = raw as Record<string, unknown>;
  const sentRaw = o.sentFolder;
  const sentFolder =
    sentRaw === null || sentRaw === ""
      ? null
      : typeof sentRaw === "string"
        ? sentRaw
        : "Sent";
  return {
    defaultFrom: expectStr(o.defaultFrom, `${where}.defaultFrom`),
    defaultFromName: typeof o.defaultFromName === "string" ? o.defaultFromName : undefined,
    draftsFolder: typeof o.draftsFolder === "string" && o.draftsFolder.length > 0 ? o.draftsFolder : "Drafts",
    sentFolder,
  };
}

function parseCalDav(raw: unknown, where: string): CalDavCreds {
  if (!raw || typeof raw !== "object") {
    throw new AccountsStoreError(`${where} must be an object`);
  }
  const o = raw as Record<string, unknown>;
  return {
    url: expectStr(o.url, `${where}.url`),
    user: expectStr(o.user, `${where}.user`),
    pass: expectStr(o.pass, `${where}.pass`),
  };
}

function expectStr(v: unknown, where: string): string {
  if (typeof v !== "string" || v.length === 0) {
    throw new AccountsStoreError(`${where} must be a non-empty string`);
  }
  return v;
}

function expectInt(v: unknown, where: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 65535) {
    throw new AccountsStoreError(`${where} must be an integer 1-65535`);
  }
  return v;
}
