import { describe, it, test } from "node:test";
import assert from "node:assert/strict";
import { reservedIdNotice, type Account } from "../../src/accounts.js";
import {
  escapeHtml,
  renderMailboxAddress,
  renderMailboxForm,
  renderMailboxList,
  renderMailboxProviders,
  renderMailboxSuggestion,
  type MailboxProvidersData,
  type MailboxSuggestionData,
} from "../../src/settings-pages.js";
import { MAILBOX_FIELDS, type ProviderPreset } from "../../shared/settings-api.js";

function sampleAccount(id: string): Account {
  return {
    id,
    label: id === "work" ? "Work" : id,
    imap: {
      host: "imap.example.invalid",
      port: 993,
      user: "user@example.invalid",
      pass: "test-imap-secret",
      tls: true,
    },
    smtp: {
      host: "smtp.example.invalid",
      port: 465,
      user: "user@example.invalid",
      pass: "test-smtp-secret",
      tls: true,
    },
    mail: {
      defaultFrom: "user@example.invalid",
      draftsFolder: "Drafts",
      sentFolder: "Sent",
    },
  };
}

test("no stored password reaches the rendered form", () => {
  const account = {
    ...sampleAccount("work"),
    imap: { ...sampleAccount("work").imap, pass: "imap-plaintext-secret" },
    smtp: { ...sampleAccount("work").smtp, pass: "smtp-plaintext-secret" },
    caldav: { url: "https://dav.example.com", user: "u", pass: "caldav-plaintext-secret" },
  };
  const html = renderMailboxForm({ csrf: "c", stamp: "1-2", account });
  for (const secret of [
    "imap-plaintext-secret",
    "smtp-plaintext-secret",
    "caldav-plaintext-secret",
  ]) {
    assert.ok(!html.includes(secret), `${secret} must not appear anywhere in the page`);
  }
});

test("password inputs render empty and say what empty means", () => {
  const html = renderMailboxForm({ csrf: "c", stamp: "1-2", account: sampleAccount("work") });
  const inputs = html.match(/<input[^>]*type="password"[^>]*>/g) ?? [];
  assert.ok(inputs.length >= 2);
  for (const input of inputs) {
    assert.match(input, /value=""/);
    assert.match(input, /placeholder="unchanged"/);
    assert.match(input, /autocomplete="new-password"/);
  }
});

test("a rejected password field renders its error next to the input", () => {
  // parseAccountForm keys password failures by field name (imap.pass,
  // smtp.pass, caldav.pass). Without a field-error slot on the password
  // input the operator gets a 400 and no indication which of eighteen
  // fields is at fault. See issue #83.
  const html = renderMailboxForm({
    csrf: "c",
    stamp: "1-2",
    account: null,
    errors: {
      "imap.pass": "Required.",
      "smtp.pass": "Required.",
      "caldav.pass": "Required.",
    },
  });
  for (const name of ["imap.pass", "smtp.pass", "caldav.pass"]) {
    const at = html.indexOf(`name="${name}"`);
    assert.notEqual(at, -1, `${name} must be on the form`);
    const afterInput = html.slice(html.indexOf(">", at) + 1).trimStart();
    assert.ok(
      afterInput.startsWith('<p class="field-error">Required.</p>'),
      `${name} must render its error right after the input, got: ${afterInput.slice(0, 80)}`
    );
  }
});

test("the list page never renders a password either", () => {
  const html = renderMailboxList({
    csrf: "c",
    stamp: "1-2",
    accounts: [{ ...sampleAccount("work"), imap: { ...sampleAccount("work").imap, pass: "listed-secret" } }],
  });
  assert.ok(!html.includes("listed-secret"));
});

test("the stamp travels in every form so a concurrent edit is caught", () => {
  const html = renderMailboxForm({ csrf: "c", stamp: "42-99", account: null });
  assert.match(html, /name="_stamp" value="42-99"/);
});

test("removing CalDAV is its own checkbox, not an emptied field", () => {
  const html = renderMailboxForm({
    csrf: "c",
    stamp: "1-2",
    account: { ...sampleAccount("work"), caldav: { url: "https://dav", user: "u", pass: "p" } },
  });
  assert.match(html, /type="checkbox"[^>]*name="remove_caldav"/);
});

test("labels and errors are escaped", () => {
  const html = renderMailboxForm({
    csrf: "c",
    stamp: "1-2",
    account: { ...sampleAccount("work"), label: "<script>alert(1)</script>" },
    errors: { "imap.host": "<b>bad</b>" },
  });
  assert.ok(!html.includes("<script>alert(1)</script>"));
  assert.ok(!html.includes("<b>bad</b>"));
  assert.match(html, /&lt;script&gt;/);
});

test("a probe report renders per service and does not save anything", () => {
  const html = renderMailboxForm({
    csrf: "c",
    stamp: "1-2",
    account: sampleAccount("work"),
    probe: { imap: { ok: true }, smtp: { ok: false, message: "auth failed" }, caldav: null },
  });
  assert.match(html, /IMAP[\s\S]*?(ok|success)/i);
  assert.match(html, /auth failed/);
  assert.match(html, /not saved/i);
});

test("no page carries a script tag or an inline handler", () => {
  for (const html of [
    renderMailboxList({ csrf: "c", stamp: "1-2", accounts: [sampleAccount("work")] }),
    renderMailboxForm({ csrf: "c", stamp: "1-2", account: null }),
  ]) {
    assert.ok(!/<script/i.test(html));
    assert.ok(!/\son[a-z]+\s*=/i.test(html));
  }
});

test("escapeHtml escapes the five special characters", () => {
  assert.equal(
    escapeHtml(`<b>"it's" & more</b>`),
    "&lt;b&gt;&quot;it&#39;s&quot; &amp; more&lt;/b&gt;"
  );
});

test("no javascript: URL appears in any page", () => {
  for (const html of [
    renderMailboxList({ csrf: "c", stamp: "1-2", accounts: [sampleAccount("work")] }),
    renderMailboxForm({ csrf: "c", stamp: "1-2", account: null }),
  ]) {
    assert.ok(!/javascript:/i.test(html));
  }
});

test("a row notice renders against its own row and leaves the others alone", () => {
  const html = renderMailboxList({
    csrf: "c",
    stamp: "1-2",
    accounts: [sampleAccount("work"), sampleAccount("test")],
    rowNotices: { test: "Saving this mailbox never persists." },
  });
  assert.match(html, /Saving this mailbox never persists\./);
  // One notice for one affected account, not one per row.
  assert.equal((html.match(/class="row-notice"/g) ?? []).length, 1);
});

test("a row notice is escaped like every other value", () => {
  const html = renderMailboxList({
    csrf: "c",
    stamp: "1-2",
    accounts: [sampleAccount("test")],
    rowNotices: { test: "<script>alert(1)</script>" },
  });
  assert.ok(!html.includes("<script>alert(1)</script>"));
  assert.match(html, /&lt;script&gt;/);
});

test("no row notice renders when none applies", () => {
  const html = renderMailboxList({ csrf: "c", stamp: "1-2", accounts: [sampleAccount("work")] });
  // Not a bare "row-notice" search: the stylesheet names the class either way.
  assert.ok(!html.includes(`class="row-notice"`));
});

/**
 * Fix round 2 (#45): #11 gave the mailbox list a per-row notice for an account
 * stuck on a reserved id, but the edit form one page deeper still carried the
 * probe panel's "Press Save to store them." — false in both halves for such an
 * account, and the opposite of what the row notice had just told the operator.
 * The form now repeats that notice verbatim (reservedIdNotice(), the same string
 * the list row and the startup warning use, so the two pages cannot drift apart)
 * and the probe panel stops promising a Save that cannot persist.
 */
describe("the edit form for a mailbox stuck on a reserved id", () => {
  test("repeats the row notice's remedy instead of promising Save will store the values", () => {
    const html = renderMailboxForm({
      csrf: "c",
      stamp: "1-2",
      account: sampleAccount("test"),
      probe: { imap: { ok: true }, smtp: { ok: true }, caldav: null },
    });
    assert.ok(
      !/Press Save to store them/.test(html),
      "the form must not claim Save will persist an account it cannot save"
    );
    assert.ok(
      html.includes(escapeHtml(reservedIdNotice("test"))),
      "the row notice's wording is repeated verbatim"
    );
    assert.match(html, /recreate it under a different id/, "and names the way out");
  });

  test("says so even before anything has been probed", () => {
    const html = renderMailboxForm({ csrf: "c", stamp: "1-2", account: sampleAccount("test") });
    assert.ok(html.includes(escapeHtml(reservedIdNotice("test"))));
  });

  test("an unaffected mailbox keeps the ordinary probe copy and gains no notice", () => {
    const html = renderMailboxForm({
      csrf: "c",
      stamp: "1-2",
      account: sampleAccount("work"),
      probe: { imap: { ok: true }, smtp: { ok: true }, caldav: null },
    });
    assert.match(html, /Press Save to store them/);
    assert.ok(!/reserved id/.test(html));
  });

  test("the create form is untouched — its Save really does persist", () => {
    const html = renderMailboxForm({
      csrf: "c",
      stamp: "1-2",
      account: null,
      probe: { imap: { ok: true }, smtp: { ok: true }, caldav: null },
    });
    assert.match(html, /Press Save to store them/);
    assert.ok(!/reserved id/.test(html));
  });
});

// ---- Add mailbox, address first (#141) -------------------------------------
//
// The guided path used to exist only inside the setup wizard, which runs once —
// for the mailbox the operator is most likely to know the settings for. These
// are the same four screens in the settings UI's chrome, where every mailbox
// after the first is added.

const PRESETS: ProviderPreset[] = [
  {
    id: "mailbox-org",
    label: "mailbox.org",
    note: "Log in with your main address, not an alias.",
    values: { [MAILBOX_FIELDS.imapHost]: "imap.mailbox.org" },
  },
  { id: "iredmail", label: "iRedMail (self-hosted)", note: "", values: {} },
];

/** The values a lookup for example.com would have produced. */
function suggested(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    [MAILBOX_FIELDS.id]: "anna",
    [MAILBOX_FIELDS.label]: "anna@example.com",
    [MAILBOX_FIELDS.mailDefaultFrom]: "anna@example.com",
    [MAILBOX_FIELDS.imapHost]: "imap.example.com",
    [MAILBOX_FIELDS.imapPort]: "993",
    [MAILBOX_FIELDS.imapUser]: "anna@example.com",
    [MAILBOX_FIELDS.imapTls]: "1",
    [MAILBOX_FIELDS.smtpHost]: "smtp.example.com",
    [MAILBOX_FIELDS.smtpPort]: "587",
    [MAILBOX_FIELDS.smtpUser]: "anna@example.com",
    [MAILBOX_FIELDS.smtpTls]: "",
    ...overrides,
  };
}

describe("tier 1 — the address screen", () => {
  it("asks for an address and a password, and for nothing else", () => {
    const html = renderMailboxAddress({ csrf: "c", email: "" });
    assert.match(html, new RegExp(`name="${MAILBOX_FIELDS.mailDefaultFrom}"`));
    assert.match(html, /name="password"[^>]*type="password"/);
    // The point of the screen is that it is not the eighteen-box form.
    for (const name of [MAILBOX_FIELDS.imapHost, MAILBOX_FIELDS.smtpHost, MAILBOX_FIELDS.caldavUrl]) {
      assert.equal(html.includes(`name="${name}"`), false, name);
    }
  });

  it("carries the CSRF token, because it posts back to a guarded route", () => {
    assert.match(
      renderMailboxAddress({ csrf: "the-csrf-value", email: "" }),
      /name="_csrf" value="the-csrf-value"/
    );
  });

  it("offers both other tiers, so the form is never a one-way door", () => {
    const html = renderMailboxAddress({ csrf: "c", email: "" });
    assert.match(html, /href="\/settings\/mailboxes\/new\?view=providers"/);
    assert.match(html, /href="\/settings\/mailboxes\/new\?view=manual"/);
  });

  it("keeps the address and reports what is wrong with it", () => {
    const html = renderMailboxAddress({
      csrf: "c",
      email: "anna",
      errors: { [MAILBOX_FIELDS.mailDefaultFrom]: "Enter a full email address, like anna@example.com." },
    });
    assert.match(html, /value="anna"/);
    assert.match(html, /Enter a full email address/);
  });

  it("never writes a password back into itself", () => {
    const html = renderMailboxAddress({ csrf: "c", email: "anna@example.com" });
    const box = /<input[^>]*name="password"[^>]*>/.exec(html)?.[0] ?? "";
    assert.match(box, /value=""/);
  });
});

describe("tier 1's answer — the confirmation screen", () => {
  const render = (data: Partial<MailboxSuggestionData> = {}): string =>
    renderMailboxSuggestion({
      csrf: "c",
      stamp: "1-2",
      domain: "example.com",
      sourceLabel: "Published by autoconfig.example.com.",
      values: suggested(),
      password: "hunter2",
      ...data,
    });

  it("shows what was found before any of it is used", () => {
    const html = render();
    assert.match(html, /Found settings for example\.com/);
    assert.match(html, /imap\.example\.com:993/);
    assert.match(html, /smtp\.example\.com:587/);
    // `tls: false` is STARTTLS, and saying so is the difference between an
    // operator who can check it against their provider's page and one who
    // cannot.
    assert.match(html, /STARTTLS/);
    assert.match(html, /Published by autoconfig\.example\.com\./);
  });

  it("says nothing has been stored, because nothing has", () => {
    assert.match(render(), /nothing has been stored/i);
  });

  it("submits every derived value, and each of them exactly once", () => {
    // The rows and the hidden inputs are rendered from one `values`, so the
    // screen cannot show one host and submit another. The two the operator is
    // given boxes for are not also hidden: `draftFromFields` reads a repeated
    // field as absent, which would silently drop them.
    const html = render();
    for (const [name, value] of Object.entries(suggested())) {
      const occurrences = html.split(`name="${name}"`).length - 1;
      assert.equal(occurrences, 1, `${name} appears ${occurrences} times`);
      if (value !== "") assert.ok(html.includes(`value="${escapeHtml(value)}"`), name);
    }
  });

  it("gives the derived id and name boxes rather than applying them", () => {
    // The wizard's first mailbox is `main` and has nothing to collide with. A
    // second one needs an id of its own, and one derived from the address is a
    // suggestion the operator can correct here — not a rejection they meet
    // after pressing Save.
    const html = render();
    assert.match(html, new RegExp(`<input[^>]*name="${MAILBOX_FIELDS.id}"[^>]*value="anna"`));
    assert.match(html, new RegExp(`name="${MAILBOX_FIELDS.label}"[^>]*value="anna@example.com"`));
  });

  it("carries the password rather than asking for it twice, and says so", () => {
    const html = render({ password: "hunter2" });
    assert.match(html, /<input type="hidden" name="password" value="hunter2">/);
    assert.equal(/type="password"/.test(html), false, "there is nothing to type");
    assert.match(html, /carried/i);
  });

  it("asks for the password when the submission arrived without one", () => {
    // `required` on the address screen is the browser's promise, not this
    // module's, and a POST that skipped it still has to be finishable.
    const html = render({ password: "" });
    assert.match(html, /name="password"[^>]*type="password"/);
    assert.equal(/type="hidden" name="password"/.test(html), false);
  });

  it("calls a missing CalDAV endpoint ordinary, because it is", () => {
    const html = render();
    assert.match(html, /not found — calendars can be added later/);
    assert.equal(/\bfailed\b|class="error"/i.test(html), false);
  });

  it("escapes everything the lookup brought back", () => {
    const html = render({
      values: suggested({ [MAILBOX_FIELDS.imapHost]: '"><script>alert(1)</script>' }),
      domain: "<b>example.com</b>",
      password: '"><script>alert(2)</script>',
    });
    assert.equal(html.includes("<script>"), false);
    assert.equal(html.includes("<b>example.com</b>"), false);
  });
});

describe("tier 2 — the provider list", () => {
  const render = (data: Partial<MailboxProvidersData> = {}): string =>
    renderMailboxProviders({
      csrf: "c",
      providers: PRESETS,
      domain: "",
      email: "",
      selected: "",
      password: "",
      ...data,
    });

  it("lists every provider the connector sent, plus a way out of the list", () => {
    const html = render();
    for (const preset of PRESETS) {
      assert.match(html, new RegExp(`value="${preset.id}"`), preset.id);
      assert.ok(html.includes(escapeHtml(preset.label)), preset.label);
    }
    assert.match(html, /value="other"/);
  });

  it("shows each caveat next to the choice, not two screens later", () => {
    // An operator who meets "the login is not your address" as a bare
    // authentication failure will conclude they typed their password wrong.
    assert.ok(render().includes(escapeHtml("Log in with your main address, not an alias.")));
  });

  it("names the domain as a fact and never reports the lookup as an error", () => {
    const html = render({ domain: "example.com" });
    assert.match(html, /We could not detect settings for example\.com/);
    assert.equal(/\bfailed\b|class="error"/i.test(html), false, html);
  });

  it("says nothing about a lookup when it was reached from the link", () => {
    assert.equal(render().includes("could not detect"), false);
  });

  it("keeps the address and the choice across a rejected submission", () => {
    const html = render({
      email: "anna@example.com",
      selected: "mailbox-org",
      errors: { provider: "Choose a provider, or pick Other." },
    });
    assert.match(html, /value="anna@example\.com"/);
    assert.match(html, /value="mailbox-org" checked/);
    assert.match(html, /Choose a provider, or pick Other\./);
  });

  it("carries a password the lookup was given, and shows no box for it", () => {
    const html = render({ password: "hunter2" });
    assert.match(html, /<input type="hidden" name="password" value="hunter2">/);
    assert.equal(/type="password"/.test(html), false);
  });

  it("has no password field at all when reached from its own link", () => {
    const html = render();
    assert.equal(/name="password"/.test(html), false);
    assert.equal(/carried/i.test(html), false);
  });
});

describe("the full form, as the cascade's last screen", () => {
  it("carries the one password into the boxes that will send it", () => {
    // #120: the operator typed it on the address screen, and a form they are
    // being sent to must not open by asking for something they have given it.
    const html = renderMailboxForm({
      csrf: "c",
      stamp: "1-2",
      account: null,
      values: {
        [MAILBOX_FIELDS.imapPass]: "hunter2",
        [MAILBOX_FIELDS.smtpPass]: "hunter2",
      },
    });
    const boxes = html.match(/<input[^>]*type="password"[^>]*>/g) ?? [];
    const filled = boxes.filter((box) => box.includes('value="hunter2"'));
    assert.equal(filled.length, 2, "IMAP and SMTP, and not the CalDAV box");
    // The caption that goes with an empty box would be a caption contradicting
    // the box it sits under.
    for (const box of filled) assert.equal(box.includes("placeholder"), false, box);
    assert.match(html, /carried over rather than asked for again/);
  });

  it("still says passwords are blank when they are", () => {
    const html = renderMailboxForm({ csrf: "c", stamp: "1-2", account: null });
    assert.match(html, /Password fields are always blank here/);
  });

  it("offers the two guided ways in, but only when adding a mailbox", () => {
    const adding = renderMailboxForm({ csrf: "c", stamp: "1-2", account: null });
    assert.match(adding, /href="\/settings\/mailboxes\/new"/);
    assert.match(adding, /href="\/settings\/mailboxes\/new\?view=providers"/);
    // Editing a stored mailbox is not a cascade and has no address to look up.
    const editing = renderMailboxForm({ csrf: "c", stamp: "1-2", account: sampleAccount("work") });
    assert.equal(editing.includes("Look it up from the address"), false);
  });
});

// ---- What Enter does, on every Add mailbox screen --------------------------
//
// #140, on the screens #141 adds. A browser asked to submit a form implicitly —
// Enter in a text field — behaves as if the form's *first* submit button had
// been pressed, and only that button's name/value pair is sent. So "the screen
// has a Save button" says nothing whatever about what Enter does. The property
// is a position, so the assertions below are about a position.

interface SubmitButton {
  action: string;
  label: string;
  novalidate: boolean;
}

/** The bodies of every `<form>` on a page, in document order. */
function formBodies(html: string): string[] {
  return [...html.matchAll(/<form\b[^>]*>([\s\S]*?)<\/form>/g)].map((match) => match[1] ?? "");
}

/** A form's submit buttons, in DOM order — the order that decides Enter. */
function submitButtons(formBody: string): SubmitButton[] {
  const found: SubmitButton[] = [];
  for (const match of formBody.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)) {
    const attributes = match[1] ?? "";
    // A `<button>` with no `type` is a submit button.
    const type = /\btype="([^"]*)"/.exec(attributes)?.[1] ?? "submit";
    if (type !== "submit") continue;
    found.push({
      action: /\bname="_action"[^>]*?\bvalue="([^"]*)"/.exec(attributes)?.[1] ?? "",
      label: (match[2] ?? "").replace(/\s+/g, " ").trim(),
      novalidate: /\bformnovalidate\b/.test(attributes),
    });
  }
  return found;
}

const ADD_MAILBOX_SCREENS: Array<{
  screen: string;
  html: string;
  primary: { action: string; label: string };
}> = [
  {
    screen: "the address screen",
    html: renderMailboxAddress({ csrf: "c", email: "" }),
    primary: { action: "lookup", label: "Continue" },
  },
  {
    screen: "the confirmation screen",
    html: renderMailboxSuggestion({
      csrf: "c",
      stamp: "1-2",
      domain: "example.com",
      sourceLabel: "Published by autoconfig.example.com.",
      values: suggested(),
      password: "hunter2",
    }),
    primary: { action: "save", label: "Save mailbox" },
  },
  {
    screen: "the provider list",
    html: renderMailboxProviders({
      csrf: "c",
      providers: PRESETS,
      domain: "",
      email: "",
      selected: "",
      password: "",
    }),
    primary: { action: "provider", label: "Continue" },
  },
  {
    screen: "the full form",
    html: renderMailboxForm({ csrf: "c", stamp: "1-2", account: null }),
    primary: { action: "save", label: "Save" },
  },
];

describe("what pressing Enter in an Add mailbox field does", () => {
  for (const { screen, html, primary } of ADD_MAILBOX_SCREENS) {
    it(`presses ${primary.label} on ${screen}, because it is first`, () => {
      const bodies = formBodies(html);
      assert.equal(bodies.length, 1, `${screen} has ${bodies.length} forms, not one`);

      const buttons = submitButtons(bodies[0] ?? "");
      assert.ok(buttons.length > 0, `${screen} has no submit button at all`);

      // Not `buttons.some(...)`: presence is what the wizard's address screen
      // already had while Enter was throwing the operator's mailbox away.
      assert.deepEqual(
        { action: buttons[0]?.action, label: buttons[0]?.label },
        primary,
        `${screen} submits implicitly as ${buttons[0]?.label ?? "nothing"}`
      );
    });
  }

  it("never lets Enter walk past a required box on the way", () => {
    // The other half of #140: the button that broke it also carried
    // `formnovalidate`, so the empty `required` boxes did not stop it either.
    for (const { screen, html } of ADD_MAILBOX_SCREENS) {
      const buttons = submitButtons(formBodies(html)[0] ?? "");
      assert.equal(buttons[0]?.novalidate, false, `Enter bypasses validation on ${screen}`);
    }
  });

  it("never lets Enter reach Save anyway", () => {
    // #147's escape hatch, held to #140's rule before it can break it. Save
    // anyway stores a mailbox nothing has authenticated against, so the one
    // property it must have is that it takes a deliberate click: it is neither
    // the first submit button (which is what Enter presses) nor the only one.
    for (const { screen, html } of ADD_MAILBOX_SCREENS) {
      const buttons = submitButtons(formBodies(html)[0] ?? "");
      const index = buttons.findIndex((button) => button.label === "Save anyway");
      if (index === -1) continue;
      assert.ok(index > 0, `Save anyway is what Enter presses on ${screen}`);
    }
  });
});

describe("Save anyway, on the full form", () => {
  const html = renderMailboxForm({ csrf: "c", stamp: "1-2", account: null });

  it("is on the form, under the field name the wire contract declares", () => {
    assert.match(html, /name="save_anyway" value="1"/);
    assert.match(html, />\s*Save anyway\s*</);
  });

  it("is written after Save, which is what makes Enter press Save", () => {
    assert.ok(
      html.indexOf('value="save"') < html.indexOf('name="save_anyway"'),
      "Save anyway must not precede Save in the DOM"
    );
  });

  it("is on an edit form too, since an edit can break a working mailbox", () => {
    const editing = renderMailboxForm({
      csrf: "c",
      stamp: "1-2",
      account: sampleAccount("work"),
    });
    assert.match(editing, /name="save_anyway"/);
  });
});
