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
import {
  renderCredentialsStep,
  renderMailboxStep,
  renderStepPlaceholder,
  type MailboxPageData,
  type MailboxProbeView,
} from "../../src/setup-pages.js";
import { readFieldErrors, readProbeReport, readStamp } from "../../src/setup-routes.js";
import { SetupState } from "../../src/setup-state.js";
import { mailboxFormPage } from "../helpers/connector-pages.js";

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
    const html = renderStepPlaceholder({ step: "connect", backHref: "/setup/tok/mailbox" });
    assert.match(html, /Step 3 of 3 · Connect Claude/);
    assert.match(html, /not built yet/);
    assert.match(html, /href="\/setup\/tok\/mailbox"/);
  });
});

describe("the step 2 screen", () => {
  function mailboxPage(data: Partial<MailboxPageData> = {}): string {
    return renderMailboxStep({
      action: "/setup/tok/mailbox",
      backHref: "/setup/tok/credentials",
      values: {},
      errors: {},
      ...data,
    });
  }

  function probe(overrides: Partial<MailboxProbeView> = {}): MailboxProbeView {
    return {
      imap: { tested: true, ok: true, message: "" },
      smtp: { tested: true, ok: true, message: "" },
      caldav: { tested: false, ok: false, message: "" },
      ...overrides,
    };
  }

  it("collects a mailbox under the connector's own field names", () => {
    // The point of the exercise: no second form, no second set of names. What
    // this screen submits is what /settings/mailboxes already parses.
    const html = mailboxPage();

    assert.match(html, /Step 2 of 3 · Add your first mailbox/);
    for (const name of [
      "id",
      "label",
      "mail.defaultFrom",
      "imap.host",
      "imap.port",
      "imap.tls",
      "imap.user",
      "imap.pass",
      "smtp.host",
      "smtp.port",
      "smtp.tls",
      "smtp.user",
      "smtp.pass",
      "caldav.url",
      "caldav.user",
      "caldav.pass",
    ]) {
      assert.match(html, new RegExp(`name="${name.replace(".", "\\.")}"`), name);
    }
    assert.equal(/<script/i.test(html), false);
  });

  it("offers a way past it that does not need mail credentials to hand", () => {
    const html = mailboxPage();
    // formnovalidate, or the browser refuses to submit the empty required
    // fields and Skip becomes a button that cannot be pressed.
    assert.match(html, /name="_action" value="skip" class="secondary" formnovalidate/);
  });

  it("reports the three services on three lines, not as one verdict", () => {
    const html = mailboxPage({
      probe: probe({
        smtp: { tested: true, ok: false, message: "the server rejected these credentials" },
        caldav: { tested: true, ok: false, message: "404 Not Found" },
      }),
    });

    assert.match(html, /<strong>IMAP<\/strong><span>ok<\/span>/);
    assert.match(
      html,
      /<strong>SMTP<\/strong><span>failed: the server rejected these credentials<\/span>/
    );
    assert.match(html, /<strong>CalDAV<\/strong><span>failed: 404 Not Found<\/span>/);
  });

  it("says CalDAV was not tested rather than passing it off as a failure", () => {
    const html = mailboxPage({ probe: probe() });
    assert.match(html, /<strong>CalDAV<\/strong><span>not tested<\/span>/);
    assert.equal(html.includes('class="probe-row fail"'), false);
  });

  it("keeps what was typed, except the passwords", () => {
    const html = mailboxPage({
      values: { "imap.host": "imap.example.com", "imap.user": "anna@example.com" },
      errors: { "imap.host": "Required." },
    });

    assert.match(html, /value="imap\.example\.com"/);
    assert.match(html, /value="anna@example\.com"/);
    assert.match(html, /Required\./);
    // Every password box comes back empty, the way the connector's own form
    // renders one. Nothing here may write a mailbox password into a page.
    for (const match of html.matchAll(/<input[^>]*type="password"[^>]*>/g)) {
      assert.match(match[0], /value=""/);
    }
  });

  it("escapes what the operator typed rather than rendering it", () => {
    const html = mailboxPage({ values: { "imap.host": '"><script>alert(1)</script>' } });
    assert.equal(html.includes("<script>alert(1)</script>"), false);
  });

  it("offers only the way onward when the connector cannot be reached at all", () => {
    const html = mailboxPage({ unavailable: true });
    assert.match(html, /no settings signing key/);
    assert.match(html, /value="skip"/);
    assert.equal(html.includes('name="imap.host"'), false);
  });
});

describe("reading the connector's answers", () => {
  it("reads one result per service out of the probe panel", () => {
    const report = readProbeReport(
      mailboxFormPage({
        probe: {
          imap: { ok: true },
          smtp: { ok: false, message: "the server rejected these credentials" },
          caldav: { ok: false, message: "404 Not Found" },
        },
      })
    );

    assert.deepEqual(report, {
      imap: { tested: true, ok: true, message: "" },
      smtp: { tested: true, ok: false, message: "the server rejected these credentials" },
      caldav: { tested: true, ok: false, message: "404 Not Found" },
    });
  });

  it("reads a missing CalDAV row as not tested, not as a failure", () => {
    // The connector omits the row entirely when no CalDAV URL was submitted.
    const report = readProbeReport(
      mailboxFormPage({ probe: { imap: { ok: true }, smtp: { ok: true } } })
    );
    assert.deepEqual(report?.caldav, { tested: false, ok: false, message: "" });
  });

  it("un-escapes a failure message rather than showing the entities back", () => {
    const report = readProbeReport(
      mailboxFormPage({
        probe: { imap: { ok: true }, smtp: { ok: false, message: 'no "route" to <host> & no reply' } },
      })
    );
    assert.equal(report?.smtp.message, 'no "route" to <host> & no reply');
  });

  it("reads nothing at all as nothing, so a save cannot proceed on it", () => {
    // Fail closed. An answer this build cannot read is not evidence that the
    // mailbox works, and the caller refuses to store credentials without a
    // report for them.
    assert.equal(readProbeReport(mailboxFormPage()), null);
    assert.equal(readProbeReport("<html><body>Unauthorized</body></html>"), null);
    assert.equal(
      readProbeReport(mailboxFormPage({ probe: { imap: { ok: true }, smtp: { ok: true } } }))?.imap
        .ok,
      true
    );
  });

  it("reads each rejected field under the name the connector rejected", () => {
    const errors = readFieldErrors(
      mailboxFormPage({
        errors: {
          id: 'An account with id "main" already exists.',
          "imap.port": "Must be a port number between 1 and 65535.",
        },
      })
    );

    assert.deepEqual(errors, {
      id: 'An account with id "main" already exists.',
      "imap.port": "Must be a port number between 1 and 65535.",
    });
  });

  it("reads the accounts stamp the connector's own form was rendered from", () => {
    assert.equal(readStamp(mailboxFormPage({ stamp: "412-1757000000000" })), "412-1757000000000");
    assert.equal(readStamp(mailboxFormPage()), "absent");
    assert.equal(readStamp("<html><body>Unauthorized</body></html>"), null);
  });
});
