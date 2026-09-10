/**
 * Start a real server on a real socket for a test, and guarantee it comes down.
 *
 * Four files had written this by hand — test/unit/app-body-limits.test.ts,
 * test/unit/app-trust-proxy.test.ts, test/unit/settings-headers.test.ts and
 * test/helpers/mcp-app.ts — and the listen/teardown halves of the first two were
 * character-for-character identical. Each copy is four things that have to be
 * right at once:
 *
 *   1. bind port 0 on 127.0.0.1, so tests never collide and never leave the
 *      loopback interface;
 *   2. attach an `error` listener to the same call, because `app.listen()`
 *      reports EADDRINUSE/EACCES as an event and a Promise that only resolves
 *      from the callback would hang forever instead of failing;
 *   3. close the listener in a `finally` opened *before* the caller's assertions
 *      run — a failing assertion otherwise leaves a listening socket behind and
 *      `node --test` hangs on Windows instead of reporting the failure;
 *   4. close the ClientPool too, swallowing its errors, since a pool that was
 *      never connected still holds nothing worth failing a test over.
 *
 * Written once, those four are structural. Written four times, they were a
 * convention, and a convention is exactly what a fifth caller forgets.
 */

import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

import type { Account, AccountsStore } from "../../src/accounts.js";
import { createApp, type CreateAppOptions } from "../../src/app.js";
import { ClientPool } from "../../src/client-pool.js";
import { makeAccount, withAccountsStore } from "./fixtures.js";

/** The shape of anything that can be listened on — Express apps included. */
interface Listenable {
  listen(port: number, host: string, listeningListener: () => void): Server;
}

/**
 * Bind `app` to a free loopback port and hand back the listener plus its URL.
 *
 * The caller owns the returned `server` and must close it; prefer
 * {@link withServer}, which does that for you. This exists for
 * {@link import("./mcp-app.js").startMcpApp}, whose contract is a handle with a
 * `close()` rather than a scoped callback.
 */
export async function listenOnLoopback(
  app: Listenable
): Promise<{ server: Server; url: string; port: number }> {
  const server = await new Promise<Server>((resolve, reject) => {
    const s: Server = app.listen(0, "127.0.0.1", () => resolve(s));
    s.on("error", reject);
  });
  const { port } = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${port}`, port };
}

/** Close a listener started by {@link listenOnLoopback}, waiting for it to be down. */
export async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

/**
 * Serve `app` on a free loopback port for the duration of `fn`, then close it —
 * whether `fn` returned, threw, or failed an assertion.
 */
export async function withServer<T>(
  app: Listenable,
  fn: (baseUrl: string) => Promise<T> | T
): Promise<T> {
  const { server, url } = await listenOnLoopback(app);
  try {
    return await fn(url);
  } finally {
    await closeServer(server);
  }
}

/** What a caller may override on the app {@link withRunningApp} builds. */
export interface RunningAppOptions
  extends Partial<Omit<CreateAppOptions, "store" | "pool" | "accountsFile">> {
  /**
   * The mailboxes the temp accounts.json is written with. Defaults to a single
   * default mailbox — enough for `/health` and for every route that only needs
   * *some* account to exist.
   */
  accounts?: Account[];
}

/** The store, pool and temp directory behind a {@link withRunningApp} server. */
export interface RunningApp {
  store: AccountsStore;
  pool: ClientPool;
  /** The temp directory holding accounts.json. */
  dir: string;
}

/**
 * Run the connector's real app — real `createApp`, real ClientPool, a temp-dir
 * AccountsStore — on a free loopback port, and hand `fn` its base URL.
 *
 * Offline by construction: the mailboxes are `*.example.invalid` fixtures and
 * nothing connects to them unless a test makes it. Everything is torn down in a
 * `finally`: the listener, the pool, the store's `fs.watch` (via
 * `withAccountsStore`) and the temp directory.
 */
export async function withRunningApp<T>(
  overrides: RunningAppOptions,
  fn: (baseUrl: string, app: RunningApp) => Promise<T> | T
): Promise<T> {
  const { accounts, ...appOverrides } = overrides;
  const mailboxes = accounts ?? [makeAccount({ id: "work", label: "Work", default: true })];

  return withAccountsStore(mailboxes, async (store, dir) => {
    const pool = new ClientPool(store);
    const app = createApp({
      authToken: "unit-test-token",
      publicUrl: "http://localhost.invalid",
      ...appOverrides,
      store,
      pool,
      accountsFile: path.join(dir, "accounts.json"),
    });

    try {
      return await withServer(app, (baseUrl) => fn(baseUrl, { store, pool, dir }));
    } finally {
      await pool.closeAll().catch(() => {});
    }
  });
}
