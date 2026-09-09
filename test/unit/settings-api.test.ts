/**
 * The contract between the connector and the setup wizard, pinned from this
 * side of it.
 *
 * Two packages, one vocabulary. Before #69 the wizard read the connector's
 * answers back out of its rendered HTML with three regular expressions, and a
 * helper in the other package kept a verbatim copy of this package's markup so
 * those regular expressions had something real to run against — a "change one,
 * change both" rule that nothing enforced. `src/settings-api.ts` replaced it,
 * and `oauth/src/settings-api.ts` is its twin.
 *
 * What is asserted here:
 *
 *  1. **The two copies have not drifted.** Same shape as the secrets.ts drift
 *     test: everything below the header comment is compared byte for byte, so
 *     "identical" is a fact rather than a comment.
 *  2. **The flat form and the nested draft are inverses.** The connector's own
 *     `parseAccountForm` reads the flat names, the wire carries the document,
 *     and `flattenDraft`/`draftFromFields` are the only translation between
 *     them. A round trip that loses a field is exactly the failure #69 is
 *     about, told loudly instead of showing up as "Required." against a box the
 *     operator has filled in.
 *  3. **The rendered mailbox form names every field the vocabulary has.** The
 *     wizard's own form is pinned the same way in the OAuth package.
 *  4. **The readers fail closed.** Anything unrecognised reads as no result.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  CHECKBOX_ON,
  draftFromFields,
  flattenDraft,
  MAILBOX_FIELDS,
  MAILBOX_FIELD_NAMES,
  MAILBOX_SECRET_FIELDS,
  parseAutoconfigAnswer,
  parseMailboxDraft,
  parseProbeAnswer,
  type MailboxDraft,
  type MailboxSuggestion,
} from "../../src/settings-api.js";
import { renderMailboxForm } from "../../src/settings-pages.js";

function submittedForm(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    [MAILBOX_FIELDS.id]: "work",
    [MAILBOX_FIELDS.label]: "Work",
    [MAILBOX_FIELDS.isDefault]: CHECKBOX_ON,
    [MAILBOX_FIELDS.mailDefaultFrom]: "user@example.invalid",
    [MAILBOX_FIELDS.mailDefaultFromName]: "A User",
    [MAILBOX_FIELDS.mailDraftsFolder]: "Drafts",
    [MAILBOX_FIELDS.mailSentFolder]: "Sent",
    [MAILBOX_FIELDS.imapHost]: "imap.example.invalid",
    [MAILBOX_FIELDS.imapPort]: "993",
    [MAILBOX_FIELDS.imapUser]: "user@example.invalid",
    [MAILBOX_FIELDS.imapPass]: "imap-secret",
    [MAILBOX_FIELDS.imapTls]: CHECKBOX_ON,
    [MAILBOX_FIELDS.smtpHost]: "smtp.example.invalid",
    [MAILBOX_FIELDS.smtpPort]: "465",
    [MAILBOX_FIELDS.smtpUser]: "user@example.invalid",
    [MAILBOX_FIELDS.smtpPass]: "smtp-secret",
    [MAILBOX_FIELDS.smtpTls]: CHECKBOX_ON,
    [MAILBOX_FIELDS.caldavUrl]: "https://dav.example.invalid/",
    [MAILBOX_FIELDS.caldavUser]: "dav-user",
    [MAILBOX_FIELDS.caldavPass]: "dav-secret",
    ...overrides,
  };
}

describe("the two copies of settings-api.ts", () => {
  // The same drift check secrets.test.ts keeps over the two copies of
  // secrets.ts, for the same reason: the packages have separate Docker build
  // contexts and cannot import from one another, so a mirrored module is the
  // closest thing to a shared one — and a mirror nothing compares is a copy
  // waiting to rot. The header comment names the *other* package, so it differs
  // on purpose and is stripped before the comparison.
  it("stay identical below the header comment", () => {
    const body = (url: URL): string =>
      readFileSync(url, "utf8")
        // Line endings first: on a CRLF checkout the header ends `*/\r\n`, the
        // regex below does not match it, and the comparison then fails on the
        // one paragraph that is supposed to differ.
        .replace(/\r\n/g, "\n")
        .replace(/^\/\*\*[\s\S]*?\*\/\n/, "");

    assert.equal(
      body(new URL("../../src/settings-api.ts", import.meta.url)),
      body(new URL("../../oauth/src/settings-api.ts", import.meta.url)),
      "src/settings-api.ts and oauth/src/settings-api.ts have drifted — change one, change the other"
    );
  });
});

describe("the field vocabulary", () => {
  it("names every field the mailbox form renders a box for", () => {
    // The request half of #69. The form and the contract used to be two lists
    // of the same names kept in step by hand, and a rename in one of them was
    // silent: the field simply did not arrive, and the connector then reported
    // "Required." for a box the operator had filled in.
    const html = renderMailboxForm({
      csrf: "c",
      stamp: "s",
      account: null,
      // A CalDAV block only renders its removal checkbox for an account that
      // has one; the three CalDAV fields themselves are always there.
      values: {},
      errors: {},
    });

    for (const name of MAILBOX_FIELD_NAMES) {
      assert.ok(html.includes(`name="${name}"`), `the mailbox form has no box named ${name}`);
    }
  });

  it("has no duplicate wire names", () => {
    assert.equal(new Set(MAILBOX_FIELD_NAMES).size, MAILBOX_FIELD_NAMES.length);
  });

  it("marks every password as a secret", () => {
    assert.deepEqual([...MAILBOX_SECRET_FIELDS], ["imap.pass", "smtp.pass", "caldav.pass"]);
    for (const name of MAILBOX_SECRET_FIELDS) {
      assert.ok(MAILBOX_FIELD_NAMES.includes(name), name);
    }
  });
});

describe("flattenDraft and draftFromFields", () => {
  it("are inverses over a fully filled-in form", () => {
    const form = submittedForm();
    assert.deepEqual(flattenDraft(draftFromFields(form)), form);
  });

  it("flatten a draft onto every name the parser reads", () => {
    const flat = flattenDraft(draftFromFields(submittedForm()));
    for (const name of MAILBOX_FIELD_NAMES) {
      assert.ok(name in flat, `flattenDraft dropped ${name}`);
    }
  });

  it("keep the port as the operator typed it rather than deciding about it", () => {
    // A draft is a submission, not an account. Parsing "nine-nine-three" here
    // would make this module a second opinion on what a port is, and the
    // operator would get its guess instead of the connector's own message.
    const draft = draftFromFields(submittedForm({ [MAILBOX_FIELDS.imapPort]: "not-a-port" }));
    assert.equal(draft.imap.port, "not-a-port");
    assert.equal(flattenDraft(draft)[MAILBOX_FIELDS.imapPort], "not-a-port");
  });

  it("read an absent checkbox as off, the way a browser submits one", () => {
    const draft = draftFromFields({ [MAILBOX_FIELDS.imapHost]: "imap.example.invalid" });
    assert.equal(draft.imap.tls, false);
    assert.equal(draft.smtp.tls, false);
    assert.equal(draft.default, false);
    assert.equal(flattenDraft(draft)[MAILBOX_FIELDS.imapTls], "");
  });

  it("omit the CalDAV names entirely when nothing was typed into one", () => {
    const flat = flattenDraft(draftFromFields({ [MAILBOX_FIELDS.id]: "work" }));
    assert.equal(MAILBOX_FIELDS.caldavUrl in flat, false);
    assert.equal(MAILBOX_FIELDS.caldavUser in flat, false);
    assert.equal(MAILBOX_FIELDS.caldavPass in flat, false);
  });

  it("keep a half-filled CalDAV section rather than throwing it away", () => {
    const draft = draftFromFields({ [MAILBOX_FIELDS.caldavUser]: "dav-user" });
    assert.deepEqual(draft.caldav, { url: "", user: "dav-user", pass: "" });
  });
});

describe("parseMailboxDraft", () => {
  const draft = (): MailboxDraft => draftFromFields(submittedForm());

  it("accepts a draft and hands back exactly what was in it", () => {
    assert.deepEqual(parseMailboxDraft(JSON.parse(JSON.stringify(draft()))), draft());
  });

  it("treats an absent CalDAV block as no CalDAV block", () => {
    const { caldav: _caldav, ...withoutCaldav } = draft();
    assert.equal(parseMailboxDraft(withoutCaldav)?.caldav, null);
  });

  it("refuses anything that is not a draft, rather than filling in the gaps", () => {
    // Structural only, and fail closed: a body it cannot recognise is refused
    // as a body, not passed half-read to a parser that would then blame the
    // operator's fields for it.
    for (const value of [
      undefined,
      null,
      "a string",
      [],
      {},
      { ...draft(), id: 7 },
      { ...draft(), default: "1" },
      { ...draft(), imap: null },
      { ...draft(), imap: { ...draft().imap, tls: "1" } },
      { ...draft(), imap: { ...draft().imap, port: 993 } },
      { ...draft(), mail: {} },
      { ...draft(), caldav: { url: "https://dav.example.invalid/" } },
    ]) {
      assert.equal(parseMailboxDraft(value), null, JSON.stringify(value) ?? "undefined");
    }
  });
});

describe("parseProbeAnswer", () => {
  it("reads a report with all three services", () => {
    assert.deepEqual(
      parseProbeAnswer({
        probe: { imap: { ok: true }, smtp: { ok: false, message: "refused" }, caldav: { ok: true } },
      }),
      { imap: { ok: true }, smtp: { ok: false, message: "refused" }, caldav: { ok: true } }
    );
  });

  it("reads anything it does not recognise as no report at all", () => {
    for (const value of [undefined, {}, { probe: {} }, { probe: { imap: { ok: true } } }]) {
      assert.equal(parseProbeAnswer(value), null);
    }
  });
});

describe("parseAutoconfigAnswer", () => {
  const suggestion = (): MailboxSuggestion => ({
    email: "anna@example.invalid",
    domain: "example.invalid",
    source: "autoconfig-subdomain",
    imap: {
      host: "imap.example.invalid",
      port: 993,
      tls: true,
      socketType: "SSL",
      user: "anna@example.invalid",
    },
    smtp: {
      host: "smtp.example.invalid",
      port: 587,
      tls: false,
      socketType: "STARTTLS",
      user: "anna",
    },
    caldav: {
      url: "https://dav.example.invalid/",
      user: "anna@example.invalid",
      source: "well-known",
    },
  });

  it("reads a suggestion back exactly as it went over the wire", () => {
    const found = suggestion();
    assert.deepEqual(parseAutoconfigAnswer(JSON.parse(JSON.stringify({ suggestion: found }))), {
      suggestion: found,
    });
  });

  it("reads a null or absent suggestion as nothing found, which is not a failure", () => {
    // The ordinary answer for a domain that publishes nothing, and the shape
    // every refusal inside the cascade collapses into. It has to be readable,
    // or the wizard would treat "no autoconfig" as "unreadable connector".
    assert.deepEqual(parseAutoconfigAnswer({ suggestion: null }), { suggestion: null });
    assert.deepEqual(parseAutoconfigAnswer({}), { suggestion: null });
  });

  it("reads an absent CalDAV block as no CalDAV, the way most providers answer", () => {
    const { caldav: _caldav, ...withoutCaldav } = suggestion();
    assert.equal(parseAutoconfigAnswer({ suggestion: withoutCaldav })?.suggestion?.caldav, null);
    assert.equal(
      parseAutoconfigAnswer({ suggestion: { ...suggestion(), caldav: null } })?.suggestion?.caldav,
      null
    );
  });

  it("refuses a half-readable suggestion rather than showing half of one", () => {
    // Fail closed, and then some: an operator confirming settings has to be
    // confirming all of them. A suggestion whose SMTP host this build cannot
    // read is not shown with its IMAP half filled in — it reads as no
    // suggestion at all, and the screen after it is the provider list.
    for (const value of [
      undefined,
      null,
      "a string",
      [],
      { suggestion: "not an object" },
      { suggestion: { ...suggestion(), email: 7 } },
      { suggestion: { ...suggestion(), source: "a-tier-that-does-not-exist" } },
      { suggestion: { ...suggestion(), smtp: undefined } },
      { suggestion: { ...suggestion(), imap: { ...suggestion().imap, port: "993" } } },
      { suggestion: { ...suggestion(), imap: { ...suggestion().imap, port: 0 } } },
      { suggestion: { ...suggestion(), imap: { ...suggestion().imap, port: 70000 } } },
      { suggestion: { ...suggestion(), imap: { ...suggestion().imap, port: 993.5 } } },
      { suggestion: { ...suggestion(), imap: { ...suggestion().imap, tls: "1" } } },
      { suggestion: { ...suggestion(), imap: { ...suggestion().imap, socketType: "PLAIN" } } },
      { suggestion: { ...suggestion(), caldav: { url: "https://dav.example.invalid/" } } },
      { suggestion: { ...suggestion(), caldav: { ...suggestion().caldav, source: "a-guess" } } },
    ]) {
      assert.equal(parseAutoconfigAnswer(value), null, JSON.stringify(value) ?? "undefined");
    }
  });

  it("carries no password field anywhere, at any depth", () => {
    // The property the confirmation screen rests on. A suggestion cannot be
    // turned into a stored account without going back through a form the
    // operator has read, because the one thing an account needs is the one
    // thing this type does not have anywhere in it.
    const json = JSON.stringify(parseAutoconfigAnswer({ suggestion: suggestion() }));
    assert.equal(/pass/i.test(json), false, json);
  });
});
