/**
 * The setup wizard's rules, away from Express.
 *
 * What is here is everything the routes only compose: which credentials are
 * acceptable, what writing one leaves on disk, how far the wizard remembers the
 * operator got, and what the rendered screens say — the three steps and the
 * completion page that follows the last of them. The route table itself, and the
 * claim this instance is finished with, are pinned in
 * test/integration/setup-wizard.test.ts against the real gate.
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
import { escapeHtml } from "../../src/login.js";
import { MAIL_PROVIDERS } from "../../src/providers.js";
import {
  CHECKBOX_ON,
  draftFromFields,
  flattenDraft,
  MAILBOX_FIELDS,
  MAILBOX_FIELD_NAMES,
  parseErrorAnswer,
  parseProbeAnswer,
  parseStampAnswer,
} from "../../src/settings-api.js";
import {
  ADDRESS_FIELD,
  PROVIDER_FIELD,
  PROVIDER_OTHER,
  renderConnectStep,
  renderCredentialsStep,
  renderMailboxAddressStep,
  renderMailboxProviderStep,
  renderMailboxStep,
  renderMailboxSuggestionStep,
  renderSetupComplete,
  SHARED_PASSWORD_FIELD,
  type CompletePageData,
  type ConnectPageData,
  type MailboxAddressPageData,
  type MailboxPageData,
  type MailboxProbeView,
  type MailboxProviderPageData,
  type MailboxSuggestionPageData,
} from "../../src/setup-pages.js";
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

});

describe("the step 3 screen", () => {
  function connectPage(data: Partial<ConnectPageData> = {}): string {
    return renderConnectStep({
      action: "/setup/tok/connect",
      backHref: "/setup/tok/mailbox",
      mcpUrl: "https://mail.example.com/mcp",
      publicUrl: "https://mail.example.com",
      mailboxes: [],
      connectorReachable: true,
      ...data,
    });
  }

  it("shows the MCP URL to copy, and offers the way back", () => {
    const html = connectPage({ mailboxes: [{ id: "main", label: "Main mailbox" }] });

    assert.match(html, /Step 3 of 3 · Connect Claude/);
    assert.match(html, /value="https:\/\/mail\.example\.com\/mcp"/);
    assert.match(html, /href="\/setup\/tok\/mailbox"/);
    assert.match(html, /action="\/setup\/tok\/connect"/);
    // The claimed-to-be-copyable field must not be editable into something else.
    assert.match(html, /id="mcp_url"[^>]*readonly/);
    // No client-side JavaScript anywhere in this service — so no copy button,
    // and the CSP the page is served with would block one in any case.
    assert.equal(/<script/i.test(html), false);
  });

  it("asks the operator to confirm PUBLIC_URL rather than merely printing it", () => {
    const html = connectPage();

    assert.match(html, /PUBLIC_URL/);
    assert.match(html, /name="public_url_ok" value="yes"/);
    assert.match(html, /name="public_url_ok" value="no"/);
    // The reason it is asked at all: the failure surfaces at claude.ai, not here.
    assert.match(html, /claude\.ai/);
  });

  /**
   * Where a fragment first appears, having asserted it appears at all.
   *
   * Presence is what the old, backwards screen already satisfied, so the
   * assertions below compare two offsets in one rendered page rather than
   * testing that both halves exist.
   */
  function positionOf(html: string, needle: RegExp): number {
    const at = html.search(needle);
    assert.notEqual(at, -1, `the page does not contain ${String(needle)}`);
    return at;
  }

  it("asks the question before it offers the MCP URL to copy", () => {
    const html = connectPage({ mailboxes: [{ id: "main", label: "Main mailbox" }] });

    const question = positionOf(html, /name="public_url_ok" value="yes"/);
    const field = positionOf(html, /id="mcp_url"/);
    const copy = positionOf(html, /copy it/i);
    const connector = positionOf(html, /Settings → Connectors/);

    assert.ok(question < field, "the confirmation comes before the MCP URL field");
    assert.ok(question < copy, "and before the instruction to copy that address");
    assert.ok(question < connector, "and before the claude.ai steps it is copied for");
  });

  it("shows the address being confirmed above the question, not only below it", () => {
    // Confirming an address the screen has not shown you is worse than the
    // ordering bug: PUBLIC_URL itself is in the first half, as the value under
    // question rather than as something to copy.
    const html = connectPage();

    const shown = positionOf(html, /<code>https:\/\/mail\.example\.com<\/code>/);
    const field = positionOf(html, /id="mcp_url"/);

    assert.ok(shown < field, "PUBLIC_URL is legible before the derived address appears");
  });

  it("puts the No guidance before anything has been offered to copy", () => {
    const html = connectPage({ showPublicUrlHelp: true });

    const help = positionOf(html, /cannot be changed from here/i);
    const field = positionOf(html, /id="mcp_url"/);

    assert.ok(help < field, "the fix is explained before the wrong address is handed over");
  });

  it("still requires an answer in the markup, in the form Finish submits", () => {
    const html = connectPage();

    const form = positionOf(html, /<form method="post"/);
    const question = positionOf(html, /name="public_url_ok" value="yes" required/);
    const finish = positionOf(html, /<button type="submit">Finish<\/button>/);

    assert.ok(form < question && question < finish, "the radios are inside the form");
    // One form on this screen, so Finish cannot be a submit that skips them.
    assert.equal(html.split("<form").length - 1, 1);
  });

  it("says what to change when the operator answers No, and that a restart is needed", () => {
    const html = connectPage({ showPublicUrlHelp: true });

    assert.match(html, /cannot be changed from here/i);
    assert.match(html, /PUBLIC_URL=https:\/\/mail\.example\.com/);
    assert.match(html, /docker compose up -d/);
    // And that the link they are holding survives that restart.
    assert.match(html, /keeps working/i);
  });

  it("names the mailbox step 2 saved, or says plainly that there is none", () => {
    assert.match(
      connectPage({ mailboxes: [{ id: "main", label: "Main mailbox" }] }),
      /Main mailbox/
    );
    assert.match(connectPage({ mailboxes: [] }), /No mailbox is configured/i);
  });

  it("treats an unreachable connector as a remark, not a blocker", () => {
    const html = connectPage({ connectorReachable: false });
    assert.match(html, /did not answer/i);
    assert.match(html, /does not stop you finishing/i);
    assert.match(html, /<button type="submit">Finish<\/button>/);
  });

  it("escapes a mailbox label rather than rendering it", () => {
    const html = connectPage({
      mailboxes: [{ id: "main", label: '"><script>alert(1)</script>' }],
    });
    assert.equal(html.includes("<script>alert(1)</script>"), false);
    assert.match(html, /&quot;&gt;&lt;script&gt;/);
  });
});

describe("the completion screen", () => {
  function completePage(data: Partial<CompletePageData> = {}): string {
    return renderSetupComplete({
      mcpUrl: "https://mail.example.com/mcp",
      settingsUrl: "https://mail.example.com/settings",
      mailboxes: [],
      connectorReachable: true,
      ...data,
    });
  }

  it("says setup is over, repeats the MCP URL, and says the link is dead", () => {
    const html = completePage();

    assert.match(html, /Setup is complete/i);
    assert.match(html, /value="https:\/\/mail\.example\.com\/mcp"/);
    // The two shipped strings this screen has to make true.
    assert.match(html, /404/);
    assert.match(html, /claim token/i);
    assert.equal(/<script/i.test(html), false);
  });

  it("sends the operator to the settings UI without a restart", () => {
    // This screen used to print `docker compose restart mail-oauth`, because the
    // settings mount was decided at construction against an operator record that
    // did not exist when the process started. It is resolved per request now
    // (#121), so the page has one fewer instruction and no command at all.
    const html = completePage();

    assert.match(html, /https:\/\/mail\.example\.com\/settings/);
    assert.equal(/docker compose restart/.test(html), false);
    assert.equal(/<pre>/.test(html), false, "nothing left for the operator to run");
    // Said of both halves now: /mcp and the settings UI alike.
    assert.match(html, /no restart/i);
  });

  it("does not carry a Step N of 3 line: there is no step 4", () => {
    assert.equal(/Step \d of 3/.test(completePage()), false);
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
    //
    // The list is MAILBOX_FIELD_NAMES rather than a copy of it, which is the
    // request half of #69: a field renamed in one package used to go quietly
    // missing on the way to the other, and the connector then reported
    // "Required." for a box the operator had filled in. There is one table of
    // names now, and this is what says this form renders all of it.
    const html = mailboxPage();

    assert.match(html, /Step 2 of 3 · Add your first mailbox/);
    for (const name of MAILBOX_FIELD_NAMES) {
      // The three mail.* defaults are the connector's business, not this
      // screen's: they are left at their stored defaults and the operator
      // changes them from the settings UI once setup is finished.
      if (name.startsWith("mail.") && name !== "mail.defaultFrom") continue;
      assert.ok(html.includes(`name="${name}"`), `step 2's form has no box named ${name}`);
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

  it("fills the password boxes in when an earlier screen carried one", () => {
    // The other half of #120. "Never written back" is about a value read out of
    // storage or echoed after a failed probe — a password that may well be the
    // reason the probe failed. A password carried forward from the screen the
    // operator typed it on is neither: it is their own submission, still in
    // flight, and the screen that arrives empty is the one that asks twice.
    const html = mailboxPage({
      values: {
        "imap.host": "imap.example.com",
        "imap.pass": "hunter2",
        "smtp.pass": "hunter2",
      },
    });

    assert.match(html, /name="imap\.pass" type="password" value="hunter2"/);
    assert.match(html, /name="smtp\.pass" type="password" value="hunter2"/);
    // And the page says why they are not empty, in place of the line that says
    // passwords are never written back — which on this path would be a lie.
    assert.match(html, /carried over/i);
    assert.equal(/never written back/i.test(html), false);
  });

  it("escapes what the operator typed rather than rendering it", () => {
    const html = mailboxPage({ values: { "imap.host": '"><script>alert(1)</script>' } });
    assert.equal(html.includes("<script>alert(1)</script>"), false);
  });

  it("escapes a carried password rather than rendering it", () => {
    const html = mailboxPage({ values: { "imap.pass": '"><script>alert(1)</script>' } });
    assert.equal(html.includes("<script>alert(1)</script>"), false);
  });

  it("offers only the way onward when the connector cannot be reached at all", () => {
    const html = mailboxPage({ unavailable: true });
    assert.match(html, /no settings signing key/);
    assert.match(html, /value="skip"/);
    assert.equal(html.includes('name="imap.host"'), false);
  });
});

describe("the mailbox draft the wizard sends", () => {
  it("reads a submitted form into a draft and flattens it straight back", () => {
    const submitted: Record<string, string> = {
      id: "main",
      label: "Main mailbox",
      default: "1",
      "mail.defaultFrom": "anna@example.com",
      "mail.defaultFromName": "Anna",
      "mail.draftsFolder": "Drafts",
      "mail.sentFolder": "Sent",
      "imap.host": "imap.example.com",
      "imap.port": "993",
      "imap.user": "anna@example.com",
      "imap.pass": "secret",
      "imap.tls": "1",
      "smtp.host": "smtp.example.com",
      "smtp.port": "465",
      "smtp.user": "anna@example.com",
      "smtp.pass": "secret",
      "smtp.tls": "1",
      "caldav.url": "https://dav.example.com",
      "caldav.user": "anna",
      "caldav.pass": "secret",
    };

    assert.deepEqual(flattenDraft(draftFromFields(submitted)), submitted);
  });

  it("keeps an unticked checkbox unticked rather than defaulting it back on", () => {
    // A browser sends nothing at all for a checkbox that is off, so "absent"
    // has to survive the round trip as false — otherwise an operator who turns
    // TLS off gets it turned back on for them.
    const draft = draftFromFields({ "imap.host": "imap.example.com" });
    assert.equal(draft.imap.tls, false);
    assert.equal(draft.default, false);
    assert.equal(flattenDraft(draft)["imap.tls"], "");
  });

  it("has no CalDAV block when nothing was typed into one, and one when anything was", () => {
    assert.equal(draftFromFields({ id: "main" }).caldav, null);
    // Not only the URL: a half-filled CalDAV section has to come back to the
    // operator with what they typed still in it.
    assert.deepEqual(draftFromFields({ "caldav.user": "anna" }).caldav, {
      url: "",
      user: "anna",
      pass: "",
    });
    assert.equal("caldav.url" in flattenDraft(draftFromFields({ id: "main" })), false);
  });

  it("reads a repeated or missing field as absent rather than as an array", () => {
    const draft = draftFromFields({ id: ["main", "other"], label: undefined });
    assert.equal(draft.id, "");
    assert.equal(draft.label, "");
  });
});

describe("reading the connector's answers", () => {
  it("reads one result per service out of the probe answer", () => {
    const report = parseProbeAnswer({
      probe: {
        imap: { ok: true },
        smtp: { ok: false, message: "the server rejected these credentials" },
        caldav: { ok: false, message: "404 Not Found" },
      },
    });

    assert.deepEqual(report, {
      imap: { ok: true },
      smtp: { ok: false, message: "the server rejected these credentials" },
      caldav: { ok: false, message: "404 Not Found" },
    });
  });

  it("reads a null CalDAV result as not tested, not as a failure", () => {
    // The connector reports null when no CalDAV URL was submitted.
    const report = parseProbeAnswer({ probe: { imap: { ok: true }, smtp: { ok: true }, caldav: null } });
    assert.equal(report?.caldav, null);
    // Absent is the same thing said more quietly, and reads the same way.
    assert.equal(parseProbeAnswer({ probe: { imap: { ok: true }, smtp: { ok: true } } })?.caldav, null);
  });

  it("reads nothing it does not recognise as nothing, so a save cannot proceed on it", () => {
    // Fail closed. An answer this build cannot read is not evidence that the
    // mailbox works, and the caller refuses to store credentials without a
    // report for them.
    assert.equal(parseProbeAnswer(undefined), null);
    assert.equal(parseProbeAnswer({}), null);
    assert.equal(parseProbeAnswer({ probe: { imap: { ok: true } } }), null, "SMTP missing");
    assert.equal(parseProbeAnswer({ probe: { imap: { ok: true }, smtp: { ok: "yes" } } }), null);
    // A failure with no message is not a failure this screen can report on.
    assert.equal(parseProbeAnswer({ probe: { imap: { ok: false }, smtp: { ok: true } } }), null);
    // Present but unreadable is not the same as absent: it is not guessed at.
    assert.equal(
      parseProbeAnswer({ probe: { imap: { ok: true }, smtp: { ok: true }, caldav: {} } }),
      null
    );
  });

  it("reads each rejected field under the name the connector rejected", () => {
    const answer = parseErrorAnswer({
      errors: {
        id: 'An account with id "main" already exists.',
        "imap.port": "Must be a port number between 1 and 65535.",
        "imap.pass": "Required.",
      },
    });

    assert.deepEqual(answer.errors, {
      id: 'An account with id "main" already exists.',
      "imap.port": "Must be a port number between 1 and 65535.",
      "imap.pass": "Required.",
    });
  });

  it("drops a rejection under a name this build has no box for", () => {
    // The error map is rendered against the form. A connector on a different
    // release must not be able to put arbitrary keys into it.
    const answer = parseErrorAnswer({ errors: { "imap.host": "Required.", nonsense: "boo" } });
    assert.deepEqual(answer.errors, { "imap.host": "Required." });
  });

  it("reads a refusal it cannot parse as a refusal with nothing to point at", () => {
    assert.deepEqual(parseErrorAnswer(undefined), { errors: {} });
    assert.deepEqual(parseErrorAnswer("Unauthorized"), { errors: {} });
    assert.deepEqual(parseErrorAnswer({ message: "not a draft" }), {
      message: "not a draft",
      errors: {},
    });
  });

  it("reads the accounts stamp the connector states", () => {
    assert.equal(parseStampAnswer({ stamp: "412-1757000000000" }), "412-1757000000000");
    assert.equal(parseStampAnswer({}), null);
    assert.equal(parseStampAnswer("<html><body>Unauthorized</body></html>"), null);
  });
});

// ---- Step 2's first two tiers ---------------------------------------------

const STEP_TWO_LINKS = {
  action: "/setup/tok/mailbox",
  backHref: "/setup/tok/credentials",
  addressHref: "/setup/tok/mailbox",
  providersHref: "/setup/tok/mailbox?view=providers",
  manualHref: "/setup/tok/mailbox?view=manual",
};

describe("tier 1 — the address screen", () => {
  const render = (data: Partial<MailboxAddressPageData> = {}): string =>
    renderMailboxAddressStep({ ...STEP_TWO_LINKS, email: "", errors: {}, ...data });

  it("asks for two things, not eighteen", () => {
    // The whole reason this screen exists ahead of the full form. If it ever
    // grows a host box, the cascade has collapsed back into the thing this
    // milestone was written to remove.
    const html = render();
    assert.match(html, /Step 2 of 3 · Add your first mailbox/);
    assert.match(html, new RegExp(`name="${ADDRESS_FIELD}"`));
    assert.match(html, new RegExp(`name="${SHARED_PASSWORD_FIELD}"`));

    for (const name of [
      MAILBOX_FIELDS.imapHost,
      MAILBOX_FIELDS.imapPort,
      MAILBOX_FIELDS.smtpHost,
      MAILBOX_FIELDS.caldavUrl,
      MAILBOX_FIELDS.mailDraftsFolder,
    ]) {
      assert.equal(html.includes(`name="${name}"`), false, `tier 1 renders a box for ${name}`);
    }
  });

  it("offers the two tiers below it, so the lookup is never the only way", () => {
    const html = render();
    assert.match(html, /Choose provider manually/);
    assert.match(html, /Enter all the settings myself/);
    assert.match(html, /view=providers/);
    assert.match(html, /view=manual/);
  });

  it("can be skipped without mail credentials to hand", () => {
    // `formnovalidate`, because both boxes are `required` and a browser will
    // not submit an empty form at all — which would make Skip unpressable.
    assert.match(render(), /name="_action" value="skip"[^>]*formnovalidate|formnovalidate[^>]*/);
    assert.match(render(), /value="skip"/);
  });

  it("puts a rejected address back in the box, escaped", () => {
    const html = render({
      email: '"><script>alert(1)</script>',
      errors: { [ADDRESS_FIELD]: "Enter a full email address, like anna@example.com." },
    });
    assert.equal(html.includes("<script>"), false);
    assert.match(html, /Enter a full email address/);
    assert.match(html, /aria-invalid="true"/);
  });

  it("never writes a password back into the page", () => {
    assert.match(
      render(),
      new RegExp(`name="${SHARED_PASSWORD_FIELD}"[^>]*value=""`),
      "the password box has something in it"
    );
  });
});

/**
 * The rendered body, without the inline stylesheet.
 *
 * Every wizard page carries the same `<style>` block, and it defines `.error`
 * and `.field-error` — so a test asking "does this screen report an error"
 * against the whole document always says yes, and would say yes for a screen
 * that reported nothing at all. §7's promise is about what the operator reads.
 */
function visibleBody(html: string): string {
  const end = html.indexOf("</style>");
  return end === -1 ? html : html.slice(end);
}

describe("the confirmation screen", () => {
  const values = (extra: Record<string, string> = {}): Record<string, string> => ({
    [MAILBOX_FIELDS.id]: "main",
    [MAILBOX_FIELDS.label]: "Main mailbox",
    [MAILBOX_FIELDS.mailDefaultFrom]: "anna@example.com",
    [MAILBOX_FIELDS.imapHost]: "imap.example.com",
    [MAILBOX_FIELDS.imapPort]: "993",
    [MAILBOX_FIELDS.imapUser]: "anna@example.com",
    [MAILBOX_FIELDS.imapTls]: CHECKBOX_ON,
    [MAILBOX_FIELDS.smtpHost]: "smtp.example.com",
    [MAILBOX_FIELDS.smtpPort]: "587",
    [MAILBOX_FIELDS.smtpUser]: "anna@example.com",
    [MAILBOX_FIELDS.smtpTls]: "",
    ...extra,
  });

  const render = (data: Partial<MailboxSuggestionPageData> = {}): string =>
    renderMailboxSuggestionStep({
      ...STEP_TWO_LINKS,
      domain: "example.com",
      sourceLabel: "Published by autoconfig.example.com.",
      values: values(),
      password: "the-mailbox-password-itself",
      errors: {},
      ...data,
    });

  it("shows what was found instead of applying it", () => {
    // The point of the screen. A wrong autoconfig answer that fails at connect
    // time is far harder to diagnose than one the operator read first, so every
    // value that is about to be used appears on the page in words.
    const html = render();
    assert.match(html, /Found settings for example\.com/);
    assert.match(html, /imap\.example\.com:993/);
    assert.match(html, /smtp\.example\.com:587/);
    assert.match(html, /TLS/);
    assert.match(html, /STARTTLS/);
    assert.match(html, /Published by autoconfig\.example\.com\./);
  });

  it("says CalDAV was not found as an ordinary fact, not a failure", () => {
    // Most mail providers publish nothing for CalDAV and calendars are optional
    // in the account model. An operator who reads "not found" as a problem goes
    // looking for one that is not there.
    const html = render();
    assert.match(html, /CalDAV/);
    assert.match(html, /not found — calendars can be added later/);
    assert.equal(/CalDAV[\s\S]{0,120}(failed|error)/i.test(html), false, html);
  });

  it("shows a CalDAV endpoint when the lookup found one", () => {
    const html = render({
      values: values({
        [MAILBOX_FIELDS.caldavUrl]: "https://dav.example.com/",
        [MAILBOX_FIELDS.caldavUser]: "anna@example.com",
      }),
    });
    assert.match(html, /https:\/\/dav\.example\.com\//);
    assert.equal(html.includes("not found"), false);
  });

  it("carries every value into the save as a hidden field", () => {
    // The rows and the hidden inputs come off the same record, so what the
    // operator confirmed is exactly what gets probed. A value shown but not
    // carried would be a confirmation of something that never happened.
    const html = render();
    for (const [name, value] of Object.entries(values())) {
      assert.match(
        html,
        new RegExp(`<input type="hidden" name="${name.replace(".", "\\.")}" value="${value}">`),
        `${name} is shown but not carried`
      );
    }
  });

  it("offers Edit these, which does not validate the password box first", () => {
    assert.match(render(), /value="edit"[^>]*formnovalidate/);
    assert.match(render(), /Edit these/);
  });

  it("carries the password it was given rather than asking for it twice", () => {
    // #120. The operator typed it on the previous screen; this one is rendered
    // from that same submission, so there is a password to carry and no reason
    // to make them type it again. It travels in the form, in the browser, over
    // the POST the rest of the draft is already travelling on — and nowhere
    // near the wizard's state file, which still holds nothing but progress.
    const html = render({ password: "hunter2" });
    assert.match(
      html,
      new RegExp(`<input type="hidden" name="${SHARED_PASSWORD_FIELD}" value="hunter2">`)
    );
    assert.equal(/type="password"/.test(html), false, "there is still a box to fill in");
  });

  it("says the password is carried rather than carrying it invisibly", () => {
    // A hidden field the operator cannot see is a screen that has silently
    // acquired a credential: they cannot tell whether Continue is about to use
    // the one they typed, and they cannot tell why the next screen is filled
    // in. So the screen says both, and says where to change it.
    const html = render({ password: "hunter2" });
    assert.match(html, /carried/i);
    assert.match(html, /Edit these/);
  });

  it("asks for one when the submission arrived without a password", () => {
    // `required` on the address screen is the browser's promise, not this
    // package's: a POST that skipped it still has to produce a usable screen.
    const html = render({ password: "" });
    assert.match(html, new RegExp(`name="${SHARED_PASSWORD_FIELD}"[^>]*type="password"`));
    assert.match(html, /never written back into this page/i);
    assert.equal(/type="hidden" name="password"/.test(html), false, html);
  });

  it("escapes a password on its way into the hidden field", () => {
    const html = render({ password: '"><script>alert(1)</script>' });
    assert.equal(html.includes("<script>"), false);
  });

  it("escapes a host the lookup brought back rather than rendering it", () => {
    const html = render({
      values: values({ [MAILBOX_FIELDS.imapHost]: '"><script>alert(1)</script>' }),
      domain: "<b>example.com</b>",
    });
    assert.equal(html.includes("<script>"), false);
    assert.equal(html.includes("<b>example.com</b>"), false);
  });
});

describe("tier 2 — the provider list", () => {
  const render = (data: Partial<MailboxProviderPageData> = {}): string =>
    renderMailboxProviderStep({
      ...STEP_TWO_LINKS,
      providers: MAIL_PROVIDERS.map((p) => ({ id: p.id, label: p.label, note: p.note })),
      domain: "",
      email: "",
      selected: "",
      password: "",
      errors: {},
      ...data,
    });

  it("lists every provider in the table, plus a way out of it", () => {
    const html = render();
    for (const provider of MAIL_PROVIDERS) {
      assert.match(html, new RegExp(`value="${provider.id}"`), provider.id);
      assert.ok(html.includes(escapeHtml(provider.label)), provider.label);
    }
    assert.match(html, new RegExp(`value="${PROVIDER_OTHER}"`));
  });

  it("shows each provider's caveat next to the choice, not three screens later", () => {
    // The caveats are the point of the list. An operator who meets Fastmail's
    // refusal of the account password as a bare "authentication failed" will
    // conclude they typed their password wrong.
    const html = render();
    for (const provider of MAIL_PROVIDERS) {
      if (provider.note === "") continue;
      assert.ok(
        html.includes(escapeHtml(provider.note)),
        `${provider.id}'s caveat is not on the screen`
      );
    }
  });

  it("names the domain as a fact and never reports the lookup as an error", () => {
    // §7: no autoconfig failure is ever shown to the operator as an error. This
    // is the screen where that promise is kept or broken.
    const html = render({ domain: "example.com" });
    assert.match(html, /We could not detect settings for example\.com/);
    const body = visibleBody(html);
    assert.equal(/\bfailed\b|\berror\b|class="error"/i.test(body), false, body);
  });

  it("says nothing about a lookup when it was reached from the link", () => {
    const html = render();
    assert.equal(html.includes("could not detect"), false);
  });

  it("keeps the address and the choice across a rejected submission", () => {
    const html = render({
      email: "anna@example.com",
      selected: "posteo",
      errors: { [PROVIDER_FIELD]: "Choose a provider, or pick Other." },
    });
    assert.match(html, /value="anna@example\.com"/);
    assert.match(html, /value="posteo" checked/);
    assert.match(html, /Choose a provider, or pick Other\./);
  });

  it("carries a password the lookup was given, and shows none", () => {
    // Reached from a lookup that found nothing, this screen has the password
    // the address screen collected. It is on the way to the full form, so it
    // carries it there rather than letting tier 2 ask for it a second time.
    const html = render({ password: "hunter2" });
    assert.match(
      html,
      new RegExp(`<input type="hidden" name="${SHARED_PASSWORD_FIELD}" value="hunter2">`)
    );
    assert.equal(/type="password"/.test(html), false);
    assert.match(html, /carried/i);
  });

  it("has no password field at all when it was reached from its own link", () => {
    // The other way in is the "Choose provider manually" link, where nobody has
    // typed a password yet. There is nothing to carry and nothing to say.
    const html = render();
    assert.equal(/name="password"/.test(html), false);
    assert.equal(/carried/i.test(html), false);
  });

  it("can be skipped, like every other screen in step 2", () => {
    assert.match(render(), /value="skip"/);
  });
});
