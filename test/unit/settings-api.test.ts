/**
 * The contract between the connector and the setup wizard, pinned.
 *
 * Two packages, one vocabulary. Before #69 the wizard read the connector's
 * answers back out of its rendered HTML with three regular expressions, and a
 * helper in the other package kept a verbatim copy of this package's markup so
 * those regular expressions had something real to run against — a "change one,
 * change both" rule that nothing enforced. `settings-api.ts` replaced it. It was
 * then itself mirrored in both packages and pinned by a drift test, until #126
 * moved it to `shared/settings-api.ts` and both images began compiling the one
 * copy; the drift test went with the twin.
 *
 * What is asserted here:
 *
 *  1. **The flat form and the nested draft are inverses.** The connector's own
 *     `parseAccountForm` reads the flat names, the wire carries the document,
 *     and `flattenDraft`/`draftFromFields` are the only translation between
 *     them. A round trip that loses a field is exactly the failure #69 is
 *     about, told loudly instead of showing up as "Required." against a box the
 *     operator has filled in.
 *  2. **The rendered mailbox form names every field the vocabulary has.** The
 *     wizard's own form is pinned the same way in the OAuth package.
 *  3. **The readers fail closed.** Anything unrecognised reads as no result.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ADDRESS_FIELD,
  ADDRESS_REQUIRED,
  carrying,
  CHECKBOX_ON,
  draftFromFields,
  flattenDraft,
  MAILBOX_FIELDS,
  MAILBOX_FIELD_NAMES,
  MAILBOX_SECRET_FIELDS,
  parseAutoconfigAnswer,
  parseMailboxDraft,
  parseProbeAnswer,
  parseProvidersAnswer,
  PROVIDER_FIELD,
  PROVIDER_OTHER,
  PROVIDER_REQUIRED,
  SHARED_PASSWORD_FIELD,
  stepFromEdit,
  stepFromLookup,
  stepFromProvider,
  withSharedPassword,
  type MailboxDraft,
  type MailboxSuggestion,
  type ProviderPreset,
} from "../../shared/settings-api.js";
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

// ---- The provider list, over the wire --------------------------------------

describe("parseProvidersAnswer", () => {
  const preset = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: "posteo",
    label: "Posteo",
    note: "The server is posteo.de whatever your address ends in.",
    values: { [MAILBOX_FIELDS.imapHost]: "posteo.de", [MAILBOX_FIELDS.imapPort]: "993" },
    ...over,
  });

  it("reads a list back exactly as it went over the wire", () => {
    const answer = parseProvidersAnswer({ providers: [preset()] });
    assert.deepEqual(answer, {
      providers: [
        {
          id: "posteo",
          label: "Posteo",
          note: "The server is posteo.de whatever your address ends in.",
          values: { [MAILBOX_FIELDS.imapHost]: "posteo.de", [MAILBOX_FIELDS.imapPort]: "993" },
        },
      ],
    });
  });

  it("reads an empty list as an empty list, not as a failure", () => {
    assert.deepEqual(parseProvidersAnswer({ providers: [] }), { providers: [] });
  });

  it("refuses the whole answer rather than dropping one unreadable entry", () => {
    // A list with a provider silently missing from it is a list an operator
    // scrolls twice before concluding their provider is not supported. `null`
    // at least sends them somewhere they can finish.
    assert.equal(parseProvidersAnswer({ providers: [preset(), { id: "x" }] }), null);
    assert.equal(parseProvidersAnswer({ providers: [preset({ label: 7 })] }), null);
    assert.equal(parseProvidersAnswer({ providers: [preset({ values: "no" })] }), null);
  });

  it("reads anything that is not a list of presets as no answer at all", () => {
    for (const body of [null, undefined, 3, "providers", {}, { providers: {} }, []]) {
      assert.equal(parseProvidersAnswer(body), null, JSON.stringify(body ?? null));
    }
  });

  it("drops values under names this build does not have", () => {
    // The same rule parseErrorAnswer keeps: a connector on a different release
    // cannot put arbitrary keys into a form this one renders.
    const answer = parseProvidersAnswer({
      providers: [preset({ values: { [MAILBOX_FIELDS.imapHost]: "posteo.de", "imap.sasl": "x" } })],
    });
    assert.deepEqual(answer?.providers[0]?.values, { [MAILBOX_FIELDS.imapHost]: "posteo.de" });
  });
});

// ---- The cascade both entry points walk ------------------------------------
//
// #141: these screens existed only inside the setup wizard, which runs once.
// The connector's own *Add mailbox* page runs the same cascade now, and what
// follows is the branching both of them call — so a change to it is a change to
// both, and there is nowhere for the two to disagree.

const SUGGESTION: MailboxSuggestion = {
  email: "anna@example.com",
  domain: "example.com",
  source: "autoconfig-subdomain",
  imap: { host: "imap.example.com", port: 993, tls: true, socketType: "SSL", user: "anna" },
  smtp: { host: "smtp.example.com", port: 587, tls: false, socketType: "STARTTLS", user: "anna" },
  caldav: null,
};

const PRESETS: ProviderPreset[] = [
  {
    id: "posteo",
    label: "Posteo",
    note: "The server is posteo.de whatever your address ends in.",
    values: {
      [MAILBOX_FIELDS.mailDefaultFrom]: "anna@posteo.net",
      [MAILBOX_FIELDS.imapHost]: "posteo.de",
      [MAILBOX_FIELDS.imapPort]: "993",
      [MAILBOX_FIELDS.imapTls]: CHECKBOX_ON,
      [MAILBOX_FIELDS.smtpHost]: "posteo.de",
      [MAILBOX_FIELDS.smtpPort]: "465",
      [MAILBOX_FIELDS.smtpTls]: CHECKBOX_ON,
      [MAILBOX_FIELDS.caldavUrl]: "https://posteo.de:8443/calendars/anna/default",
    },
  },
];

describe("stepFromLookup — tier 1's Continue", () => {
  it("shows what was found, for confirmation, with the password beside it", () => {
    const step = stepFromLookup({
      email: "anna@example.com",
      password: "hunter2",
      found: SUGGESTION,
    });
    assert.equal(step.view, "suggestion");
    if (step.view !== "suggestion") return;
    assert.equal(step.domain, "example.com");
    assert.equal(step.sourceLabel, "Published by autoconfig.example.com.");
    assert.equal(step.values[MAILBOX_FIELDS.imapHost], "imap.example.com");
    assert.equal(step.values[MAILBOX_FIELDS.smtpPort], "587");
    // STARTTLS is `tls: false`, which is what the connector's own `imap.tls`
    // means — and what the confirmation screen renders as "STARTTLS".
    assert.equal(step.values[MAILBOX_FIELDS.smtpTls], "");
    assert.equal(step.password, "hunter2");
    // Never mixed into the values, which is what a screen renders its rows from.
    for (const secret of MAILBOX_SECRET_FIELDS) {
      assert.equal(secret in step.values, false, secret);
    }
  });

  it("takes the caller's defaults and lets the answer win over them", () => {
    // The one thing the two entry points disagree about: the wizard's mailbox
    // is `main` and is the default account; a second mailbox added from the
    // settings UI is neither.
    const step = stepFromLookup({
      email: "anna@example.com",
      password: "",
      found: SUGGESTION,
      defaults: { [MAILBOX_FIELDS.id]: "anna", [MAILBOX_FIELDS.imapHost]: "ignored" },
    });
    assert.equal(step.view, "suggestion");
    if (step.view !== "suggestion") return;
    assert.equal(step.values[MAILBOX_FIELDS.id], "anna");
    assert.equal(step.values[MAILBOX_FIELDS.imapHost], "imap.example.com");
  });

  it("sends a lookup that found nothing to the provider list, not to an error", () => {
    // §7: no autoconfig failure is ever shown to the operator as an error, and
    // "nothing published" and "the ISPDB returned 502" arrive here identically.
    const step = stepFromLookup({ email: "anna@example.com", password: "hunter2", found: null });
    assert.deepEqual(step, {
      view: "providers",
      email: "anna@example.com",
      domain: "example.com",
      selected: "",
      password: "hunter2",
      errors: {},
    });
  });

  it("keeps the address and the password when it cannot read the address", () => {
    // This one *is* an error, and it is not the lookup's: it is about what the
    // operator typed, on a submission that never became a lookup at all.
    for (const typed of ["anna", "@example.com", "anna@", ""]) {
      const step = stepFromLookup({ email: typed, password: "hunter2", found: null });
      assert.equal(step.view, "address", typed);
      if (step.view !== "address") continue;
      assert.equal(step.errors[ADDRESS_FIELD], ADDRESS_REQUIRED);
      assert.equal(step.email, typed);
      assert.equal(step.password, "hunter2");
    }
  });

  it("trims the address before deciding anything about it", () => {
    const step = stepFromLookup({ email: "  anna@example.com  ", password: "", found: null });
    assert.equal(step.view, "providers");
    if (step.view !== "providers") return;
    assert.equal(step.email, "anna@example.com");
  });
});

describe("stepFromProvider — tier 2's Continue", () => {
  it("fills the full form in from the preset rather than saving behind anyone", () => {
    const step = stepFromProvider({
      email: "anna@posteo.net",
      password: "hunter2",
      chosen: "posteo",
      presets: PRESETS,
      defaults: { [MAILBOX_FIELDS.id]: "anna" },
    });
    assert.equal(step.view, "manual");
    if (step.view !== "manual") return;
    assert.equal(step.preset?.id, "posteo");
    assert.equal(step.values[MAILBOX_FIELDS.id], "anna");
    assert.equal(step.values[MAILBOX_FIELDS.imapHost], "posteo.de");
    // #120: the password the operator typed a screen ago, in the boxes that are
    // about to send it — and in CalDAV's too, because this preset names a
    // CalDAV server. A block that were nothing but a password would be a probe
    // against a server nobody named.
    assert.equal(step.values[MAILBOX_FIELDS.imapPass], "hunter2");
    assert.equal(step.values[MAILBOX_FIELDS.smtpPass], "hunter2");
    assert.equal(step.values[MAILBOX_FIELDS.caldavPass], "hunter2");
  });

  it("carries nothing into a CalDAV block the preset did not name", () => {
    const step = stepFromProvider({
      email: "anna@example.com",
      password: "hunter2",
      chosen: PROVIDER_OTHER,
      presets: PRESETS,
    });
    assert.equal(step.view, "manual");
    if (step.view !== "manual") return;
    assert.equal(step.preset, null);
    assert.equal(step.values[MAILBOX_FIELDS.caldavPass], undefined);
    // TLS is stated rather than left out: an absent checkbox is how a browser
    // submits an unticked one, and a form reading these as a submission would
    // otherwise render TLS off — a default nobody chose.
    assert.equal(step.values[MAILBOX_FIELDS.imapTls], CHECKBOX_ON);
    assert.equal(step.values[MAILBOX_FIELDS.smtpTls], CHECKBOX_ON);
    assert.equal(step.values[MAILBOX_FIELDS.mailDefaultFrom], "anna@example.com");
  });

  it("asks again rather than crashing on a preset it does not have", () => {
    const step = stepFromProvider({
      email: "anna@example.com",
      password: "hunter2",
      chosen: "a-provider-from-another-release",
      presets: PRESETS,
    });
    assert.equal(step.view, "providers");
    if (step.view !== "providers") return;
    assert.equal(step.errors[PROVIDER_FIELD], PROVIDER_REQUIRED);
    assert.equal(step.selected, "");
    assert.equal(step.password, "hunter2");
  });

  it("keeps the choice on screen when it is the address that is wrong", () => {
    const step = stepFromProvider({
      email: "anna",
      password: "hunter2",
      chosen: "posteo",
      presets: PRESETS,
    });
    assert.equal(step.view, "providers");
    if (step.view !== "providers") return;
    assert.equal(step.errors[ADDRESS_FIELD], ADDRESS_REQUIRED);
    assert.equal(step.selected, "posteo", "the radio the operator picked stays picked");
  });
});

describe("stepFromEdit — the confirmation screen's Edit these", () => {
  it("puts the settings in the form and no stored password anywhere near it", () => {
    const step = stepFromEdit({
      fields: submittedForm({ [MAILBOX_FIELDS.imapPass]: "typed-into-the-body" }),
      password: "hunter2",
    });
    assert.equal(step.view, "manual");
    if (step.view !== "manual") return;
    assert.equal(step.values[MAILBOX_FIELDS.imapHost], "imap.example.invalid");
    // Through a draft rather than by echoing the body back: `formValues` strips
    // every secret, and `carrying` then puts back only the one the operator
    // typed on this submission.
    assert.equal(step.values[MAILBOX_FIELDS.imapPass], "hunter2");
    assert.equal(step.values[MAILBOX_FIELDS.smtpPass], "hunter2");
    assert.equal(step.email, "user@example.invalid");
  });

  it("leaves the boxes empty when there is no password to carry", () => {
    // Absent rather than empty: `formValues` deletes the secret names outright,
    // so there is not even a key for a later edit to accidentally fill in from
    // something stored.
    const step = stepFromEdit({ fields: submittedForm(), password: "" });
    assert.equal(step.view, "manual");
    if (step.view !== "manual") return;
    for (const secret of MAILBOX_SECRET_FIELDS) {
      assert.equal(secret in step.values, false, secret);
    }
  });
});

describe("withSharedPassword — one box, three services", () => {
  it("spreads the one password across the services the submission names", () => {
    const filled = withSharedPassword({
      [SHARED_PASSWORD_FIELD]: "hunter2",
      [MAILBOX_FIELDS.caldavUrl]: "https://dav.example.com/",
    });
    assert.equal(filled[MAILBOX_FIELDS.imapPass], "hunter2");
    assert.equal(filled[MAILBOX_FIELDS.smtpPass], "hunter2");
    assert.equal(filled[MAILBOX_FIELDS.caldavPass], "hunter2");
  });

  it("does not invent a CalDAV password for a server that was never named", () => {
    const filled = withSharedPassword({ [SHARED_PASSWORD_FIELD]: "hunter2" });
    assert.equal(MAILBOX_FIELDS.caldavPass in filled, false);
  });

  it("lets a per-service password already in the body win", () => {
    const filled = withSharedPassword({
      [SHARED_PASSWORD_FIELD]: "hunter2",
      [MAILBOX_FIELDS.imapPass]: "different-for-imap",
    });
    assert.equal(filled[MAILBOX_FIELDS.imapPass], "different-for-imap");
    assert.equal(filled[MAILBOX_FIELDS.smtpPass], "hunter2");
  });

  it("is inert for the full form, which sends no such field", () => {
    // The full form is where a mailbox with two different passwords is
    // expressed, and it must not have one of them quietly overwritten.
    const body = submittedForm();
    assert.deepEqual(withSharedPassword(body), body);
  });
});

describe("carrying — the same rule, running the other way", () => {
  it("spreads the one password across the services the values name", () => {
    const filled = carrying(
      { [MAILBOX_FIELDS.caldavUrl]: "https://dav.example.invalid/" },
      "hunter2"
    );
    assert.equal(filled[MAILBOX_FIELDS.imapPass], "hunter2");
    assert.equal(filled[MAILBOX_FIELDS.smtpPass], "hunter2");
    assert.equal(filled[MAILBOX_FIELDS.caldavPass], "hunter2");
  });

  it("does not invent a CalDAV password for a server that was never named", () => {
    const filled = carrying({}, "hunter2");
    assert.equal(MAILBOX_FIELDS.caldavPass in filled, false);
  });

  it("leaves the values alone when there is no password to carry", () => {
    const values = { [MAILBOX_FIELDS.caldavUrl]: "https://dav.example.invalid/" };
    assert.deepEqual(carrying(values, ""), values);
  });

  it("lets a per-service password already in the values win", () => {
    const filled = carrying({ [MAILBOX_FIELDS.imapPass]: "different-for-imap" }, "hunter2");
    assert.equal(filled[MAILBOX_FIELDS.imapPass], "different-for-imap");
    assert.equal(filled[MAILBOX_FIELDS.smtpPass], "hunter2");
  });
});

/**
 * The clause the collapse into one rule could silently lose.
 *
 * `draftFromFields` builds a CalDAV block as soon as any one of its three fields
 * is non-empty, so a `caldavPass` with no `caldavUrl` beside it is a probe
 * against a server that was never named. Both directions of the rule owe this,
 * and the reason it survived being written twice is that nothing failed when one
 * copy drifted. It fails here now.
 */
describe("the CalDAV clause — a password only where a server was named", () => {
  const NAMED = "https://dav.example.invalid/";

  it("spreads no caldavPass when caldavUrl is absent — parsing", () => {
    const filled = withSharedPassword({ [SHARED_PASSWORD_FIELD]: "hunter2" });
    assert.equal(MAILBOX_FIELDS.caldavPass in filled, false);
    assert.equal(filled[MAILBOX_FIELDS.imapPass], "hunter2", "IMAP still gets it");
  });

  it("spreads no caldavPass when caldavUrl is empty — rendering", () => {
    const filled = carrying({ [MAILBOX_FIELDS.caldavUrl]: "" }, "hunter2");
    assert.equal(filled[MAILBOX_FIELDS.caldavPass] ?? "", "");
    assert.equal(filled[MAILBOX_FIELDS.imapPass], "hunter2", "IMAP still gets it");
  });

  it("spreads no caldavPass when caldavUrl is a non-string — parsing", () => {
    // A repeated field arrives as an array. It is not a URL, so it names no
    // server, and the shared password must not follow it.
    const filled = withSharedPassword({
      [SHARED_PASSWORD_FIELD]: "hunter2",
      [MAILBOX_FIELDS.caldavUrl]: ["a", "b"],
    });
    assert.equal(MAILBOX_FIELDS.caldavPass in filled, false);
  });

  it("does spread caldavPass when a server was named — both directions agree", () => {
    const parsed = withSharedPassword({
      [SHARED_PASSWORD_FIELD]: "hunter2",
      [MAILBOX_FIELDS.caldavUrl]: NAMED,
    });
    const rendered = carrying({ [MAILBOX_FIELDS.caldavUrl]: NAMED }, "hunter2");
    assert.equal(parsed[MAILBOX_FIELDS.caldavPass], "hunter2");
    assert.equal(rendered[MAILBOX_FIELDS.caldavPass], "hunter2");
  });

  it("never overwrites a CalDAV password the operator already gave", () => {
    const parsed = withSharedPassword({
      [SHARED_PASSWORD_FIELD]: "hunter2",
      [MAILBOX_FIELDS.caldavUrl]: NAMED,
      [MAILBOX_FIELDS.caldavPass]: "its-own",
    });
    const rendered = carrying(
      { [MAILBOX_FIELDS.caldavUrl]: NAMED, [MAILBOX_FIELDS.caldavPass]: "its-own" },
      "hunter2"
    );
    assert.equal(parsed[MAILBOX_FIELDS.caldavPass], "its-own");
    assert.equal(rendered[MAILBOX_FIELDS.caldavPass], "its-own");
  });
});
