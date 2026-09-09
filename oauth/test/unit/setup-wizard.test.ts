/**
 * The setup wizard's rules, away from Express.
 *
 * What is here is everything the routes only compose: which credentials are
 * acceptable, what writing one leaves on disk, how far the wizard remembers the
 * operator got, and what the two rendered screens say. The route table itself is
 * pinned in test/integration/setup-wizard.test.ts, against the real gate.
 */

import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import type { LogLevel, Logger } from "../../src/logger.js";
import { silentLogger } from "../../src/logger.js";
import {
  MIN_PASSWORD_LENGTH,
  OperatorRecord,
  validateNewCredentials,
} from "../../src/operator.js";
import { verifyPassword } from "../../src/passwords.js";
import { renderCredentialsStep, renderStepPlaceholder } from "../../src/setup-pages.js";
import { SetupState } from "../../src/setup-state.js";

const GOOD_PASSWORD = "correct horse battery staple";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "oauth-wizard-"));
}

interface LoggedLine {
  level: LogLevel;
  message: string;
}

function capturingLogger(): { lines: LoggedLine[]; log: Logger } {
  const lines: LoggedLine[] = [];
  return { lines, log: (level, message) => lines.push({ level, message }) };
}

describe("validateNewCredentials", () => {
  it("accepts a username and a long enough password typed twice", () => {
    assert.deepEqual(
      validateNewCredentials({
        username: "operator",
        password: GOOD_PASSWORD,
        confirmation: GOOD_PASSWORD,
      }),
      []
    );
  });

  it("rejects a password shorter than the minimum, and says the number", () => {
    const short = "a".repeat(MIN_PASSWORD_LENGTH - 1);
    const problems = validateNewCredentials({
      username: "operator",
      password: short,
      confirmation: short,
    });
    assert.deepEqual(
      problems.map((problem) => problem.field),
      ["password"]
    );
    assert.match(problems[0].message, new RegExp(String(MIN_PASSWORD_LENGTH)));
  });

  it("rejects a password equal to the username, whatever the case", () => {
    // Operator/operator is the same guess to anyone trying it, so a check that
    // only caught the exact spelling would read strict and not be.
    for (const password of ["operatoroperator", "OperatorOperator"]) {
      const problems = validateNewCredentials({
        username: "operatoroperator",
        password,
        confirmation: password,
      });
      assert.deepEqual(
        problems.map((problem) => problem.field),
        ["password"],
        password
      );
    }
  });

  it("rejects a mismatch between the two password fields", () => {
    const problems = validateNewCredentials({
      username: "operator",
      password: GOOD_PASSWORD,
      confirmation: `${GOOD_PASSWORD}!`,
    });
    assert.deepEqual(
      problems.map((problem) => problem.field),
      ["confirmation"]
    );
  });

  it("rejects an empty username, and one with a space in it", () => {
    for (const username of ["", "   ", "the operator"]) {
      const problems = validateNewCredentials({
        username,
        password: GOOD_PASSWORD,
        confirmation: GOOD_PASSWORD,
      });
      assert.deepEqual(
        problems.map((problem) => problem.field),
        ["username"],
        JSON.stringify(username)
      );
    }
  });

  it("reports every problem at once rather than one per round trip", () => {
    const problems = validateNewCredentials({
      username: "",
      password: "short",
      confirmation: "different",
    });
    assert.deepEqual(
      problems.map((problem) => problem.field),
      ["username", "password", "confirmation"]
    );
  });
});

describe("OperatorRecord.create", () => {
  it("writes a record the password verifies against", async () => {
    const path = join(tempDir(), "operator.json");

    await OperatorRecord.create(path, { username: "anna", password: GOOD_PASSWORD }, silentLogger);

    const stored = JSON.parse(readFileSync(path, "utf8")) as {
      version: number;
      username: string;
      passwordHash: string;
      sessionEpoch: number;
    };
    assert.equal(stored.version, 1);
    assert.equal(stored.username, "anna");
    assert.equal(stored.sessionEpoch, 0);
    assert.equal(await verifyPassword(GOOD_PASSWORD, stored.passwordHash), true);
    assert.equal(await verifyPassword("something else", stored.passwordHash), false);
    // And the plaintext is nowhere in the file.
    assert.equal(readFileSync(path, "utf8").includes(GOOD_PASSWORD), false);
  });

  it("is what OperatorRecord.open then reads back as the live credential", async () => {
    const path = join(tempDir(), "operator.json");
    await OperatorRecord.create(path, { username: "anna", password: GOOD_PASSWORD }, silentLogger);

    const reopened = await OperatorRecord.open(
      path,
      { username: "anna", passwordHash: "" },
      silentLogger
    );

    assert.equal(reopened.username, "anna");
    assert.equal(await reopened.verify("anna", GOOD_PASSWORD), true);
    assert.equal(await reopened.verify("anna", "wrong"), false);
  });

  it("trims the username, since it is compared byte for byte at sign-in", async () => {
    const path = join(tempDir(), "operator.json");
    await OperatorRecord.create(path, { username: "  anna \n", password: GOOD_PASSWORD }, silentLogger);
    assert.equal(
      (JSON.parse(readFileSync(path, "utf8")) as { username: string }).username,
      "anna"
    );
  });

  it("bumps the session epoch past an existing record", async () => {
    // Re-running step 1 is legitimate — the operator went Back, or mistyped and
    // came round again — and it must not leave a session signed against the
    // credential it replaced still valid.
    const path = join(tempDir(), "operator.json");
    writeFileSync(
      path,
      JSON.stringify({ version: 1, username: "old", passwordHash: "x", sessionEpoch: 7 })
    );

    await OperatorRecord.create(path, { username: "anna", password: GOOD_PASSWORD }, silentLogger);

    const stored = JSON.parse(readFileSync(path, "utf8")) as { sessionEpoch: number };
    assert.equal(stored.sessionEpoch, 8);
  });

  it("throws when the record cannot be written, rather than reporting success", async () => {
    // The wizard has to be able to tell the operator nothing was saved. A screen
    // that says Continue over a record that was never written produces an
    // instance nobody can sign in to.
    const path = join(tempDir(), "no-such-directory", "operator.json");
    await assert.rejects(() =>
      OperatorRecord.create(path, { username: "anna", password: GOOD_PASSWORD }, silentLogger)
    );
    assert.equal(existsSync(path), false);
  });
});

describe("SetupState", () => {
  it("starts at step 1 when nothing has been stored", () => {
    const state = SetupState.open(join(tempDir(), "setup-wizard.json"), silentLogger);
    assert.equal(state.furthest, "credentials");
    assert.equal(state.reached("credentials"), true);
    assert.equal(state.reached("mailbox"), false);
  });

  it("survives a restart: the mark is read back from the data volume", async () => {
    const path = join(tempDir(), "setup-wizard.json");
    const first = SetupState.open(path, silentLogger);

    await first.advanceTo("mailbox");
    const second = SetupState.open(path, silentLogger);

    assert.equal(second.furthest, "mailbox");
    assert.equal(second.reached("mailbox"), true);
    assert.equal(second.reached("connect"), false);
  });

  it("is a high-water mark: Back does not lose a screen already reached", async () => {
    const path = join(tempDir(), "setup-wizard.json");
    const state = SetupState.open(path, silentLogger);

    await state.advanceTo("connect");
    await state.advanceTo("credentials");

    assert.equal(state.furthest, "connect");
    assert.equal(SetupState.open(path, silentLogger).furthest, "connect");
  });

  it("starts over, and says so, when the stored progress cannot be trusted", () => {
    for (const contents of ["{ not json", JSON.stringify({ version: 99, furthest: "connect" }),
      JSON.stringify({ version: 1, furthest: "a-step-this-build-does-not-have" })]) {
      const path = join(tempDir(), "setup-wizard.json");
      writeFileSync(path, contents);
      const { lines, log } = capturingLogger();

      const state = SetupState.open(path, log);

      assert.equal(state.furthest, "credentials", contents);
      assert.ok(lines.some((line) => line.message.includes("malformed")), contents);
    }
  });

  it("keeps its progress in memory when there is no data volume to write to", async () => {
    const state = SetupState.open(null, silentLogger);
    await state.advanceTo("mailbox");
    assert.equal(state.furthest, "mailbox");
  });
});

describe("the wizard's screens", () => {
  it("step 1 asks for a username and a password twice, and says what it is not", () => {
    const html = renderCredentialsStep({
      action: "/setup/tok/credentials",
      username: "",
      problems: [],
    });

    assert.match(html, /Step 1 of 3 · Create the operator account/);
    assert.match(html, /It is not a mailbox login/);
    assert.match(html, /name="username"/);
    assert.match(html, /name="password"/);
    assert.match(html, /name="confirmation"/);
    assert.match(html, /action="\/setup\/tok\/credentials"/);
    assert.match(html, /noindex, nofollow/);
    // No client-side JavaScript anywhere in this service.
    assert.equal(/<script/i.test(html), false);
  });

  it("puts each rejection next to its own field and keeps the username typed", () => {
    const html = renderCredentialsStep({
      action: "/setup/tok/credentials",
      username: "anna",
      problems: [{ field: "confirmation", message: "The two passwords do not match." }],
    });

    assert.match(html, /value="anna"/);
    assert.match(html, /The two passwords do not match\./);
  });

  it("escapes what the operator typed rather than rendering it", () => {
    const html = renderCredentialsStep({
      action: "/setup/tok/credentials",
      username: '"><script>alert(1)</script>',
      problems: [],
    });
    assert.equal(html.includes("<script>alert(1)</script>"), false);
    assert.match(html, /&quot;&gt;&lt;script&gt;/);
  });

  it("a screen that is not built yet says so, and offers the way back", () => {
    const html = renderStepPlaceholder({ step: "mailbox", backHref: "/setup/tok/credentials" });
    assert.match(html, /Step 2 of 3 · Add your first mailbox/);
    assert.match(html, /not built yet/);
    assert.match(html, /href="\/setup\/tok\/credentials"/);
  });
});
