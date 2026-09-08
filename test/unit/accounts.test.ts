import { test, describe } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  AccountsStore,
  AccountsStoreError,
  NoSuchAccountError,
  type Account,
} from "../../src/accounts.js";
import {
  makeTmpDir,
  cleanupTmpDir,
  makeAccount,
  makeAccountsFile,
  writeRawAccountsFile,
  deferred,
  withTimeout,
  assertNoKeyNamed,
} from "../helpers/fixtures.js";

describe("AccountsStore — loading", () => {
  test("loads a valid accounts.json; list() and ids() reflect it", async () => {
    const dir = await makeTmpDir();
    try {
      const acc1 = makeAccount({ id: "work", label: "Work", default: true });
      const acc2 = makeAccount({ id: "home", label: "Home" });
      const file = await makeAccountsFile(dir, [acc1, acc2]);
      const store = new AccountsStore(file);
      await store.start();
      try {
        assert.deepEqual(store.ids(), ["work", "home"]);
        assert.equal(store.list().length, 2);
        assert.equal(store.list()[0]?.label, "Work");
        assert.equal(store.list()[1]?.label, "Home");
      } finally {
        store.stop();
      }
    } finally {
      await cleanupTmpDir(dir);
    }
  });

  test("missing file → empty account list, no throw", async () => {
    const dir = await makeTmpDir();
    try {
      const file = path.join(dir, "accounts.json");
      const store = new AccountsStore(file);
      await assert.doesNotReject(() => store.start());
      try {
        assert.deepEqual(store.list(), []);
        assert.deepEqual(store.ids(), []);
      } finally {
        store.stop();
      }
    } finally {
      await cleanupTmpDir(dir);
    }
  });

  test("malformed JSON → AccountsStoreError, does not throw an uncaught error", async () => {
    const dir = await makeTmpDir();
    try {
      const file = await writeRawAccountsFile(dir, "{ this is not json");
      const store = new AccountsStore(file);
      await assert.rejects(() => store.start(), AccountsStoreError);
      store.stop();
    } finally {
      await cleanupTmpDir(dir);
    }
  });

  test("wrong version field → AccountsStoreError", async () => {
    const dir = await makeTmpDir();
    try {
      const file = await writeRawAccountsFile(
        dir,
        JSON.stringify({ version: 2, accounts: [] })
      );
      const store = new AccountsStore(file);
      await assert.rejects(() => store.start(), AccountsStoreError);
      store.stop();
    } finally {
      await cleanupTmpDir(dir);
    }
  });
});

describe("AccountsStore — schema validation", () => {
  const cases: Array<{ name: string; mutate: (a: ReturnType<typeof makeAccount>) => unknown }> = [
    {
      name: "missing imap.host",
      mutate: (a) => {
        const clone = structuredClone(a) as Record<string, any>;
        delete clone.imap.host;
        return clone;
      },
    },
    {
      name: "missing smtp.host",
      mutate: (a) => {
        const clone = structuredClone(a) as Record<string, any>;
        delete clone.smtp.host;
        return clone;
      },
    },
    {
      name: "missing mail.defaultFrom",
      mutate: (a) => {
        const clone = structuredClone(a) as Record<string, any>;
        delete clone.mail.defaultFrom;
        return clone;
      },
    },
  ];

  for (const { name, mutate } of cases) {
    test(`rejects account with ${name}`, async () => {
      const dir = await makeTmpDir();
      try {
        const base = makeAccount({ id: "work", default: true });
        const broken = mutate(base);
        const file = await writeRawAccountsFile(
          dir,
          JSON.stringify({ version: 1, accounts: [broken] })
        );
        const store = new AccountsStore(file);
        await assert.rejects(() => store.start(), AccountsStoreError);
        store.stop();
      } finally {
        await cleanupTmpDir(dir);
      }
    });
  }

  test("rejects duplicate account ids", async () => {
    const dir = await makeTmpDir();
    try {
      const acc1 = makeAccount({ id: "work", default: true });
      const acc2 = makeAccount({ id: "work", label: "Also work" });
      const file = await makeAccountsFile(dir, [acc1, acc2]);
      const store = new AccountsStore(file);
      await assert.rejects(() => store.start(), AccountsStoreError);
      store.stop();
    } finally {
      await cleanupTmpDir(dir);
    }
  });
});

describe("AccountsStore — resolve()", () => {
  async function setupStore(accounts: Account[]) {
    const dir = await makeTmpDir();
    const file = await makeAccountsFile(dir, accounts);
    const store = new AccountsStore(file);
    await store.start();
    return { store, dir };
  }

  test("resolve(undefined) returns the account marked default: true", async () => {
    const { store, dir } = await setupStore([
      makeAccount({ id: "home", label: "Home" }),
      makeAccount({ id: "work", label: "Work", default: true }),
    ]);
    try {
      const resolved = store.resolve();
      assert.equal(resolved.id, "work");
    } finally {
      store.stop();
      await cleanupTmpDir(dir);
    }
  });

  test("resolve(undefined) without any default falls back to the first account", async () => {
    const { store, dir } = await setupStore([
      makeAccount({ id: "home", label: "Home" }),
      makeAccount({ id: "work", label: "Work" }),
    ]);
    try {
      const resolved = store.resolve();
      assert.equal(resolved.id, "home");
    } finally {
      store.stop();
      await cleanupTmpDir(dir);
    }
  });

  test("resolve(id) returns the matching account", async () => {
    const { store, dir } = await setupStore([
      makeAccount({ id: "home", label: "Home" }),
      makeAccount({ id: "work", label: "Work", default: true }),
    ]);
    try {
      const resolved = store.resolve("home");
      assert.equal(resolved.id, "home");
    } finally {
      store.stop();
      await cleanupTmpDir(dir);
    }
  });

  test("resolve('unknown-id') throws NoSuchAccountError listing available ids", async () => {
    const { store, dir } = await setupStore([
      makeAccount({ id: "home", label: "Home" }),
      makeAccount({ id: "work", label: "Work", default: true }),
    ]);
    try {
      assert.throws(() => store.resolve("does-not-exist"), NoSuchAccountError);
      try {
        store.resolve("does-not-exist");
        assert.fail("expected resolve() to throw");
      } catch (err) {
        assert.ok(err instanceof NoSuchAccountError);
        assert.equal(err.accountId, "does-not-exist");
        assert.match(err.message, /home/);
        assert.match(err.message, /work/);
      }
    } finally {
      store.stop();
      await cleanupTmpDir(dir);
    }
  });

  test("resolve() with no accounts configured throws NoSuchAccountError", async () => {
    const dir = await makeTmpDir();
    try {
      const file = path.join(dir, "accounts.json"); // never created → empty store
      const store = new AccountsStore(file);
      await store.start();
      try {
        assert.throws(() => store.resolve(), NoSuchAccountError);
      } finally {
        store.stop();
      }
    } finally {
      await cleanupTmpDir(dir);
    }
  });
});

describe("AccountsStore — publicSummaries()", () => {
  test("never includes credentials, in any nested field", async () => {
    const dir = await makeTmpDir();
    try {
      const acc = makeAccount({
        id: "work",
        default: true,
        imap: {
          host: "imap.example.invalid",
          port: 993,
          user: "user@example.invalid",
          pass: "super-secret-imap-password",
          tls: true,
        },
        smtp: {
          host: "smtp.example.invalid",
          port: 465,
          user: "user@example.invalid",
          pass: "super-secret-smtp-password",
          tls: true,
        },
        caldav: {
          url: "https://caldav.example.invalid/",
          user: "user@example.invalid",
          pass: "super-secret-caldav-password",
        },
      });
      const file = await makeAccountsFile(dir, [acc]);
      const store = new AccountsStore(file);
      await store.start();
      try {
        const summaries = store.publicSummaries();

        // Field-by-field sanity check.
        assert.equal(summaries.length, 1);
        assert.equal(summaries[0]?.id, "work");
        assert.equal(summaries[0]?.caldav_enabled, true);

        // Recursive check: no key literally named "pass" anywhere in the
        // serialized structure, regardless of nesting.
        assertNoKeyNamed(summaries, "pass");

        // Belt and suspenders: the raw secret values must not appear in the
        // serialized output under any key name.
        const serialized = JSON.stringify(summaries);
        assert.ok(!serialized.includes("super-secret-imap-password"));
        assert.ok(!serialized.includes("super-secret-smtp-password"));
        assert.ok(!serialized.includes("super-secret-caldav-password"));
      } finally {
        store.stop();
      }
    } finally {
      await cleanupTmpDir(dir);
    }
  });
});

describe("AccountsStore — hot reload", () => {
  test("changing accounts.json fires onChange and updates list()", async () => {
    const dir = await makeTmpDir();
    try {
      const v1 = makeAccount({ id: "work", label: "Work v1", default: true });
      const file = await makeAccountsFile(dir, [v1]);
      const store = new AccountsStore(file);

      // NOTE: onChange fires once during start() for the initial load too
      // (reload() calls it unconditionally on the success path, not only on
      // subsequent changes). So we wait for the *second* invocation, which
      // corresponds to the file rewrite below.
      const calls: Account[][] = [];
      const secondChangeSeen = deferred<void>();
      await store.start((next) => {
        calls.push(next);
        if (calls.length >= 2) secondChangeSeen.resolve();
      });
      try {
        assert.equal(calls.length, 1, "onChange should have fired once for the initial load");
        assert.equal(store.list()[0]?.label, "Work v1");

        const v2 = makeAccount({ id: "work", label: "Work v2", default: true });
        await makeAccountsFile(dir, [v2]);

        await withTimeout(
          secondChangeSeen.promise,
          8000,
          "onChange callback did not fire a second time after accounts.json was rewritten"
        );

        assert.equal(calls[1]?.[0]?.label, "Work v2");
        assert.equal(store.list()[0]?.label, "Work v2");
      } finally {
        store.stop();
      }
    } finally {
      await cleanupTmpDir(dir);
    }
  });
});
