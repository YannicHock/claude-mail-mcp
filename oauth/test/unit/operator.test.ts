import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { silentLogger } from "../../src/logger.js";
import { OperatorRecord } from "../../src/operator.js";
import { hashPassword } from "../../src/passwords.js";

const FAST_SCRYPT = { N: 1024, r: 8, p: 1 } as const;

async function seed() {
  return { username: "operator", passwordHash: await hashPassword("first", FAST_SCRYPT) };
}

async function tempFile(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "operator-")), "operator.json");
}

test("the record is seeded from the secret on first open", async () => {
  const path = await tempFile();
  const record = await OperatorRecord.open(path, await seed(), silentLogger);
  assert.equal(record.username, "operator");
  assert.equal(record.sessionEpoch, 0);
  assert.equal(await record.verify("operator", "first"), true);
  const written = JSON.parse(await readFile(path, "utf8"));
  assert.equal(written.version, 1);
  assert.equal(written.sessionEpoch, 0);
});

test("the stored hash wins over the seed on reopen", async () => {
  const path = await tempFile();
  const first = await OperatorRecord.open(path, await seed(), silentLogger);
  await first.changePassword("second");

  const reopened = await OperatorRecord.open(path, await seed(), silentLogger);
  assert.equal(await reopened.verify("operator", "second"), true);
  assert.equal(await reopened.verify("operator", "first"), false);
});

test("changing the password bumps the session epoch", async () => {
  const record = await OperatorRecord.open(await tempFile(), await seed(), silentLogger);
  assert.equal(record.sessionEpoch, 0);
  await record.changePassword("second");
  assert.equal(record.sessionEpoch, 1);
});

test("a wrong username costs the same answer as a wrong password", async () => {
  const record = await OperatorRecord.open(await tempFile(), await seed(), silentLogger);
  assert.equal(await record.verify("someone-else", "first"), false);
  assert.equal(await record.verify("operator", "wrong"), false);
});

test("the file is written 0600", async () => {
  const path = await tempFile();
  const record = await OperatorRecord.open(path, await seed(), silentLogger);
  await record.changePassword("second");
  const mode = (await stat(path)).mode & 0o777;
  assert.equal(mode, 0o600);
});

test("a corrupt file falls back to the seed instead of refusing to start", async () => {
  const path = await tempFile();
  await writeFile(path, "{ not json", "utf8");
  const record = await OperatorRecord.open(path, await seed(), silentLogger);
  assert.equal(await record.verify("operator", "first"), true);
});

test("with no path the record is read-only and the password cannot be changed", async () => {
  const record = await OperatorRecord.open(null, await seed(), silentLogger);
  assert.equal(record.canChangePassword, false);
  assert.equal(await record.verify("operator", "first"), true);
  await assert.rejects(() => record.changePassword("second"), /OPERATOR_FILE/);
});
