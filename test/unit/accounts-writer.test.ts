import { test, after } from "node:test";
import assert from "node:assert/strict";
import type { PathLike } from "node:fs";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { AccountsStore, type Account } from "../../src/accounts.js";
import {
  RENAME_RETRY_DELAYS_MS,
  StaleStampError,
  renameWithRetry,
  writeAccountsFile,
} from "../../src/accounts-writer.js";
import { makeTmpDir, cleanupTmpDir } from "../helpers/fixtures.js";

// accounts-writer.test.ts creates a fresh AccountsStore per test (several per
// test, in fact — the "reread" case opens a second one against the same
// file). Each start() begins an fs.watch(); on Windows that keeps the whole
// `node --test` process alive if a store is never stop()'d, even with
// persistent: false (see test/helpers/fixtures.ts). Every store created below
// is stopped in a finally block for exactly that reason.

const tmpDirs: string[] = [];

/** A fresh temp directory with no accounts.json in it yet; returns its path. */
async function tempAccounts(): Promise<string> {
  const dir = await makeTmpDir();
  tmpDirs.push(dir);
  return join(dir, "accounts.json");
}

/** A syntactically valid Account, distinguishable by id. */
function sampleAccount(id: string): Account {
  return {
    id,
    label: id,
    imap: {
      host: "imap.example.invalid",
      port: 993,
      user: "user@example.invalid",
      pass: "imap-secret",
      tls: true,
    },
    smtp: {
      host: "smtp.example.invalid",
      port: 465,
      user: "user@example.invalid",
      pass: "smtp-secret",
      tls: true,
    },
    mail: {
      defaultFrom: "user@example.invalid",
      draftsFolder: "Drafts",
      sentFolder: "Sent",
    },
  };
}

after(async () => {
  await Promise.all(tmpDirs.map((dir) => cleanupTmpDir(dir)));
});

test("a written file is valid input to the parser", async () => {
  const path = await tempAccounts();
  const store = new AccountsStore(path);
  await store.start();
  const reread = new AccountsStore(path);
  try {
    await store.create(sampleAccount("work"), await store.stamp());

    await reread.start();
    assert.deepEqual(reread.ids(), ["work"]);
    assert.equal(reread.resolve("work").imap.pass, "imap-secret");
  } finally {
    store.stop();
    reread.stop();
  }
});

test("the in-memory store is current without waiting for the watcher", async () => {
  const store = new AccountsStore(await tempAccounts());
  await store.start();
  try {
    await store.create(sampleAccount("work"), await store.stamp());
    assert.deepEqual(store.ids(), ["work"], "no sleep, no fs.watch");
  } finally {
    store.stop();
  }
});

test("the file is written 0600 and no temp file is left behind", async () => {
  const path = await tempAccounts();
  const store = new AccountsStore(path);
  await store.start();
  try {
    await store.create(sampleAccount("work"), await store.stamp());
    // POSIX permission bits are not meaningful on Windows — fs.writeFile's
    // mode option is accepted there but every file reports 0666 regardless
    // (verified directly: writeFileSync(..., { mode: 0o600 }) still stats as
    // 0666 on NTFS). CI runs this suite on ubuntu-latest only, where this is
    // a real assertion.
    if (process.platform !== "win32") {
      assert.equal((await stat(path)).mode & 0o777, 0o600);
    }
    const leftovers = (await readdir(dirname(path))).filter((n) => n.endsWith(".tmp"));
    assert.deepEqual(leftovers, []);
  } finally {
    store.stop();
  }
});

test("a mutation that would produce an unreadable file leaves the old one intact", async () => {
  const path = await tempAccounts();
  const store = new AccountsStore(path);
  await store.start();
  try {
    await store.create(sampleAccount("work"), await store.stamp());
    const before = await readFile(path, "utf8");

    const broken = { ...sampleAccount("second"), imap: { ...sampleAccount("second").imap, port: 0 } };
    await assert.rejects(async () => store.create(broken as never, await store.stamp()));

    assert.equal(await readFile(path, "utf8"), before);
    assert.deepEqual(store.ids(), ["work"], "memory did not move either");
  } finally {
    store.stop();
  }
});

test("a duplicate id is refused", async () => {
  const store = new AccountsStore(await tempAccounts());
  await store.start();
  try {
    await store.create(sampleAccount("work"), await store.stamp());
    await assert.rejects(async () => store.create(sampleAccount("work"), await store.stamp()), /work/);
  } finally {
    store.stop();
  }
});

test("a refused duplicate-id create leaves the file byte-identical", async () => {
  const path = await tempAccounts();
  const store = new AccountsStore(path);
  await store.start();
  try {
    await store.create(sampleAccount("work"), await store.stamp());
    const before = await readFile(path, "utf8");

    await assert.rejects(async () => store.create(sampleAccount("work"), await store.stamp()), /work/);

    assert.equal(await readFile(path, "utf8"), before, "the file must not be touched by a refused create");
    assert.deepEqual(store.ids(), ["work"], "memory did not move either");
  } finally {
    store.stop();
  }
});

// "new" and "test" collide with the settings UI's own single-segment routes
// (GET /settings/mailboxes/new, POST /settings/mailboxes/test) — see
// RESERVED_IDS in src/accounts.ts. create() is the one entry point every new
// account has to pass through, programmatic or via the form, so it is refused
// here regardless of how it was constructed — and refused *before* the stamp
// is even checked, since it's not a concurrency question.
test("a reserved id ('new' or 'test') is refused on create", async () => {
  const store = new AccountsStore(await tempAccounts());
  await store.start();
  try {
    await assert.rejects(
      async () => store.create(sampleAccount("new"), await store.stamp()),
      /reserved/i
    );
    await assert.rejects(
      async () => store.create(sampleAccount("test"), await store.stamp()),
      /reserved/i
    );
    assert.deepEqual(store.ids(), [], "neither reserved id was persisted");
  } finally {
    store.stop();
  }
});

test("updating an unknown id is refused", async () => {
  const store = new AccountsStore(await tempAccounts());
  await store.start();
  try {
    await assert.rejects(async () => store.update("ghost", sampleAccount("ghost"), await store.stamp()));
  } finally {
    store.stop();
  }
});

test("removing an unknown id is refused and touches neither disk nor memory", async () => {
  const path = await tempAccounts();
  const store = new AccountsStore(path);
  await store.start();
  try {
    await store.create(sampleAccount("work"), await store.stamp());
    const before = await readFile(path, "utf8");

    await assert.rejects(async () => store.remove("ghost", await store.stamp()));

    assert.equal(await readFile(path, "utf8"), before, "the file must not be touched by a refused remove");
    assert.deepEqual(store.ids(), ["work"], "memory did not move either");
  } finally {
    store.stop();
  }
});

// The single-default invariant is asserted in one place, and it is not this
// file: `accounts.test.ts` — "AccountsStore — at most one default" — owns it
// across create, update and setDefault. A `setDefault` case lived here too
// until #139, which is how one rule ends up with two homes and a change to it
// gets found in only one of them.

test("a stale stamp is refused instead of clobbering the other edit", async () => {
  const path = await tempAccounts();
  const store = new AccountsStore(path);
  await store.start();
  try {
    const stamp = await store.stamp();

    await writeFile(path, JSON.stringify({ version: 1, accounts: [sampleAccount("byhand")] }), "utf8");

    await assert.rejects(
      () => store.create(sampleAccount("work"), stamp),
      (err: Error) => err.name === "StaleStampError"
    );
  } finally {
    store.stop();
  }
});

test("removing the last account leaves a valid empty file", async () => {
  const path = await tempAccounts();
  const store = new AccountsStore(path);
  await store.start();
  try {
    await store.create(sampleAccount("work"), await store.stamp());
    await store.remove("work", await store.stamp());
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { version: 1, accounts: [] });
  } finally {
    store.stop();
  }
});

test("a failed mutation does not block a later successful one (chain recovery)", async () => {
  // Guards against a specific regression: an earlier version of #mutate did
  // `this.writeChain = this.writeChain.then(async () => {...})` and
  // returned that same promise. Once one call's inner function threw,
  // `this.writeChain` became a *rejected* promise, and every subsequent
  // `.then(fn)` on it skips `fn` and just re-throws — permanently wedging
  // the store after the very first failed write. This test creates a
  // duplicate-id failure and then proves the store still accepts a
  // perfectly good mutation afterward.
  const store = new AccountsStore(await tempAccounts());
  await store.start();
  try {
    await store.create(sampleAccount("work"), await store.stamp());
    await assert.rejects(async () => store.create(sampleAccount("work"), await store.stamp()));

    // If the chain were poisoned by the rejection above, this would hang
    // forever or reject too — neither of which this call tolerates.
    await store.create(sampleAccount("home"), await store.stamp());
    assert.deepEqual(store.ids(), ["work", "home"]);
  } finally {
    store.stop();
  }
});

test("two concurrent create calls serialise rather than interleave", async () => {
  const path = await tempAccounts();
  const store = new AccountsStore(path);
  await store.start();
  try {
    const stamp = await store.stamp();

    // Both calls share one stamp, as two browser tabs opening the same form
    // would. Fired together (not awaited in sequence) so they overlap in
    // the writer's async work rather than running one after the other.
    const results = await Promise.allSettled([
      store.create(sampleAccount("a"), stamp),
      store.create(sampleAccount("b"), stamp),
    ]);

    const fulfilledCount = results.filter((r) => r.status === "fulfilled").length;
    const rejection = results.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;

    assert.equal(fulfilledCount, 1, "exactly one of the two concurrent submissions should win");
    assert.ok(rejection, "the other must be refused, not silently interleaved");
    assert.equal(rejection.reason.name, "StaleStampError");

    // The file must reflect exactly one new account — never both spliced
    // together by an interleaved write, and never neither (a lost write).
    assert.equal(store.ids().length, 1);
    const onDisk = JSON.parse(await readFile(path, "utf8"));
    assert.equal(onDisk.accounts.length, 1);

    // The rejected concurrent submission must not have poisoned the chain
    // either — a fresh, correctly-stamped mutation still goes through.
    await store.create(sampleAccount("c"), await store.stamp());
    assert.equal(store.ids().length, 2);
  } finally {
    store.stop();
  }
});

test("onChange fires exactly once for a successful mutation, and not at all for a failed one", async () => {
  const path = await tempAccounts();
  const store = new AccountsStore(path);
  const calls: Array<{ next: string[]; prev: string[] }> = [];
  await store.start((next, prev) => {
    calls.push({ next: next.map((a) => a.id), prev: prev.map((a) => a.id) });
  });
  try {
    // start() calls reload() once for the initial load; the file doesn't
    // exist yet, and reload() only dispatches on a missing file when there
    // were previously-loaded accounts to report losing — there weren't, so
    // nothing has fired yet.
    assert.equal(calls.length, 0, "no onChange from the initial load of a nonexistent file");

    await store.create(sampleAccount("work"), await store.stamp());
    assert.equal(calls.length, 1, "exactly one onChange after a successful create");
    assert.deepEqual(calls[0], { next: ["work"], prev: [] });

    // A failed mutation — duplicate id — must not dispatch onChange at all.
    // Before the fix, applyMutation's internal reload() call fired the
    // notification unconditionally, before the duplicate-id check even ran.
    await assert.rejects(async () => store.create(sampleAccount("work"), await store.stamp()));
    assert.equal(calls.length, 1, "a rejected mutation must not fire onChange");

    // A second successful mutation fires exactly once more, not twice (the
    // pre-fix code fired once from the internal reload() and again from the
    // explicit post-write dispatch).
    await store.create(sampleAccount("home"), await store.stamp());
    assert.equal(calls.length, 2, "exactly one more onChange after the next successful mutation");
    assert.deepEqual(calls[1], { next: ["work", "home"], prev: ["work"] });
  } finally {
    store.stop();
  }
});

// #219: on Windows a rename over a file another handle holds open fails with
// EPERM, and the likeliest holder is the store's own reload of the previous
// write. The rename is injected here so a busy file can be failed on demand
// instead of raced for.

/** An errno-shaped error, as fs/promises rejects with. */
function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: rename failed`), { code });
}

test("a rename refused with EPERM a few times is retried until it lands", async () => {
  let calls = 0;
  await renameWithRetry("from", "to", {
    attempt: async () => {
      calls++;
      if (calls <= 3) throw errno(calls === 2 ? "EBUSY" : "EPERM");
    },
  });
  assert.equal(calls, 4, "three refusals, then the rename that succeeded");
});

test("a rename still refused when the budget runs out rethrows the last error", async () => {
  let calls = 0;
  const started = Date.now();
  await assert.rejects(
    renameWithRetry("from", "to", {
      attempt: async () => {
        calls++;
        throw errno("EACCES");
      },
    }),
    { code: "EACCES" }
  );
  assert.equal(calls, RENAME_RETRY_DELAYS_MS.length + 1, "one try plus one per delay");
  const budget = RENAME_RETRY_DELAYS_MS.reduce((sum, ms) => sum + ms, 0);
  // A few ms of slack: timers on Windows can fire a tick early.
  assert.ok(Date.now() - started >= budget - 20, "the delays were actually waited");
});

test("a rename failing for any other reason is not retried", async () => {
  let calls = 0;
  await assert.rejects(
    renameWithRetry("from", "to", {
      attempt: async () => {
        calls++;
        throw errno("ENOENT");
      },
    }),
    { code: "ENOENT" }
  );
  assert.equal(calls, 1);
});

test("writeAccountsFile goes through the retry: one EPERM, then the file lands", async () => {
  const path = await tempAccounts();
  let calls = 0;
  await writeAccountsFile(
    path,
    { version: 1, accounts: [sampleAccount("work")] },
    {
      rename: async (from, to) => {
        calls++;
        if (calls === 1) throw errno("EPERM");
        await rename(from, to);
      },
    }
  );
  assert.equal(calls, 2);
  const written = JSON.parse(await readFile(path, "utf8")) as { accounts: Account[] };
  assert.deepEqual(
    written.accounts.map((a) => a.id),
    ["work"]
  );
});

test("a hand edit saved while a busy rename waits is refused, not overwritten", async () => {
  const path = await tempAccounts();
  const handEdit = '{\n  "version": 1,\n  "accounts": []\n}\n';
  await writeFile(path, handEdit);
  let calls = 0;
  await assert.rejects(
    writeAccountsFile(
      path,
      { version: 1, accounts: [sampleAccount("work")] },
      {
        // The editor's save is what the store's stamp check would see change.
        stillCurrent: async () => false,
        rename: async () => {
          calls++;
          throw errno("EPERM");
        },
      }
    ),
    StaleStampError
  );
  assert.equal(calls, 1, "no retry once the file is no longer the one read");
  assert.equal(await readFile(path, "utf8"), handEdit, "the hand edit is untouched");
  const left = (await readdir(dirname(path))).filter((name) => name.endsWith(".tmp"));
  assert.deepEqual(left, [], "and the temp file is gone");
});

test("a busy rename asks before each retry, and a file still current is written", async () => {
  // The precondition the store passes is its own stamp check; a busy rename
  // with nothing else changed must still land.
  const path = await tempAccounts();
  let checks = 0;
  await writeAccountsFile(
    path,
    { version: 1, accounts: [sampleAccount("work")] },
    {
      stillCurrent: async () => {
        checks++;
        return true;
      },
      rename: (() => {
        let calls = 0;
        return async (from: PathLike, to: PathLike) => {
          if (++calls <= 2) throw errno("EBUSY");
          await rename(from, to);
        };
      })(),
    }
  );
  assert.equal(checks, 2, "asked once before each of the two retries");
  assert.ok((await readFile(path, "utf8")).includes('"work"'));
});

test("a rename that never lands leaves no temp file behind", async () => {
  const path = await tempAccounts();
  // A directory where the file should go: rename refuses it on every platform
  // (EISDIR on Linux, EPERM on Windows, which also walks the retries).
  await mkdir(path);
  await assert.rejects(writeAccountsFile(path, { version: 1, accounts: [] }));
  const left = (await readdir(dirname(path))).filter((name) => name.endsWith(".tmp"));
  assert.deepEqual(left, []);
});
