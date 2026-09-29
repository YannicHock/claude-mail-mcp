/**
 * A connector with its settings routes switched on, and the requests the OAuth
 * layer would send it — for the integration files that drive those routes
 * through the real Express app (`createApp`).
 *
 * Two files carried near-verbatim copies of these helpers, and a third copy is
 * where they belong here (#172). The assertion is minted with the same HMAC
 * format the OAuth layer uses, so no file depends on the oauth/ package (the two
 * cannot import from each other).
 *
 * Dependency-free beyond the connector itself, matching the rule in fixtures.ts.
 */

import { createHmac } from "node:crypto";
import { writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import { AccountsStore, type Account } from "../../src/accounts.js";
import { readStamp } from "../../src/accounts-writer.js";
import { createApp } from "../../src/app.js";
import { ClientPool } from "../../src/client-pool.js";
import { ASSERTION_HEADER } from "../../src/settings-assertion.js";
import { cleanupTmpDir, makeTmpDir } from "./fixtures.js";

export const AUTH_TOKEN = "settings-routes-test-token-please-do-not-reuse";
export const SETTINGS_KEY = "s".repeat(32);
export const CSRF = "test-csrf-value";
export const SUB = "operator";
export const SID = "session-1";

/**
 * The canonical spelling of the connector's `PUBLIC_URL` — what the OAuth layer
 * puts in every assertion's `iss`, because its own config canonicalises before
 * minting. `startConnector` configures this unless told a different spelling.
 */
export const PUBLIC_URL = "https://mail-mcp.example.invalid";

export interface Connector {
  url: string;
  accountsPath: string;
  close(): Promise<void>;
}

/** One line the connector logged, as its `Logger` was handed it. */
export interface LogLine {
  level: string;
  message: string;
  fields: Record<string, unknown>;
}

/**
 * A listening connector over a fresh `accounts.json`.
 *
 * The file is pre-seeded — empty by default: a fresh deployment that has been
 * initialised but has no mailboxes yet, and (unlike an absent file) one a
 * probe-only submission can read back afterwards to prove it wrote nothing.
 * `lines`, when given, collects everything the connector logs.
 */
export async function startConnector(
  accounts: Account[] = [],
  opts: { publicUrl?: string; lines?: LogLine[] } = {}
): Promise<Connector> {
  const dir = await makeTmpDir();
  const accountsPath = `${dir}/accounts.json`;
  await writeFile(accountsPath, JSON.stringify({ version: 1, accounts }), "utf8");
  const store = new AccountsStore(accountsPath);
  await store.start();
  const pool = new ClientPool(store);
  const lines = opts.lines;
  const app = createApp({
    store,
    pool,
    authToken: AUTH_TOKEN,
    accountsFile: accountsPath,
    settingsSigningKey: SETTINGS_KEY,
    publicUrl: opts.publicUrl ?? PUBLIC_URL,
    ...(lines === undefined
      ? {}
      : {
          log: (level: string, message: string, fields: Record<string, unknown> = {}) => {
            lines.push({ level, message, fields });
          },
        }),
  });

  const server = await new Promise<Server>((resolve, reject) => {
    const s: Server = app.listen(0, "127.0.0.1", () => resolve(s));
    s.on("error", reject);
  });
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    accountsPath,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.stop();
      await pool.closeAll().catch(() => {});
      await cleanupTmpDir(dir);
    },
  };
}

/** An assertion in the shape the OAuth layer mints, bound to this method and path. */
export function mint(
  method: string,
  path: string,
  key: string = SETTINGS_KEY,
  overrides: Record<string, unknown> = {}
): string {
  const payload = {
    v: 1,
    iss: PUBLIC_URL,
    aud: "mail-mcp-settings",
    sub: SUB,
    sid: SID,
    csrf: CSRF,
    htm: method.toUpperCase(),
    htu: path,
    exp: Math.floor(Date.now() / 1000) + 30,
    ...overrides,
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const mac = createHmac("sha256", Buffer.from(key, "utf8")).update(encoded).digest("base64url");
  return `${encoded}.${mac}`;
}

export async function get(url: string, path: string, assertion: string): Promise<Response> {
  return fetch(`${url}${path}`, {
    headers: {
      authorization: `Bearer ${AUTH_TOKEN}`,
      [ASSERTION_HEADER]: assertion,
    },
  });
}

/**
 * A form POST as a browser behind the OAuth layer sends it. `_csrf` is added
 * unless `csrf` is `""`, and a redirect is handed back rather than followed.
 */
export async function post(
  url: string,
  path: string,
  fields: Record<string, string>,
  opts: { csrf?: string; assertion?: string } = {}
): Promise<Response> {
  const body = new URLSearchParams();
  const csrf = opts.csrf ?? CSRF;
  if (csrf !== "") body.set("_csrf", csrf);
  for (const [key, value] of Object.entries(fields)) {
    body.set(key, value);
  }
  return fetch(`${url}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${AUTH_TOKEN}`,
      [ASSERTION_HEADER]: opts.assertion ?? mint("POST", path),
      "content-type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
    redirect: "manual",
  });
}

/** The `accounts.json` stamp a submission has to carry to be accepted. */
export function stampOf(accountsPath: string): Promise<string> {
  return readStamp(accountsPath);
}
