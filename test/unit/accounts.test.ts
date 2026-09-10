import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  AccountsStore,
  AccountsStoreError,
  NoSuchAccountError,
  RESERVED_IDS,
  reservedIdAccounts,
  reservedIdNotice,
  type Account,
} from "../../src/accounts.js";
import {
  makeAccount,
  makeAccountsFile,
  serializeAccountsFile,
  withAccountsStore,
  withAccountsFileContent,
  deferred,
  withTimeout,
  assertNoKeyNamed,
} from "../helpers/fixtures.js";

describe("AccountsStore — loading", () => {
  test("loads a valid accounts.json; list() and ids() reflect it", async () => {
    const acc1 = makeAccount({ id: "work", label: "Work", default: true });
    const acc2 = makeAccount({ id: "home", label: "Home" });
    await withAccountsStore([acc1, acc2], (store) => {
      assert.deepEqual(store.ids(), ["work", "home"]);
      assert.equal(store.list().length, 2);
      assert.equal(store.list()[0]?.label, "Work");
      assert.equal(store.list()[1]?.label, "Home");
    });
  });

  test("missing file → empty account list, no throw", async () => {
    await withAccountsStore(undefined, (store) => {
      assert.deepEqual(store.list(), []);
      assert.deepEqual(store.ids(), []);
    });
  });

  test("malformed JSON → AccountsStoreError, does not throw an uncaught error", async () => {
    await assert.rejects(
      () => withAccountsFileContent("{ this is not json"),
      AccountsStoreError
    );
  });

  test("wrong version field → AccountsStoreError", async () => {
    await assert.rejects(
      () => withAccountsFileContent(JSON.stringify({ version: 2, accounts: [] })),
      AccountsStoreError
    );
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
      const base = makeAccount({ id: "work", default: true });
      const broken = mutate(base);
      await assert.rejects(
        () => withAccountsFileContent(serializeAccountsFile([broken])),
        AccountsStoreError
      );
    });
  }

  test("rejects duplicate account ids", async () => {
    const acc1 = makeAccount({ id: "work", default: true });
    const acc2 = makeAccount({ id: "work", label: "Also work" });
    await assert.rejects(
      () => withAccountsFileContent(serializeAccountsFile([acc1, acc2])),
      AccountsStoreError
    );
  });
});

describe("AccountsStore — resolve()", () => {
  test("resolve(undefined) returns the account marked default: true", async () => {
    await withAccountsStore(
      [
        makeAccount({ id: "home", label: "Home" }),
        makeAccount({ id: "work", label: "Work", default: true }),
      ],
      (store) => {
        const resolved = store.resolve();
        assert.equal(resolved.id, "work");
      }
    );
  });

  test("resolve(undefined) without any default falls back to the first account", async () => {
    await withAccountsStore(
      [
        makeAccount({ id: "home", label: "Home" }),
        makeAccount({ id: "work", label: "Work" }),
      ],
      (store) => {
        const resolved = store.resolve();
        assert.equal(resolved.id, "home");
      }
    );
  });

  test("resolve(id) returns the matching account", async () => {
    await withAccountsStore(
      [
        makeAccount({ id: "home", label: "Home" }),
        makeAccount({ id: "work", label: "Work", default: true }),
      ],
      (store) => {
        const resolved = store.resolve("home");
        assert.equal(resolved.id, "home");
      }
    );
  });

  test("resolve('unknown-id') throws NoSuchAccountError listing available ids", async () => {
    await withAccountsStore(
      [
        makeAccount({ id: "home", label: "Home" }),
        makeAccount({ id: "work", label: "Work", default: true }),
      ],
      (store) => {
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
      }
    );
  });

  test("resolve() with no accounts configured throws NoSuchAccountError", async () => {
    await withAccountsStore(undefined, (store) => {
      assert.throws(() => store.resolve(), NoSuchAccountError);
    });
  });
});

describe("AccountsStore — publicSummaries()", () => {
  test("never includes credentials, in any nested field", async () => {
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

    await withAccountsStore([acc], (store) => {
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
    });
  });
});

describe("AccountsStore — hot reload", () => {
  test("changing accounts.json fires onChange and updates list()", async () => {
    const v1 = makeAccount({ id: "work", label: "Work v1", default: true });

    // NOTE: onChange fires once during start() for the initial load too
    // (reload() calls it unconditionally on the success path, not only on
    // subsequent changes). So we wait for the *second* invocation, which
    // corresponds to the file rewrite below.
    const calls: Account[][] = [];
    const secondChangeSeen = deferred<void>();

    await withAccountsStore(
      [v1],
      async (store, dir) => {
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
      },
      (next) => {
        calls.push(next);
        if (calls.length >= 2) secondChangeSeen.resolve();
      }
    );
  });
});

/**
 * An accounts.json that already contains a mailbox called "new" or "test" must
 * keep loading — rejecting it in parseAccount() would take every other
 * configured mailbox down with it on the next restart (see RESERVED_IDS in
 * src/accounts.ts). What the operator gets instead is a warning, built from the
 * two helpers below, that says what is broken and how to get out of it.
 */
describe("AccountsStore — reserved ids that are already on disk", () => {
  test("a file containing a reserved id still loads, every other mailbox included", async () => {
    const work = makeAccount({ id: "work", label: "Work", default: true });
    const broken = makeAccount({ id: "test", label: "Old test mailbox" });
    await withAccountsStore([work, broken], (store) => {
      assert.deepEqual(store.ids(), ["work", "test"]);
      assert.equal(store.resolve("test").label, "Old test mailbox");
    });
  });

  test("reservedIdAccounts() picks out exactly the affected accounts", () => {
    const accounts = [
      makeAccount({ id: "work" }),
      makeAccount({ id: "test" }),
      makeAccount({ id: "new" }),
      makeAccount({ id: "testing" }),
    ];
    assert.deepEqual(
      reservedIdAccounts(accounts).map((a) => a.id),
      ["test", "new"]
    );
    assert.deepEqual(reservedIdAccounts([makeAccount({ id: "work" })]), []);
  });

  test("every reserved id has a notice of its own, none falls back to the generic one", () => {
    for (const id of RESERVED_IDS) {
      const notice = reservedIdNotice(id);
      assert.ok(notice.includes(`"${id}"`), `the notice for ${id} should name the id`);
      assert.match(notice, /recreate it under a different id/);
      assert.match(notice, /Delete and "Make default" still work/);
      assert.ok(
        !notice.includes("collides with a literal settings route"),
        `${id} should describe its own collision, not the generic fallback`
      );
    }
  });

  test("the notice tells the truth about which half of the edit page is broken", () => {
    // "test": GET /settings/mailboxes/test has no literal collision, so the
    // edit form does render — but its action is the create form's probe route.
    assert.match(reservedIdNotice("test"), /never persists/i);
    // "new": the literal GET route wins, so the page is never reached at all.
    assert.match(reservedIdNotice("new"), /Add mailbox/);
  });
});

describe("AccountsStore — at most one default", () => {
  /**
   * The invariant these cases pin: after *any* sequence of create/update
   * calls, at most one account carries `default: true` — and when a call
   * asked for a default, that account is the one that has it.
   *
   * The wizard is what made this unavoidable rather than a choice: its
   * mailbox step emits a hidden `default=1` with no way to untick it, and
   * step 2 is re-enterable, so a second mailbox arrived asking to be a
   * second default. The store is the one place that already knows the whole
   * list, so it is where the flag is made to move rather than accumulate.
   */
  function defaultIds(store: AccountsStore): string[] {
    return store
      .list()
      .filter((a) => a.default === true)
      .map((a) => a.id);
  }

  test("create(default) moves the flag off the existing default", async () => {
    const work = makeAccount({ id: "work", label: "Work", default: true });
    await withAccountsStore([work], async (store) => {
      await store.create(
        makeAccount({ id: "home", label: "Home", default: true }),
        await store.stamp()
      );

      assert.deepEqual(defaultIds(store), ["home"]);
      assert.equal(store.resolve().id, "home");
      assert.deepEqual(
        store
          .publicSummaries()
          .filter((s) => s.default)
          .map((s) => s.id),
        ["home"]
      );
    });
  });

  test("create(non-default) leaves the existing default alone", async () => {
    const work = makeAccount({ id: "work", label: "Work", default: true });
    await withAccountsStore([work], async (store) => {
      await store.create(makeAccount({ id: "home", label: "Home" }), await store.stamp());

      assert.deepEqual(defaultIds(store), ["work"]);
      assert.equal(store.resolve().id, "work");
    });
  });

  test("a run of wizard-shaped creates, each asking to be default, leaves exactly one", async () => {
    await withAccountsStore([], async (store) => {
      for (const id of ["work", "home", "side"]) {
        await store.create(makeAccount({ id, label: id, default: true }), await store.stamp());
      }

      assert.deepEqual(store.ids(), ["work", "home", "side"]);
      assert.deepEqual(defaultIds(store), ["side"]);
      assert.equal(store.resolve().id, "side");
    });
  });

  test("update(default) clears the flag on every other account", async () => {
    const work = makeAccount({ id: "work", label: "Work", default: true });
    const home = makeAccount({ id: "home", label: "Home" });
    await withAccountsStore([work, home], async (store) => {
      await store.update(
        "home",
        makeAccount({ id: "home", label: "Home", default: true }),
        await store.stamp()
      );

      assert.deepEqual(defaultIds(store), ["home"]);
      assert.equal(store.resolve().id, "home");
    });
  });

  test("update(default) on the account that already is default keeps exactly one", async () => {
    const work = makeAccount({ id: "work", label: "Work", default: true });
    const home = makeAccount({ id: "home", label: "Home" });
    await withAccountsStore([work, home], async (store) => {
      await store.update(
        "work",
        makeAccount({ id: "work", label: "Work renamed", default: true }),
        await store.stamp()
      );

      assert.deepEqual(defaultIds(store), ["work"]);
      assert.equal(store.list()[0]?.label, "Work renamed");
    });
  });

  test("update(non-default) does not promote anyone else", async () => {
    const work = makeAccount({ id: "work", label: "Work", default: true });
    const home = makeAccount({ id: "home", label: "Home" });
    await withAccountsStore([work, home], async (store) => {
      await store.update("home", makeAccount({ id: "home", label: "Home 2" }), await store.stamp());

      assert.deepEqual(defaultIds(store), ["work"]);
    });
  });

  test("a file that already carries two defaults is repaired by the next default-bearing write", async () => {
    // Hand-edited files, and files written before this fix, can hold two.
    const work = makeAccount({ id: "work", label: "Work", default: true });
    const home = makeAccount({ id: "home", label: "Home", default: true });
    await withAccountsStore([work, home], async (store) => {
      assert.deepEqual(defaultIds(store), ["work", "home"]);

      await store.create(
        makeAccount({ id: "side", label: "Side", default: true }),
        await store.stamp()
      );

      assert.deepEqual(defaultIds(store), ["side"]);
    });
  });

  test("the surviving default is what lands on disk, not just in memory", async () => {
    const work = makeAccount({ id: "work", label: "Work", default: true });
    await withAccountsStore([work], async (store, dir) => {
      await store.create(
        makeAccount({ id: "home", label: "Home", default: true }),
        await store.stamp()
      );

      const raw = await fs.readFile(path.join(dir, "accounts.json"), "utf8");
      const parsed = JSON.parse(raw) as { accounts: Array<{ id: string; default?: boolean }> };
      assert.deepEqual(
        parsed.accounts.filter((a) => a.default === true).map((a) => a.id),
        ["home"]
      );
    });
  });

  test("mixed create/update/setDefault sequences never leave two defaults", async () => {
    await withAccountsStore([], async (store) => {
      await store.create(makeAccount({ id: "a", default: true }), await store.stamp());
      await store.create(makeAccount({ id: "b", default: true }), await store.stamp());
      await store.setDefault("a", await store.stamp());
      await store.update(
        "b",
        makeAccount({ id: "b", label: "B2", default: true }),
        await store.stamp()
      );
      await store.create(makeAccount({ id: "c" }), await store.stamp());
      await store.setDefault("c", await store.stamp());
      await store.update(
        "a",
        makeAccount({ id: "a", label: "A2", default: true }),
        await store.stamp()
      );

      assert.deepEqual(defaultIds(store), ["a"]);
      assert.equal(store.resolve().id, "a");
    });
  });
});
