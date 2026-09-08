import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { AccountsStore, type Account } from "../../src/accounts.js";
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

test("updating an unknown id is refused", async () => {
  const store = new AccountsStore(await tempAccounts());
  await store.start();
  try {
    await assert.rejects(async () => store.update("ghost", sampleAccount("ghost"), await store.stamp()));
  } finally {
    store.stop();
  }
});

test("setDefault moves the flag rather than adding a second one", async () => {
  const store = new AccountsStore(await tempAccounts());
  await store.start();
  try {
    await store.create({ ...sampleAccount("work"), default: true }, await store.stamp());
    await store.create(sampleAccount("home"), await store.stamp());
    await store.setDefault("home", await store.stamp());
    assert.equal(store.list().filter((a) => a.default).length, 1);
    assert.equal(store.resolve().id, "home");
  } finally {
    store.stop();
  }
});

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
