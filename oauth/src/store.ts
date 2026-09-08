/**
 * Durable state: registered clients and live refresh-token sessions.
 *
 * This is deliberately a JSON file rather than a database. The whole working set
 * is a handful of DCR client records and one refresh session per connected Claude
 * surface; a database would be a second thing to back up, secure and keep running
 * for data that fits in a few kilobytes.
 *
 * What it must get right is not losing the file. Writes go to a sibling temp file
 * and are renamed into place, so a crash mid-write leaves the previous version
 * intact rather than a truncated one — losing this file logs every Claude client
 * out and forces re-registration, which is recoverable but avoidable.
 *
 * A corrupt or unreadable file is treated as empty and moved aside rather than
 * crashing the service: with `/mcp` behind it, refusing to start over unparseable
 * bookkeeping would be a worse failure than making the operator sign in again.
 */

import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { Logger } from "./logger.js";

/** An OAuth client registered through RFC 7591 dynamic client registration. */
export interface ClientRecord {
  client_id: string;
  client_id_issued_at: number;
  redirect_uris: string[];
  client_name?: string;
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: "none";
  scope?: string;
  /** Epoch seconds this client was revoked by the operator, if it has been. */
  revokedAt?: number;
}

/**
 * One refresh-token family. `jti` is the only refresh token currently accepted
 * for this session; presenting any other one for the same `sid` means a token
 * that was already rotated has resurfaced, and the family is revoked.
 */
export interface RefreshSession {
  jti: string;
  sub: string;
  clientId: string;
  scope: string;
  resource: string;
  /** Absolute expiry, epoch seconds. */
  exp: number;
}

export interface StoreData {
  version: number;
  clients: Record<string, ClientRecord>;
  sessions: Record<string, RefreshSession>;
  /**
   * Bumped whenever the operator revokes every connected client at once. Access
   * tokens are stateless JWTs and carry the epoch that was current when they were
   * issued; a token whose epoch is behind this one is rejected even though it has
   * not expired on its own. tokens.ts's access-token verification is what actually
   * reads this to reject a token.
   */
  tokenEpoch: number;
}

const CURRENT_VERSION = 1;

/**
 * Upper bound on retained client registrations. Anthropic's documentation notes
 * that DCR makes Claude "register a new client on every fresh connection", so this
 * grows without a cap. The oldest registrations are evicted first; evicting one
 * that is still in use costs a re-registration, not a lost session.
 */
export const MAX_CLIENTS = 200;

function emptyData(): StoreData {
  return { version: CURRENT_VERSION, clients: {}, sessions: {}, tokenEpoch: 0 };
}

export class Store {
  #data: StoreData;
  readonly #path: string | null;
  readonly #log: Logger;
  #writeChain: Promise<void> = Promise.resolve();
  #pending = false;
  #timer: NodeJS.Timeout | null = null;
  #closed = false;

  private constructor(path: string | null, data: StoreData, log: Logger) {
    this.#path = path;
    this.#data = data;
    this.#log = log;
  }

  /**
   * Load the store. Pass `null` for an in-memory store, which is what the unit
   * tests use — the persistence path is exercised separately rather than by every
   * test that happens to need a client record.
   */
  static async open(path: string | null, log: Logger): Promise<Store> {
    if (path === null) return new Store(null, emptyData(), log);

    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        log("info", "no state file yet, starting empty", { path });
        return new Store(path, emptyData(), log);
      }
      throw err;
    }

    const parsed = parseData(raw);
    if (!parsed) {
      // Keep the unreadable file for inspection instead of overwriting it.
      const quarantine = `${path}.corrupt-${Date.now()}`;
      await rename(path, quarantine).catch(() => {});
      log("error", "state file unreadable, starting empty", {
        path,
        moved_to: quarantine,
      });
      return new Store(path, emptyData(), log);
    }

    const store = new Store(path, parsed, log);
    const dropped = store.pruneExpiredSessions();
    if (dropped > 0) log("debug", "pruned expired sessions on load", { dropped });
    return store;
  }

  get clients(): Record<string, ClientRecord> {
    return this.#data.clients;
  }

  get sessions(): Record<string, RefreshSession> {
    return this.#data.sessions;
  }

  get tokenEpoch(): number {
    return this.#data.tokenEpoch;
  }

  getClient(clientId: string): ClientRecord | undefined {
    return this.#data.clients[clientId];
  }

  putClient(record: ClientRecord): void {
    this.#data.clients[record.client_id] = record;
    this.#evictOldestClients();
    this.save();
  }

  /** Remove a client's registration and its sessions. Returns how many sessions went. */
  deleteClient(clientId: string): number {
    delete this.#data.clients[clientId];
    const removed = this.#dropSessionsForClient(clientId);
    this.save();
    return removed;
  }

  /** Mark a client revoked and drop its sessions, leaving other clients untouched. */
  revokeClient(clientId: string, at: number): void {
    const record = this.#data.clients[clientId];
    if (record) record.revokedAt = at;
    this.#dropSessionsForClient(clientId);
    this.save();
  }

  /**
   * Revoke every connected client at once: bump the token epoch so already-issued
   * access tokens stop working (tokens.ts's access-token verification checks
   * this), clear every refresh session, and mark every client record revoked.
   */
  revokeEverything(at: number): void {
    this.#data.tokenEpoch += 1;
    this.#data.sessions = {};
    for (const record of Object.values(this.#data.clients)) {
      record.revokedAt = at;
    }
    this.save();
  }

  #dropSessionsForClient(clientId: string): number {
    let removed = 0;
    for (const [sid, session] of Object.entries(this.#data.sessions)) {
      if (session.clientId === clientId) {
        delete this.#data.sessions[sid];
        removed += 1;
      }
    }
    return removed;
  }

  getSession(sid: string): RefreshSession | undefined {
    return this.#data.sessions[sid];
  }

  putSession(sid: string, session: RefreshSession): void {
    this.#data.sessions[sid] = session;
    this.save();
  }

  deleteSession(sid: string): void {
    delete this.#data.sessions[sid];
    this.save();
  }

  /** Drop sessions whose refresh token has expired. Returns how many went. */
  pruneExpiredSessions(now: number = Math.floor(Date.now() / 1000)): number {
    let dropped = 0;
    for (const [sid, session] of Object.entries(this.#data.sessions)) {
      if (session.exp <= now) {
        delete this.#data.sessions[sid];
        dropped += 1;
      }
    }
    if (dropped > 0) this.save();
    return dropped;
  }

  #evictOldestClients(): void {
    const entries = Object.entries(this.#data.clients);
    if (entries.length <= MAX_CLIENTS) return;
    entries
      .sort((a, b) => a[1].client_id_issued_at - b[1].client_id_issued_at)
      .slice(0, entries.length - MAX_CLIENTS)
      .forEach(([clientId]) => {
        delete this.#data.clients[clientId];
      });
    this.#log("info", "evicted oldest client registrations", {
      retained: MAX_CLIENTS,
    });
  }

  /**
   * Schedule a write. Coalesced on a short timer so a token refresh — which
   * touches the store twice — does not produce two rename cycles, and serialised
   * through a promise chain so two writes never interleave on the temp file.
   */
  save(): void {
    if (this.#path === null || this.#closed) return;
    this.#pending = true;
    if (this.#timer !== null) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.flush();
    }, 25);
    // Do not hold the event loop open purely to persist bookkeeping.
    this.#timer.unref?.();
  }

  /** Write pending changes now and wait for them to land. */
  async flush(): Promise<void> {
    if (this.#path === null || !this.#pending) return this.#writeChain;
    this.#pending = false;
    const path = this.#path;
    const payload = JSON.stringify(this.#data, null, 2);
    this.#writeChain = this.#writeChain.then(async () => {
      const temp = join(dirname(path), `.${randomUUID()}.tmp`);
      try {
        // mode 0600: this file names every registered client and every live
        // session; it does not hold secrets, but it is nobody else's business.
        await writeFile(temp, payload, { encoding: "utf8", mode: 0o600 });
        await rename(temp, path);
      } catch (err) {
        this.#log("error", "failed to persist state", {
          path,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });
    return this.#writeChain;
  }

  /** Flush and stop scheduling further writes. */
  async close(): Promise<void> {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    await this.flush();
    this.#closed = true;
  }
}

function parseData(raw: string): StoreData | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Partial<StoreData>;
  if (candidate.version !== CURRENT_VERSION) return null;
  if (!isPlainObject(candidate.clients) || !isPlainObject(candidate.sessions)) {
    return null;
  }
  // Missing on any file written before tokenEpoch existed. Read as zero rather
  // than rejecting the file — quarantining it would log every connected Claude
  // client out on upgrade. Negative is out of the field's domain (an epoch
  // counter never goes backward), so it is sanitized to zero too rather than
  // carried through into the comparison tokens.ts builds revocation on.
  const tokenEpoch =
    typeof candidate.tokenEpoch === "number" &&
    Number.isInteger(candidate.tokenEpoch) &&
    candidate.tokenEpoch >= 0
      ? candidate.tokenEpoch
      : 0;
  return {
    version: CURRENT_VERSION,
    clients: candidate.clients as Record<string, ClientRecord>,
    sessions: candidate.sessions as Record<string, RefreshSession>,
    tokenEpoch,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
