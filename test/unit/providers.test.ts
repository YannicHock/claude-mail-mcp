/**
 * Tier 2's table — the presets the wizard offers when a domain publishes no
 * autoconfig document of its own.
 *
 * **A wrong preset is worse than no preset.** It produces an authentication
 * failure that reads as a wrong password, on a screen the operator has no reason
 * to distrust, and they will retype their password before they suspect the host.
 * So the values below are pinned as literals rather than derived from the table,
 * which is the only way an assertion here can fail: a test that read the port out
 * of `MAIL_PROVIDERS` and compared it with itself would keep a typo green.
 *
 * Each literal was read off the provider's own current documentation, and the
 * URL it came from is in the table next to it. Anything the documentation did
 * not state is not in the table at all — no CalDAV URL guessed from a pattern,
 * no STARTTLS port inferred from the fact that most providers have one — and the
 * absences are pinned here too, because "we deliberately have no value for this"
 * is exactly the kind of decision a later edit undoes by accident.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  DOMAIN_PLACEHOLDER,
  EMAIL_PLACEHOLDER,
  fillTemplate,
  findProvider,
  LOCALPART_PLACEHOLDER,
  MAIL_PROVIDERS,
  prefillFor,
  providerPresets,
} from "../../src/providers.js";
import { CHECKBOX_ON, domainOf, MAILBOX_FIELDS } from "../../shared/settings-api.js";

const EMAIL = "Anna.Example@Example.Com";

/** The prefill for one provider id, or a failed assertion naming it. */
function prefill(id: string, email = EMAIL): Record<string, string> {
  const provider = findProvider(id);
  assert.ok(provider, `the table has no entry called ${id}`);
  return prefillFor(provider, email);
}

describe("the provider table", () => {
  it("offers every provider the design named, and not Nextcloud", () => {
    // Nextcloud was in the design sketch and is deliberately absent: it runs no
    // IMAP or SMTP server at all — its Mail app is a client that connects to
    // somebody else's — so every mail field an entry for it could carry would
    // be wrong by construction. Its CalDAV URL is real, and belongs wherever
    // calendars are set up on their own rather than on a screen whose output is
    // a mailbox.
    //
    // Gmail joined the list in #150. Its settings were never the problem — the
    // deployment this milestone is named for found them by autoconfig — but the
    // provider list is where an operator whose lookup was blocked ends up, and
    // scrolling past eight entries without Gmail in them reads as "unsupported".
    assert.deepEqual(
      MAIL_PROVIDERS.map((provider) => provider.id),
      [
        "gmail",
        "mailbox-org",
        "fastmail",
        "icloud",
        "migadu",
        "posteo",
        "hetzner-webhosting",
        "mailcow",
        "iredmail",
      ]
    );
    assert.equal(findProvider("nextcloud"), null);
  });

  it("has a unique id and a documentation URL for every entry", () => {
    const ids = MAIL_PROVIDERS.map((provider) => provider.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const provider of MAIL_PROVIDERS) {
      assert.match(provider.source, /^https:\/\//, `${provider.id} cites no documentation`);
      assert.notEqual(provider.label, "", provider.id);
    }
  });

  it("never suggests an unencrypted connection", () => {
    // `tls: false` is STARTTLS, not plaintext, and the only ports it appears
    // with are the submission and IMAP ports that upgrade. A preset that landed
    // on 25 or on 110 would be offering to send a password in the clear.
    for (const provider of MAIL_PROVIDERS) {
      assert.equal(provider.imap.port, provider.imap.tls ? 993 : 143, provider.id);
      assert.ok([465, 587].includes(provider.smtp.port), `${provider.id} smtp port`);
      assert.equal(provider.smtp.tls, provider.smtp.port === 465, `${provider.id} smtp tls`);
      if (provider.caldav !== null) {
        assert.match(provider.caldav.url, /^https:\/\//, `${provider.id} caldav`);
      }
    }
  });

  it("carries no password, anywhere, for anyone", () => {
    // The table is presets, not credentials. Nothing in this file has ever had
    // somewhere to put a password and this is what keeps it that way.
    const json = JSON.stringify(MAIL_PROVIDERS);
    assert.equal(/pass(word)?["':]/i.test(json), false, json);
    for (const provider of MAIL_PROVIDERS) {
      const values = prefillFor(provider, "anna@example.com");
      assert.equal(MAILBOX_FIELDS.imapPass in values, false, provider.id);
      assert.equal(MAILBOX_FIELDS.smtpPass in values, false, provider.id);
      assert.equal(MAILBOX_FIELDS.caldavPass in values, false, provider.id);
    }
  });

  it("says out loud what would otherwise fail as a wrong password", () => {
    // Three entries need a password that is not the account password, two have
    // a host that is not what a reader would guess, and one has two different
    // usernames. Every one of those surfaces as "authentication failed" if it
    // is not said on the screen where the choice is made.
    for (const id of ["fastmail", "icloud", "posteo", "hetzner-webhosting", "mailcow", "iredmail"]) {
      const provider = findProvider(id);
      assert.ok(provider);
      assert.notEqual(provider.note, "", `${id} has a caveat and does not state it`);
    }
  });
});

describe("the hosted providers, against their own documentation", () => {
  it("mailbox.org — imap/smtp.mailbox.org, implicit TLS, dav.mailbox.org", () => {
    // https://kb.mailbox.org/en/private/e-mail/e-mail-configuration/
    const values = prefill("mailbox-org");
    assert.equal(values[MAILBOX_FIELDS.imapHost], "imap.mailbox.org");
    assert.equal(values[MAILBOX_FIELDS.imapPort], "993");
    assert.equal(values[MAILBOX_FIELDS.imapTls], CHECKBOX_ON);
    assert.equal(values[MAILBOX_FIELDS.smtpHost], "smtp.mailbox.org");
    assert.equal(values[MAILBOX_FIELDS.smtpPort], "465");
    assert.equal(values[MAILBOX_FIELDS.smtpTls], CHECKBOX_ON);
    assert.equal(values[MAILBOX_FIELDS.caldavUrl], "https://dav.mailbox.org/");
  });

  it("Fastmail — imap/smtp.fastmail.com, implicit TLS, caldav.fastmail.com", () => {
    // https://www.fastmail.help/hc/en-us/articles/1500000278342-Server-names-and-ports
    const values = prefill("fastmail");
    assert.equal(values[MAILBOX_FIELDS.imapHost], "imap.fastmail.com");
    assert.equal(values[MAILBOX_FIELDS.imapPort], "993");
    assert.equal(values[MAILBOX_FIELDS.smtpHost], "smtp.fastmail.com");
    assert.equal(values[MAILBOX_FIELDS.smtpPort], "465");
    assert.equal(values[MAILBOX_FIELDS.caldavUrl], "https://caldav.fastmail.com/");
    assert.match(findProvider("fastmail")?.note ?? "", /app password/i);
  });

  it("iCloud — two different usernames, 587 STARTTLS, and no CalDAV URL", () => {
    // https://support.apple.com/en-us/102525 — Apple documents the IMAP login
    // as "johnappleseed, not johnappleseed@icloud.com" and the SMTP login as
    // the full address. This is the entry a single username box gets wrong for
    // every iCloud operator, which is why `user` is a field and not a guess.
    const values = prefill("icloud", "John.Appleseed@icloud.com");
    assert.equal(values[MAILBOX_FIELDS.imapHost], "imap.mail.me.com");
    assert.equal(values[MAILBOX_FIELDS.imapPort], "993");
    assert.equal(values[MAILBOX_FIELDS.imapUser], "John.Appleseed");
    assert.equal(values[MAILBOX_FIELDS.smtpHost], "smtp.mail.me.com");
    // 587/STARTTLS, because that is the only submission port Apple documents.
    assert.equal(values[MAILBOX_FIELDS.smtpPort], "587");
    assert.equal(values[MAILBOX_FIELDS.smtpTls], "");
    assert.equal(values[MAILBOX_FIELDS.smtpUser], "John.Appleseed@icloud.com");
    // Apple's server-settings article gives no CalDAV address at all, and the
    // per-account hosts that circulate are on nobody's documentation. Absent
    // on purpose, and pinned so it stays that way.
    assert.equal(MAILBOX_FIELDS.caldavUrl in values, false);
    assert.equal(findProvider("icloud")?.caldav, null);
  });

  it("Migadu — one set of hosts whatever the customer's own domain is", () => {
    // https://www.migadu.com/support/ — and the hosts do not vary by domain,
    // which is the mistake a reader makes with a provider that hosts custom
    // domains for a living.
    const values = prefill("migadu", "anna@her-own-domain.example");
    assert.equal(values[MAILBOX_FIELDS.imapHost], "imap.migadu.com");
    assert.equal(values[MAILBOX_FIELDS.smtpHost], "smtp.migadu.com");
    assert.equal(values[MAILBOX_FIELDS.smtpPort], "465");
    assert.equal(values[MAILBOX_FIELDS.caldavUrl], "https://cdav.migadu.com/");
    assert.equal(values[MAILBOX_FIELDS.imapUser], "anna@her-own-domain.example");
  });

  it("Posteo — posteo.de for every address, and CalDAV on 8443 by local part", () => {
    // https://posteo.de/en/help/how-do-i-set-up-posteo-in-an-email-client-pop3-imap-and-smtp
    // "The server name in all cases is posteo.de, regardless of your username."
    const values = prefill("posteo", "John.Example@posteo.net");
    assert.equal(values[MAILBOX_FIELDS.imapHost], "posteo.de");
    assert.equal(values[MAILBOX_FIELDS.smtpHost], "posteo.de");
    assert.equal(values[MAILBOX_FIELDS.smtpPort], "465");
    // Port 8443, not 443, and the path is the local part lowercased — both
    // documented, and both wrong if guessed the ordinary way.
    assert.equal(
      values[MAILBOX_FIELDS.caldavUrl],
      "https://posteo.de:8443/calendars/john.example/default"
    );
    assert.equal(values[MAILBOX_FIELDS.caldavUser], "John.Example@posteo.net");
  });

  it("Hetzner — mail.your-server.de literally, 587, and no CalDAV to preset", () => {
    // https://docs.hetzner.com/konsoleh/account-management/email/setting-up-an-email-account/
    // says "mail.your-server.de (literally!)" — twice, because the obvious
    // reading is that it is a placeholder for the customer's own domain.
    const values = prefill("hetzner-webhosting", "info@a-customer-domain.example");
    assert.equal(values[MAILBOX_FIELDS.imapHost], "mail.your-server.de");
    assert.equal(values[MAILBOX_FIELDS.smtpHost], "mail.your-server.de");
    // Hetzner lists 465 and recommends 587 in the same table. The recommended
    // one wins; a preset is not the place to argue with the provider.
    assert.equal(values[MAILBOX_FIELDS.smtpPort], "587");
    assert.equal(values[MAILBOX_FIELDS.smtpTls], "");
    // Hetzner publishes no CalDAV pattern: the address is per-calendar and has
    // to be copied out of Webmail. There is nothing here to preset.
    assert.equal(MAILBOX_FIELDS.caldavUrl in values, false);
    // And it is the web hosting product, not Cloud, which has no mailboxes.
    assert.match(findProvider("hetzner-webhosting")?.label ?? "", /Web Hosting|Managed/);
  });
});

describe("the self-hosted stacks", () => {
  it("mailcow fills in the shape and guesses the host from the domain", () => {
    // https://docs.mailcow.email/client/client-manual/ — the ports are the
    // project's documented defaults; the host is whatever FQDN the server was
    // installed under, and `mail.<domain>` is only the docs' own example. The
    // note says so, and the next screen is where it gets corrected.
    const values = prefill("mailcow", "anna@example.com");
    assert.equal(values[MAILBOX_FIELDS.imapHost], "mail.example.com");
    assert.equal(values[MAILBOX_FIELDS.imapPort], "993");
    assert.equal(values[MAILBOX_FIELDS.smtpHost], "mail.example.com");
    assert.equal(values[MAILBOX_FIELDS.smtpPort], "465");
    assert.equal(
      values[MAILBOX_FIELDS.caldavUrl],
      "https://mail.example.com/SOGo/dav/anna@example.com/Calendar/personal/"
    );
    assert.match(findProvider("mailcow")?.note ?? "", /guess|check/i);
  });

  it("iRedMail leaves the host empty rather than inventing a convention", () => {
    // https://docs.iredmail.org/network.ports.html and the install guide. The
    // project requires an FQDN and its own examples use `mx.example.com`, so
    // `mail.<domain>` is a convention it does not have — an empty required box
    // is a better prompt than a wrong guess.
    const values = prefill("iredmail", "anna@example.com");
    assert.equal(values[MAILBOX_FIELDS.imapHost], "");
    assert.equal(values[MAILBOX_FIELDS.smtpHost], "");
    assert.equal(values[MAILBOX_FIELDS.imapPort], "993");
    // 587 only. iRedMail's ports page lists 25 and 587 for Postfix and says
    // 465 "has been deprecated for years"; it is not documented as open.
    assert.equal(values[MAILBOX_FIELDS.smtpPort], "587");
    assert.equal(values[MAILBOX_FIELDS.smtpTls], "");
    // CalDAV comes from SOGo, which is optional at install time — an operator
    // who chose Roundcube has none, so this presets mail and leaves calendars
    // to the full form.
    assert.equal(MAILBOX_FIELDS.caldavUrl in values, false);
  });
});

describe("fillTemplate", () => {
  it("fills the domain, the whole address, and the lowercased local part", () => {
    assert.equal(fillTemplate(`mail.${DOMAIN_PLACEHOLDER}`, "Anna@Example.COM"), "mail.example.com");
    assert.equal(fillTemplate(EMAIL_PLACEHOLDER, "Anna@Example.COM"), "Anna@Example.COM");
    // Posteo is explicit that the path is lower case throughout.
    assert.equal(fillTemplate(LOCALPART_PLACEHOLDER, "John.Example@posteo.de"), "john.example");
  });

  it("renders nothing rather than a leftover placeholder", () => {
    // `mail.%DOMAIN%` in a required box is a puzzle; an empty required box is a
    // prompt. Only reachable for an address the screen before this has already
    // refused, which is why it is a guard rather than a message.
    assert.equal(fillTemplate(`mail.${DOMAIN_PLACEHOLDER}`, "not-an-address"), "");
    assert.equal(fillTemplate("imap.example.com", "not-an-address"), "imap.example.com");
  });

  it("leaves a literal host alone however odd the address is", () => {
    assert.equal(fillTemplate("mail.your-server.de", "a@b.c"), "mail.your-server.de");
  });
});

describe("domainOf", () => {
  it("lowercases the domain and refuses anything that is not an address", () => {
    assert.equal(domainOf("Anna@Example.COM"), "example.com");
    // The address with an @ in the local part still splits at the last one.
    assert.equal(domainOf('"weird@local"@example.com'), "example.com");
    for (const value of ["", "anna", "anna@", "@example.com"]) {
      assert.equal(domainOf(value), "", JSON.stringify(value));
    }
  });
});

describe("providerPresets — the table, as both readers get it", () => {
  // The one shape the table leaves this module in. The settings UI calls it
  // directly and the setup wizard reads the same thing off
  // `POST /settings/providers`, so an entry that is wrong here is wrong in both
  // places at once — which is the point of there being one table (#141).

  it("offers every entry the table has, in the table's own order", () => {
    assert.deepEqual(
      providerPresets(EMAIL).map((preset) => preset.id),
      MAIL_PROVIDERS.map((provider) => provider.id)
    );
  });

  it("carries the same values prefillFor produces, resolved for the address", () => {
    // Resolved on this side, not the caller's: a caller that had to substitute
    // %DOMAIN% itself would be a second implementation of the one thing this
    // table does, in the package that cannot see the placeholders.
    for (const provider of MAIL_PROVIDERS) {
      const preset = providerPresets(EMAIL).find((entry) => entry.id === provider.id);
      assert.ok(preset, provider.id);
      assert.deepEqual(preset.values, prefillFor(provider, EMAIL));
    }
  });

  it("leaves no placeholder in anything it sends", () => {
    for (const placeholder of [DOMAIN_PLACEHOLDER, LOCALPART_PLACEHOLDER, EMAIL_PLACEHOLDER]) {
      for (const preset of providerPresets(EMAIL)) {
        for (const [name, value] of Object.entries(preset.values)) {
          assert.equal(
            value.includes(placeholder),
            false,
            `${preset.id}'s ${name} still has ${placeholder} in it`
          );
        }
      }
    }
  });

  it("still answers for an address nobody has typed yet", () => {
    // The provider list is reachable from its own link, before there is an
    // address. An entry whose host is a template has nothing to become then,
    // and an empty required box is a prompt where `mail.` is a puzzle.
    const presets = providerPresets("");
    assert.equal(presets.length, MAIL_PROVIDERS.length);
    const mailcow = presets.find((preset) => preset.id === "mailcow");
    assert.ok(mailcow);
    assert.equal(mailcow.values[MAILBOX_FIELDS.imapHost], "");
    // A literal host is not a template and survives having no address.
    const posteo = presets.find((preset) => preset.id === "posteo");
    assert.ok(posteo);
    assert.equal(posteo.values[MAILBOX_FIELDS.imapHost], "posteo.de");
  });

  it("sends no password field, under any name, for any provider", () => {
    // The same property `prefillFor` has, restated at the boundary the values
    // actually cross. A preset is something to confirm, not to connect with.
    const serialised = JSON.stringify(providerPresets(EMAIL));
    for (const secret of [MAILBOX_FIELDS.imapPass, MAILBOX_FIELDS.smtpPass, MAILBOX_FIELDS.caldavPass]) {
      assert.equal(serialised.includes(secret), false, `${secret} is on the wire`);
    }
  });

  it("does not send the documentation URL each entry was verified against", () => {
    // `source` is for whoever checks the table next, not for the operator, and
    // nothing renders it. What is not rendered is not sent.
    const serialised = JSON.stringify(providerPresets(EMAIL));
    for (const provider of MAIL_PROVIDERS) {
      assert.equal(serialised.includes(provider.source), false, `${provider.id}'s source is sent`);
    }
  });
});
