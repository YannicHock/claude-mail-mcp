/**
 * The advice half of `src/providers.ts` — #148's `credentialNote` and #151's
 * `unsupported`, and the domain matching both are keyed on.
 *
 * Same standard as the preset table next door, and the same reason for it: a
 * note that is wrong is read on a screen the operator has no reason to
 * distrust, and it is read at the exact moment they are already confused. So
 * the wording is pinned as literals here rather than derived from the table,
 * the absences are pinned too, and the two corrections the research pass made
 * to what "everybody knows" about Gmail are pinned hardest of all — they are
 * the ones a later edit would helpfully put back.
 *
 * `docs/PROVIDERS.md` is the report every claim below came from.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  adviceForAddress,
  credentialNoteFor,
  findProvider,
  MAIL_PROVIDERS,
  PROVIDER_ADVICE,
  unsupportedNoticeFor,
} from "../../src/providers.js";
import {
  saveRefusedNotice,
  type MailboxProbeOutcome,
  type MailboxProbeReport,
} from "../../shared/settings-api.js";

describe("the advice table's own shape", () => {
  it("gives every entry a reason to exist and a source to check it against", () => {
    for (const entry of PROVIDER_ADVICE) {
      assert.ok(entry.domains.length > 0, `${entry.id} matches no domain`);
      assert.ok(
        entry.credentialNote !== undefined || entry.unsupported !== undefined,
        `${entry.id} has nothing to say and should not be an entry`
      );
      assert.match(entry.source, /^https:\/\//, `${entry.id} has no source URL`);
      assert.notEqual(entry.label, "", `${entry.id} has no label`);
    }
  });

  it("keeps the domains lowercase and unique across the whole table", () => {
    const seen = new Set<string>();
    for (const entry of PROVIDER_ADVICE) {
      for (const domain of entry.domains) {
        assert.equal(domain, domain.toLowerCase(), `${entry.id} carries ${domain} uncased`);
        assert.equal(seen.has(domain), false, `${domain} is claimed twice`);
        seen.add(domain);
      }
    }
  });

  it("gives a provider that cannot be served no password advice", () => {
    // There is no password to advise about. A note saying which app password to
    // create, under a warning saying no password can work, is a screen arguing
    // with itself.
    for (const entry of PROVIDER_ADVICE) {
      if (entry.unsupported === undefined) continue;
      assert.equal(entry.credentialNote, undefined, `${entry.id} says both things at once`);
    }
  });
});

describe("adviceForAddress — the domain match", () => {
  it("matches the whole domain, whatever case it was typed in", () => {
    assert.equal(adviceForAddress("Anna@GMAIL.com")?.id, "gmail");
    assert.equal(adviceForAddress("anna@googlemail.com")?.id, "gmail");
    assert.equal(adviceForAddress("anna@me.com")?.id, "icloud");
  });

  it("is null for a domain the table does not know, and does not throw", () => {
    assert.equal(adviceForAddress("anna@example.com"), null);
    assert.equal(credentialNoteFor("anna@example.com"), null);
    assert.equal(unsupportedNoticeFor("anna@example.com"), null);
  });

  it("is null for an address with no domain in it", () => {
    for (const typed of ["", "anna", "@", "anna@"]) {
      assert.equal(adviceForAddress(typed), null, typed);
      assert.equal(credentialNoteFor(typed), null, typed);
      assert.equal(unsupportedNoticeFor(typed), null, typed);
    }
  });

  it("does not read a subdomain as the provider it ends in", () => {
    // `gmail.com.example.org` is somebody else's mail system, and telling its
    // operator to go and make a Google app password is a lie told confidently.
    assert.equal(adviceForAddress("anna@gmail.com.example.org"), null);
    assert.equal(adviceForAddress("anna@mail.gmail.com"), null);
  });
});

describe("what each provider's note says, against its own documentation", () => {
  it("Gmail — an app password when 2-Step Verification is on", () => {
    // https://support.google.com/accounts/answer/185833
    const note = credentialNoteFor("anna@gmail.com") ?? "";
    assert.match(note, /2-Step Verification/);
    assert.match(note, /app password/i);
    assert.match(note, /16-digit/);
  });

  it("Gmail — never sends anyone after the IMAP switch Google removed", () => {
    // The correction in #148's own comment: Google removed the Enable/Disable
    // IMAP option in January 2025 and IMAP is always on. A note telling an
    // operator to go and enable IMAP sends them looking for a setting that does
    // not exist, which is worse than saying nothing.
    // https://support.google.com/mail/answer/7126229
    const note = credentialNoteFor("anna@gmail.com") ?? "";
    assert.equal(/enable IMAP/i.test(note), false, note);
    assert.match(note, /always on/i);
  });

  it("Gmail — asserts nothing about how the passcode is spaced", () => {
    // Google says "16-digit passcode" and stops. That it is shown as four
    // groups of four, and that the spaces must be stripped, is widely repeated
    // and nowhere in Google's documentation, so it does not ship. Zoho
    // documents the equivalent instruction and Zoho's note carries it.
    const note = credentialNoteFor("anna@gmail.com") ?? "";
    assert.equal(/four groups|without.*spaces|remove the spaces/i.test(note), false, note);
    assert.match(credentialNoteFor("anna@zoho.com") ?? "", /without any spaces/);
  });

  it("Fastmail and iCloud say the requirement is unconditional", () => {
    // https://www.fastmail.help/hc/en-us/articles/360058752854-App-passwords
    // https://support.apple.com/en-us/102654
    const fastmail = credentialNoteFor("anna@fastmail.com") ?? "";
    assert.match(fastmail, /never works/);
    assert.match(fastmail, /two-step verification on or off/);

    const icloud = credentialNoteFor("anna@icloud.com") ?? "";
    assert.match(icloud, /always needs an app-specific password/i);
    assert.match(icloud, /never your Apple Account password/);
  });

  it("Yahoo and AOL are unconditional too, on the trigger they document", () => {
    // Neither documents two-step verification as a precondition. What both
    // document is an app that does not use their own branded sign-in page —
    // which is exactly what this connector is.
    for (const address of ["anna@yahoo.com", "anna@aol.com"]) {
      const note = credentialNoteFor(address) ?? "";
      assert.match(note, /does not use its own sign-in page/, address);
      assert.match(note, /whether or not two-step verification is on/, address);
    }
  });

  it("mailbox.org and Zoho say it is two-factor authentication that changes the answer", () => {
    assert.match(credentialNoteFor("anna@mailbox.org") ?? "", /two-factor authentication/);
    assert.match(credentialNoteFor("anna@zoho.com") ?? "", /two-factor authentication/);
  });

  it("Posteo says what Posteo tells you to use, and not what it refuses", () => {
    // Posteo documents the app password as the credential to enter. It does not
    // document the account password as refused, so the note does not claim it.
    const note = credentialNoteFor("anna@posteo.de") ?? "";
    assert.match(note, /app password/);
    assert.equal(/never works|will not work|refus/i.test(note), false, note);
  });

  it("carries mailcow's rule on its preset instead, having no domain to match", () => {
    // mailcow is self-hosted: its mailboxes are on the operator's own domain,
    // so no domain match can ever recognise one. The documented app-password
    // rule is on the screen that does know it is mailcow.
    assert.equal(adviceForAddress("anna@mailcow.example"), null);
    assert.match(findProvider("mailcow")?.note ?? "", /app password/i);
  });
});

describe("the providers this connector cannot serve", () => {
  it("Microsoft is a flat no, and says it cannot be turned back on", () => {
    for (const address of ["a@outlook.com", "a@hotmail.com", "a@live.com", "a@msn.com"]) {
      const warning = unsupportedNoticeFor(address) ?? "";
      assert.match(warning, /no password will connect/, address);
      assert.match(warning, /OAuth 2\.0/, address);
    }
  });

  it("Proton is a softer no, worded so a Bridge operator recognises their own case", () => {
    // The asymmetry is the whole reason this warns rather than blocks: a client
    // connecting through a local Proton Mail Bridge is a working configuration,
    // and refusing the save would lock out the one Proton setup that works.
    const warning = unsupportedNoticeFor("anna@proton.me") ?? "";
    assert.match(warning, /Bridge/);
    assert.match(warning, /carry on/);
    assert.equal(unsupportedNoticeFor("anna@pm.me"), warning);
  });

  it("neither has a preset, because there is nothing to preset", () => {
    for (const id of ["microsoft", "proton"]) {
      assert.equal(findProvider(id), null, `${id} must not offer settings that cannot work`);
    }
  });
});

describe("Gmail as a preset (#150)", () => {
  it("is in the table, with the hosts Google documents", () => {
    // https://knowledge.workspace.google.com/admin/sync/set-up-gmail-with-a-third-party-email-client
    const gmail = findProvider("gmail");
    assert.ok(gmail);
    assert.equal(gmail.imap.host, "imap.gmail.com");
    assert.equal(gmail.imap.port, 993);
    assert.equal(gmail.imap.tls, true);
    assert.equal(gmail.smtp.host, "smtp.gmail.com");
    // 587 with STARTTLS is Google's own table; 465 is named only as the
    // alternative if you change the encryption type.
    assert.equal(gmail.smtp.port, 587);
    assert.equal(gmail.smtp.tls, false);
    // Google's CalDAV surface is OAuth-only and this connector sends a
    // password. Absent on purpose, like iCloud's and Hetzner's.
    assert.equal(gmail.caldav, null);
  });

  it("keeps every preset id unique now that gmail is one of them", () => {
    const ids = MAIL_PROVIDERS.map((provider) => provider.id);
    assert.equal(new Set(ids).size, ids.length);
  });
});

describe("saveRefusedNotice takes the note in place of its generic sentence", () => {
  const REJECTED = { ok: false as const, message: "no", credentialRejection: true };
  const UNREACHABLE = { ok: false as const, message: "connect ECONNREFUSED" };
  const GENERIC = /some providers want an app password rather than the account one/;
  const NOTE = "Gmail wants an app password.";

  const report = (imap: MailboxProbeOutcome): MailboxProbeReport => ({
    imap,
    smtp: { ok: true },
    caldav: null,
  });

  it("says the generic sentence when no note was passed", () => {
    assert.match(saveRefusedNotice(report(REJECTED)) ?? "", GENERIC);
  });

  it("says the note instead of it, never as well as it", () => {
    // Both on one screen would say the same thing twice, the second time
    // specifically, and the argument for the note is that it is targeted.
    const notice = saveRefusedNotice(report(REJECTED), NOTE) ?? "";
    assert.ok(notice.includes(NOTE), notice);
    assert.equal(GENERIC.test(notice), false, notice);
    assert.match(notice, /IMAP rejected these credentials, so nothing was saved\./);
    assert.match(notice, /Save anyway/, "the way past the gate must survive it");
  });

  it("takes a note on a connectivity failure too, because the caller decides", () => {
    // This used to assert the opposite, on the reasoning that a note is always
    // about a password and a host that never answered said nothing about one.
    // True of a `credentialNote`, false of an `unsupported` warning — Proton
    // answers no IMAP from the internet at all, so its refusal *is*
    // connectivity, and gating here swallowed the one entry that explains it.
    // Whether a note applies is now the caller's question; this function only
    // puts the one it is given in place of its own generic sentence.
    const notice = saveRefusedNotice(report(UNREACHABLE), NOTE) ?? "";
    assert.ok(notice.includes(NOTE), notice);
    assert.match(notice, /did not answer/, "it still names what failed");
    assert.doesNotMatch(notice, /Check what failed above/, "never the note and the generic one");
  });

  it("reads an empty note as no note, the way ProviderPreset.note already does", () => {
    assert.match(saveRefusedNotice(report(REJECTED), "") ?? "", GENERIC);
  });

  it("is still null when the report is not a refusal at all", () => {
    assert.equal(saveRefusedNotice(report({ ok: true }), NOTE), null);
  });

  it("stands aside for a warning the screen is already showing", () => {
    // #191. The `unsupported` sentence used to be passed in here as if it were
    // a note, which put a 60-word paragraph inside this sentence — and once the
    // form has a warning box of its own, that is the same paragraph twice, one
    // above the other. So the caller says the screen is already showing it and
    // this sentence prints no remedy: what failed, and the way past the gate.
    const notice = saveRefusedNotice(report(REJECTED), undefined, true) ?? "";
    assert.match(notice, /IMAP rejected these credentials, so nothing was saved\./);
    assert.match(notice, /Save anyway/, "the way past the gate must survive it");
    // Not the generic clause either, and that is the whole point of the flag
    // rather than simply dropping the paragraph: the address it is about is one
    // no password can reach, so "find an app password" is a wrong instruction
    // and the reason #184 put the paragraph here in the first place.
    assert.equal(GENERIC.test(notice), false, notice);
    assert.doesNotMatch(notice, /Check what failed above/, notice);
  });

  it("still prefers a note over standing aside, when the caller has both", () => {
    const notice = saveRefusedNotice(report(REJECTED), NOTE, true) ?? "";
    assert.ok(notice.includes(NOTE), notice);
  });

  it("says the generic sentence when nothing is warned, flag or no flag", () => {
    assert.match(saveRefusedNotice(report(REJECTED), undefined, false) ?? "", GENERIC);
  });
});
