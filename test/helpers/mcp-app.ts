/**
 * In-process harness that starts the *real* server for integration tests.
 *
 * This file used to re-implement `bearerAuth` and `GET /health` by hand, with
 * a "keep in sync with src/index.ts" comment on each, because `src/index.ts`
 * built its Express app entirely inside `main()` and exported nothing. Every
 * MCP-protocol test therefore ran against the copy, not against the shipped
 * middleware chain: deleting the auth check from `src/index.ts` left the whole
 * suite green, so the single code path between the internet and every
 * configured mailbox was the one path nothing tested.
 *
 * `src/app.ts` now exports `createApp()` — the same function `main()` calls —
 * and this harness calls it. The routes, the Bearer check, the `/health` body,
 * the MCP handler and the 404 under test are the ones that ship. Nothing here
 * is duplicated from the server any more; what remains is lifecycle: a real
 * AccountsStore over `accountsFile`, a real ClientPool, a listener on a free
 * loopback port, and a `close()` that tears all three down.
 */

import { AccountsStore } from "../../src/accounts.js";
import { ClientPool } from "../../src/client-pool.js";
import { createApp, SERVER_NAME, VERSION } from "../../src/app.js";
import { closeServer, listenOnLoopback } from "./running-app.js";

// Re-exported so a test can assert against the values the server actually
// reports without reaching into src/ itself.
export { SERVER_NAME, VERSION };

export interface McpTestApp {
  url: string;
  port: number;
  store: AccountsStore;
  pool: ClientPool;
  close(): Promise<void>;
}

/**
 * Start the real Express app — real AccountsStore reading `accountsFile`, real
 * ClientPool, real registered tools, real `bearerAuth` — on a free loopback
 * port. `close()` guarantees the listener is closed, the store's fs.watch is
 * stopped, and pooled IMAP connections are closed, regardless of what the
 * caller did in between.
 *
 * The same guarantee also holds on the *startup* path: everything from
 * `store.start()` onward (building the pool, building the app, binding the
 * port) runs inside a try/catch that calls `store.stop()` before rethrowing.
 * Without that, a failure anywhere in this function — e.g. `app.listen`
 * erroring under port exhaustion or a firewall — would leave `store`'s
 * `fs.watch()` running with no handle ever reaching a caller to stop it: the
 * exact Windows `node --test` hang Wave 1's `fixtures.ts`
 * (`withAccountsStore`) was built to make structurally impossible. This
 * mirrors that same guarantee, just anchored to a try/catch since only the
 * failure path needs cleanup here (the success path deliberately leaves the
 * store running until the caller's `close()`).
 *
 * Not folded into `withRunningApp` (test/helpers/running-app.ts), which the three
 * unit suites now share, because the two guarantee different things and one
 * cannot be expressed as the other:
 *
 *   - `withRunningApp` owns the accounts file. It writes fixtures into a temp
 *     directory it created and removes that directory afterwards. This harness
 *     takes an `accountsFile` from the caller, because the integration tests
 *     *rewrite* that file mid-test and assert the store's `fs.watch` picked the
 *     change up. A helper that owned the file could not offer that.
 *   - `withRunningApp` is scoped: the server exists for the duration of one
 *     callback. This returns a handle whose `store` and `pool` outlive the call
 *     and stay usable until `close()`, which is what an integration test needs to
 *     drive the store and the MCP session across several steps.
 *
 * What they genuinely share — binding a free loopback port with the `error`
 * listener attached, and waiting for the close — is imported from that module
 * rather than written here again.
 */
export async function startMcpApp(opts: {
  accountsFile: string;
  authToken: string;
}): Promise<McpTestApp> {
  const store = new AccountsStore(opts.accountsFile);
  try {
    await store.start();

    const pool = new ClientPool(store);

    const app = createApp({
      store,
      pool,
      authToken: opts.authToken,
      accountsFile: opts.accountsFile,
      // Placeholder: none of these MCP-protocol tests configure a settings
      // signing key, so the settings routes never mount and this value is
      // never checked against anything.
      publicUrl: "http://localhost.invalid",
      // No `log`: createApp defaults to a no-op, keeping the test output clean.
      // src/index.ts passes its own structured logger here.
    });

    // The bind and the teardown are running-app.ts's, so the EADDRINUSE-as-an-
    // event trap and the wait-for-close are solved in one place for every harness
    // in this suite. What stays here is the part that is genuinely this harness's
    // own — see the note on `withRunningApp` below.
    const { server, url, port } = await listenOnLoopback(app);

    return {
      url,
      port,
      store,
      pool,
      close: async () => {
        await closeServer(server);
        store.stop();
        await pool.closeAll().catch(() => {});
      },
    };
  } catch (err) {
    // Structural guarantee, not a convention: any failure from here on —
    // including store.start() itself — stops the store's fs.watch before
    // the error propagates, so a thrown startMcpApp() never leaks a
    // listener that nothing can ever stop() again.
    store.stop();
    throw err;
  }
}
