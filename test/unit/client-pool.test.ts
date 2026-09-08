import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { AccountsStore, NoSuchAccountError, type Account } from "../../src/accounts.js";
import { ClientPool } from "../../src/client-pool.js";
import { makeTmpDir, cleanupTmpDir, makeAccount, makeAccountsFile } from "../helpers/fixtures.js";

// RFC 5737 TEST-NET-3 — reserved for documentation, guaranteed non-routable.
// Used so that if any code path here ever did try to open a real socket,
// it would fail/hang against a documentation address rather than reach a
// live host. None of the assertions below should require network I/O at all.
const UNROUTABLE_HOST = "203.0.113.1";

// Uses reload() rather than start(): these tests only need a populated
// store, not the fs.watch-based hot-reload machinery (that's covered in
// accounts.test.ts). Avoiding start()/stop() here keeps these tests
// independent of watcher lifecycle.
async function setupStore(accounts: Account[]) {
  const dir = await makeTmpDir();
  const file = await makeAccountsFile(dir, accounts);
  const store = new AccountsStore(file);
  await store.reload();
  return { store, dir };
}

describe("ClientPool", () => {
  test("for(id) returns the same instance on repeated calls (caching)", async () => {
    const { store, dir } = await setupStore([
      makeAccount({ id: "work", default: true, imap: { host: UNROUTABLE_HOST, port: 993, user: "u", pass: "p", tls: true } }),
    ]);
    try {
      const pool = new ClientPool(store);
      const a = pool.for("work");
      const b = pool.for("work");
      assert.equal(a, b);
      assert.equal(a.imap, b.imap);
      assert.equal(a.smtp, b.smtp);
    } finally {
      await cleanupTmpDir(dir);
    }
  });

  test("different accounts get different client instances", async () => {
    const { store, dir } = await setupStore([
      makeAccount({ id: "work", label: "Work", default: true, imap: { host: UNROUTABLE_HOST, port: 993, user: "u", pass: "p", tls: true } }),
      makeAccount({ id: "home", label: "Home", imap: { host: UNROUTABLE_HOST, port: 993, user: "u", pass: "p", tls: true } }),
    ]);
    try {
      const pool = new ClientPool(store);
      const work = pool.for("work");
      const home = pool.for("home");
      assert.notEqual(work, home);
      assert.notEqual(work.imap, home.imap);
      assert.notEqual(work.smtp, home.smtp);
    } finally {
      await cleanupTmpDir(dir);
    }
  });

  test("resetAll() drops the cache so the next for() call rebuilds", async () => {
    const { store, dir } = await setupStore([
      makeAccount({ id: "work", default: true, imap: { host: UNROUTABLE_HOST, port: 993, user: "u", pass: "p", tls: true } }),
    ]);
    try {
      const pool = new ClientPool(store);
      const before = pool.for("work");
      await pool.resetAll();
      const after = pool.for("work");
      assert.notEqual(before, after);
      assert.notEqual(before.imap, after.imap);
    } finally {
      await cleanupTmpDir(dir);
    }
  });

  test("for() propagates NoSuchAccountError for an unknown account id", async () => {
    const { store, dir } = await setupStore([
      makeAccount({ id: "work", default: true, imap: { host: UNROUTABLE_HOST, port: 993, user: "u", pass: "p", tls: true } }),
    ]);
    try {
      const pool = new ClientPool(store);
      assert.throws(() => pool.for("does-not-exist"), NoSuchAccountError);
    } finally {
      await cleanupTmpDir(dir);
    }
  });

  test("caldav client is only built when the account configures caldav", async () => {
    const { store, dir } = await setupStore([
      makeAccount({
        id: "work",
        default: true,
        imap: { host: UNROUTABLE_HOST, port: 993, user: "u", pass: "p", tls: true },
      }),
      makeAccount({
        id: "home",
        label: "Home",
        imap: { host: UNROUTABLE_HOST, port: 993, user: "u", pass: "p", tls: true },
        caldav: { url: "https://caldav.example.invalid/", user: "u", pass: "p" },
      }),
    ]);
    try {
      const pool = new ClientPool(store);
      assert.equal(pool.for("work").caldav, null);
      assert.notEqual(pool.for("home").caldav, null);
    } finally {
      await cleanupTmpDir(dir);
    }
  });

  test("for() never opens a real network connection — it's synchronous and returns immediately", async () => {
    const { store, dir } = await setupStore([
      makeAccount({
        id: "work",
        default: true,
        imap: { host: UNROUTABLE_HOST, port: 993, user: "u", pass: "p", tls: true },
        smtp: { host: UNROUTABLE_HOST, port: 465, user: "u", pass: "p", tls: true },
        caldav: { url: "https://caldav.example.invalid/", user: "u", pass: "p" },
      }),
    ]);
    try {
      const pool = new ClientPool(store);
      const start = Date.now();
      const clients = pool.for("work"); // not awaited — for() is not async
      const elapsed = Date.now() - start;

      // If building the client trio touched the network (DNS/connect) this
      // would either throw synchronously-ish or, more likely, this
      // assertion becomes moot because for() itself has no async boundary:
      // its return type is the plain object below, not a Promise.
      assert.equal(typeof (clients as unknown as { then?: unknown }).then, "undefined");
      assert.ok(elapsed < 200, `for() took ${elapsed}ms — suspiciously slow for a synchronous, offline call`);

      // Closing should also stay offline: no connection was ever opened by
      // ensureConnected(), so close()/resetAll() must be a no-op here.
      await pool.resetAll();
    } finally {
      await cleanupTmpDir(dir);
    }
  });
});
