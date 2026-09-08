import { test } from "node:test";
import assert from "node:assert/strict";
import type { Account } from "../../src/accounts.js";
import { renderMailboxList, renderMailboxForm, escapeHtml } from "../../src/settings-pages.js";

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
