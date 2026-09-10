# Providers

What each mail provider wants from a **password** over IMAP and SMTP, and which
providers this connector cannot serve at all.

This connector authenticates with a username and a password. It speaks no OAuth to
a mail server, and there is no plan for it to: the credential an operator types into
*Add mailbox* is sent to the provider's IMAP and SMTP endpoints as-is. That single
fact decides everything below. Where a provider accepts a password, this connector
works; where a provider has stopped accepting passwords, no amount of care in the
setup wizard can help, and the honest answer is to say so before a password is
typed.

Finding the right **hosts and ports** is a different problem, already solved by the
address-first cascade — autoconfig first, then the table in
[`src/providers.ts`](../src/providers.ts), then the full form. This page is about
what happens *after* those are right and the server still says no.

## How to read this page

Every claim here was checked against **that provider's own current documentation**,
and carries the URL it was checked against. Nothing is inferred from another
provider's behaviour, from a support forum, or from what the protocol makes
plausible. Where a provider's documentation does not answer the question, this page
says that it does not, rather than filling the gap — a note that is right only
sometimes is one more thing to debug, and it appears on a screen the operator has no
reason to distrust.

Documentation last checked: **2026-09-10**.

Four categories:

| | what it means |
| --- | --- |
| **Password** | The ordinary mailbox password works. Nothing to warn about. |
| **App password when 2FA is on** | With two-factor authentication enabled, IMAP takes a provider-generated password instead of the account one. Without it, the account password works. |
| **App password always** | The account password never works over IMAP, whatever the account's 2FA setting. |
| **Cannot be served** | The provider has withdrawn password authentication, or never offered it. This connector cannot connect. See [Providers this connector cannot serve](#providers-this-connector-cannot-serve). |

## Summary

`src/providers.ts` holds two tables, and the column below says which of them an
entry is in. **Preset** is `MAIL_PROVIDERS`: hosts, ports and TLS, offered as a
choice on the provider screen. **Advice** is `PROVIDER_ADVICE`: what to say about
a password, matched against the domain the operator's address ends in, and shown
only at the moment it is relevant — a `credentialNote` when a server has just
rejected the password (#148), an `unsupported` warning as soon as the address is
looked up (#151).

The two sets do not coincide, and neither one is a subset of the other. A
provider whose customers use their own domain (mailcow, iRedMail, Migadu,
Hetzner) cannot be recognised by an address, so its advice has to live on its
preset's `note` instead. A provider whose settings are not presettable — Zoho's
IMAP host depends on the account type, Microsoft and Proton have nothing to dial
— gets advice and no preset, because a possibly-wrong host in a required box is
the failure mode `src/providers.ts` exists to avoid.

| Provider | In `src/providers.ts` | What the password must be |
| --- | --- | --- |
| [Gmail](#gmail) | preset + advice | App password when 2FA is on |
| [mailbox.org](#mailboxorg) | preset + advice | App password when 2FA is on |
| [Zoho Mail](#zoho-mail) | advice only | App password when 2FA is on |
| [mailcow](#mailcow-self-hosted) | preset (`note`) | App password when 2FA is on |
| [Fastmail](#fastmail) | preset + advice | **App password always** |
| [iCloud Mail](#icloud-mail) | preset + advice | **App password always** |
| [Yahoo Mail](#yahoo-mail) | advice only | **App password always** |
| [AOL Mail](#aol-mail) | advice only | **App password always** |
| [Posteo](#posteo) | preset + advice | App password (see the entry — Posteo documents it as *the* credential) |
| [Migadu](#migadu) | preset | Password |
| [Hetzner Web Hosting](#hetzner-web-hosting--managed-server) | preset | Password |
| [iRedMail](#iredmail-self-hosted) | preset | Password |
| [Outlook.com / Microsoft 365](#outlookcom-and-microsoft-365) | advice (`unsupported`) | **Cannot be served** |
| [Proton Mail](#proton-mail) | advice (`unsupported`) | **Cannot be served without the Bridge** |

---

## Providers that need an app password when 2FA is on

For all four, an account **without** two-factor authentication takes the ordinary
password, and turning 2FA on is what changes the answer. That is why the note
belongs on a credential rejection rather than on the form: most operators of these
providers have no problem, and the ones who do have exactly this one.

### Gmail

**App password when 2FA is on.**

Google documents that app passwords exist because "when you use 2-Step
Verification, some less secure apps or devices may be blocked from accessing your
Google Account", and that "app passwords can only be used with accounts that have
2-Step Verification turned on". An app password is described as "a 16-digit
passcode", created at `myaccount.google.com` → Security → App passwords.

Google also states, on its own page for connecting Gmail to another client, that
**IMAP no longer has an on/off switch**: "Starting January 2025, the option to
choose 'Enable IMAP' or 'Disable IMAP' won't be available. IMAP access is always
turned on in Gmail". A Gmail mailbox that refuses a password is therefore not a
mailbox with IMAP switched off — with 2-Step Verification on, it is the password
that is wrong.

Two things that circulate widely about Gmail app passwords are **not** in Google's
current documentation and are therefore not asserted here: that the password is
displayed as four groups of four characters, and that the spaces must be stripped
before pasting. Google says "16-digit passcode" and nothing about spacing. See
[Where this page could not answer](#where-this-page-could-not-answer).

- <https://support.google.com/accounts/answer/185833>
- <https://support.google.com/mail/answer/7126229>

### mailbox.org

**App password when 2FA is on.**

mailbox.org documents the ordinary case as "your main email address" plus "your
mailbox password" against `imap.mailbox.org` and `smtp.mailbox.org`. With two-factor
authentication enabled, that changes: "you must use an app password to set up
external programmes (e.g. calendar/address book apps, WebDAV clients, Drive
synchronisation or Exchange ActiveSync)".

Separately, and independent of 2FA: mailbox.org only accepts a login for the main
address, not an alias, and only permits sending from a registered address — an
unregistered sender produces `Sender address rejected: not owned by user`. That is a
send-time failure rather than a login one, but it reaches an operator as the same
kind of surprise.

- <https://kb.mailbox.org/en/private/e-mail/e-mail-configuration/>

### Zoho Mail

**App password when 2FA is on.**

Zoho documents that with two-factor authentication enabled, an application-specific
password replaces the regular password for POP, IMAP and ActiveSync: during
configuration "you enter the 12-digit application-specific password instead of the
regular password", and — unlike Google — Zoho is explicit about the formatting:
"when you enter the password in your email clients, enter it without any spaces".
Zoho notes that application-specific passwords never expire, so a web password
expiry does not require updating the client.

Zoho's IMAP host depends on the account type: `imap.zoho.com` for personal
`@zoho.com` accounts, `imappro.zoho.com` for domain-based business accounts, both on
993 with SSL required. Zoho also documents that SAML-authenticated users must
generate and use an application-specific password for IMAP regardless.

- <https://www.zoho.com/mail/help/imap-access.html>
- <https://www.zoho.com/mail/help/adminconsole/two-factor-authentication.html>

### mailcow (self-hosted)

**App password when 2FA is on.** Not one of the spec's expected entries, and it
earns one anyway.

mailcow is self-hosted, so its answer is per-mailbox rather than per-provider, but
it is documented and unambiguous: "Mailbox users who have enabled two-factor
authentication must create app passwords for external applications such as mail
clients." The app password is generated in the mailcow UI under Mailbox settings →
App passwords.

For the ordinary case, mailcow's manual-configuration guide asks for "plain"
password authentication — which is the mechanism name, not a warning: "the password
will not be transferred to the server in plain text as no authentication is allowed
to take place without TLS".

- <https://docs.mailcow.email/manual-guides/mailcow-UI/u_e-mailcow_ui-tfa/>
- <https://docs.mailcow.email/client/client-manual/>

---

## Providers that need an app password always

The account password is never the answer for these, whatever the account's 2FA
setting. This is the group that matters most for this connector, because two of them
are shipped in the provider table and named in the README's opening sentence — an
operator following the happy path meets this wall with no warning at all.

### Fastmail

**App password always.**

Fastmail's own server-names page repeats it for every protocol it lists — IMAP, POP,
SMTP, CalDAV and CardDAV: "You cannot use your regular Fastmail password." and "You
will need to get an app password to connect to these servers."

The app-passwords page is equally direct about the failure mode: "Every third-party
program or app needs its own app password to access your information", and "if you
use your normal password or your Fastmail two-step verification password on an
external account, syncing to an external service won't work and you will see a
password error."

Note that this holds with two-step verification **off**. Fastmail's requirement is
not a 2FA consequence.

- <https://www.fastmail.help/hc/en-us/articles/1500000278342-Server-names-and-ports>
- <https://www.fastmail.help/hc/en-us/articles/360058752854-App-passwords>

### iCloud Mail

**App password always**, and the reason is worth spelling out because it is a
two-step argument rather than a single sentence in one document.

Apple's iCloud Mail server-settings article tells third-party clients to "generate an
app-specific password" for both the IMAP and SMTP entries. Apple's app-specific
password article then states the precondition: "To generate and use app-specific
passwords, your Apple Account must be protected with two-factor authentication."

That precondition is not an escape hatch, because 2FA is not optional in practice:
Apple documents that "two-factor authentication is the default security method for
most accounts", and that "if your Apple Account was created using two-factor
authentication, this extra protection can't be removed". So there is no
configuration of a current Apple Account in which the account password is the right
credential for IMAP.

The iCloud entry is also the table's one asymmetric login, documented by Apple:
the **IMAP** username is the part before the `@` ("usually the name of your iCloud
Mail email address", e.g. `johnappleseed`), and the **SMTP** username is the whole
address.

- <https://support.apple.com/en-us/102525>
- <https://support.apple.com/en-us/102654>
- <https://support.apple.com/en-us/102660>

### Yahoo Mail

**App password always** — and this contradicts the expectation this research
started from, which had Yahoo in the 2FA-conditional group.

Yahoo's own article states the rule with no reference to two-step verification at
all: "Third-party email apps (that do not use our Yahoo branded sign-in page)
require you to enter a single password for login credentials." App passwords are
"randomly generated codes that let non-Yahoo email apps access your account when
they don't use Yahoo's sign-in page", created from the Yahoo Account Security page
under *External connections* → *Create app password*.

The trigger Yahoo documents is **the app not using Yahoo's sign-in page**, which is
exactly what this connector is. Two-step verification appears nowhere in that
condition. Yahoo also warns that app-password creation can be refused outright for a
browser session it does not recognise, and that customer care cannot override it —
so an operator may need a browser they have signed into Yahoo from for several days
running.

- <https://help.yahoo.com/kb/SLN15241.html>

### AOL Mail

**App password always.** AOL runs the same account platform as Yahoo and documents
the same rule in the same words: "Third-party email apps (that do not use our AOL
Mail branded sign-in page) require you to enter a single password for login
credentials", and an app password is "a randomly generated code that gives a non-AOL
app permission to access your AOL account".

- <https://help.aol.com/articles/create-and-manage-app-password>

### Posteo

**App password**, with a caveat this page is not willing to paper over.

Posteo's client-setup instructions give the credential for both servers as "an app
password", and are emphatic about the second one: "The outgoing mail server requires
authentication in all cases. Therefore, be sure to also enter your app password for
the SMTP server even if your email client may indicate this as optional."

What Posteo's documentation does **not** state anywhere this research could find is
whether the account password still works. The app-passwords page describes them as
letting "email clients on your device access your mailbox with their own, separate
password" — a description, not a prohibition — and mentions no 2FA precondition. So
the verifiable claim is *what Posteo tells you to use*, not *what Posteo refuses*,
and the note stops there. Posteo allows up to five app passwords at a time.

The two connection details that catch people out are already in the table and both
are documented: the server is `posteo.de` for every customer regardless of whether
their address ends `.de`, `.com` or `.net`, and the CalDAV URL is on port 8443 with
the **local part** in the path, not the whole address.

- <https://posteo.de/en/help/how-do-i-set-up-posteo-in-an-email-client-pop3-imap-and-smtp>
- <https://posteo.de/en/help/app-passwords>

---

## Providers where the ordinary password is the answer

These have no note, and that is the finding rather than a gap in the research. Each
was checked; none documents an app-password requirement or a 2FA consequence for
IMAP.

### Migadu

**Password.** Migadu documents IMAP on `imap.migadu.com:993` and SMTP on
`smtp.migadu.com:465`, both TLS, both with plain-password authentication and the
full address as the username. Nothing in Migadu's client guides describes an
app-password mechanism or a two-factor consequence for mail access; a Migadu mailbox
has its own password and that is what the client uses. The hosts are the same
whatever the customer's own domain is.

- <https://www.migadu.com/guides/>

### Hetzner Web Hosting / Managed Server

**Password.** Hetzner's konsoleH documentation gives the mail client credential as,
in full, "Password: Your password for the mailbox" — the password set for that
mailbox in konsoleH. Hetzner documents no app-password mechanism and no 2FA
consequence for mailbox authentication.

The trap on this provider is the hostname rather than the password: the server
really is the literal string `mail.your-server.de` for every customer, not the
customer's own domain. Hetzner *Cloud* has no mailboxes at all; this entry is the
web hosting mail service.

- <https://docs.hetzner.com/konsoleh/account-management/email/setting-up-an-email-account/>

### iRedMail (self-hosted)

**Password.** iRedMail's documentation covers the ports — submission on 587 with
STARTTLS, IMAP on 143 with STARTTLS enforced by default — and says nothing about
credentials beyond the mailbox login, because there is nothing provider-specific to
say: an iRedMail deployment authenticates against whatever backend the operator
installed. There is no app-password concept in iRedMail to warn about.

iRedMail has no standard hostname; its own examples use `mx.example.com`, so the
table deliberately presets no host for it.

- <https://docs.iredmail.org/network.ports.html>

---

## Providers this connector cannot serve

Not "harder to set up". **No password will work.** These are the entries that
justify telling an operator at address lookup, before a password field is filled —
telling someone *after* they have typed a password that no password can work is
worse than not telling them at all.

### Outlook.com and Microsoft 365

**Cannot be served.** Microsoft has withdrawn password authentication for IMAP on
both the consumer and the tenant side, and it cannot be turned back on.

**Microsoft 365 / Exchange Online.** Microsoft states plainly: "Basic authentication
is now disabled in all tenants." and "Now no one (you or Microsoft support) can
re-enable Basic authentication in your tenant." The removal explicitly covers IMAP:
"We removed the ability to use Basic authentication in Exchange Online for Exchange
ActiveSync (EAS), POP, IMAP, Remote PowerShell (RPS), Exchange Web Services (EWS),
Offline Address Book (OAB), Autodiscover, Outlook for Windows, and Outlook for Mac."
What is required instead is OAuth 2.0 on the Microsoft identity platform. Microsoft
adds, in a note that closes the obvious workaround, that "the deprecation of basic
authentication also prevents the use of app passwords with apps that don't support
two-step verification."

SMTP AUTH is the one loose thread — it was disabled only in tenants that were not
using it, and its own basic-auth retirement runs on a separately published timeline.
That does not help this connector: without IMAP there is no mailbox to read, and a
send-only account is not what *Add mailbox* creates.

**Outlook.com, Hotmail, Live, MSN.** The consumer side went the same way, and
earlier for third-party clients: Microsoft documents that Basic Authentication is "no
longer available to access any Outlook account" as of **16 September 2024**, that
third-party email apps must use modern authentication (OAuth2), and that a client
configured for POP or IMAP with Basic authentication "will no longer connect".

There is no app password to create, no setting to flip, and no supported
configuration in which this connector can authenticate to an `@outlook.com`,
`@hotmail.com`, `@live.com` or `@msn.com` mailbox. Serving these would require OAuth
in the connector's IMAP client, which is a different piece of work from anything in
this milestone.

- <https://learn.microsoft.com/en-us/exchange/clients-and-mobile-in-exchange-online/deprecation-of-basic-authentication-exchange-online>
- <https://support.microsoft.com/en-us/office/modern-authentication-methods-now-needed-to-continue-syncing-outlook-email-in-non-microsoft-email-apps-c5d65390-9676-4763-b41f-d7986499a90d>
- <https://support.microsoft.com/en-us/office/outlook-and-other-apps-are-unable-to-connect-to-outlook-com-when-using-basic-authentication-f4202ebf-89c6-4a8a-bec3-3d60cf7deaef>

### Proton Mail

**Cannot be served without the Bridge**, which is a different shape of "no" from
Microsoft's and worth stating precisely.

Proton's servers do not answer IMAP or SMTP from the internet. Proton documents that
a desktop client connects through **Proton Mail Bridge**, which "encrypts and
decrypts your mail as it enters and leaves your computer, making it possible to use
Proton Mail in a desktop client without giving up Proton's privacy features", and
that Bridge "manages both the incoming and outgoing server connections for you".
Bridge "is currently available only with a paid Proton Mail plan", and POP3 is not
supported. Proton also documents an SMTP Submission option for business plans, which
is send-only.

So there is no `imap.proton.me` for this connector to reach, and no credential that
would work against one. The one configuration that *could* work is an operator
running Bridge on the same host as the connector and pointing a mailbox at Bridge's
local IMAP and SMTP listeners with Bridge's own generated credentials — which is
precisely the case for calling this out at lookup rather than blocking the save. An
operator who knows they have a Bridge is not stopped.

- <https://proton.me/support/imap-smtp-and-pop3-setup>

---

## Where this page could not answer

Recorded rather than guessed, because the absence is itself an input to
[#148](https://github.com/YannicHock/claude-mail-mcp/issues/148) and
[#151](https://github.com/YannicHock/claude-mail-mcp/issues/151):

- **Gmail app-password formatting.** That Google displays the 16 characters as four
  groups of four, and that the spaces must be stripped before pasting, is not in
  Google's current documentation — it says "16-digit passcode" and stops. Widely
  reported, not verifiable here, so no `credentialNote` asserts it. (Zoho *does*
  document the equivalent instruction, and Zoho's note carries it.)
- **Gmail's IMAP on/off switch.** Not an unknown but a **correction**: Google
  documents that since January 2025 there is no such switch and IMAP is always on.
  Any note telling a Gmail operator to go and enable IMAP would send them looking for
  a setting that no longer exists.
- **Posteo and the account password.** Posteo documents the app password as what to
  enter; it does not document whether the account password is refused. The note says
  the first and not the second.
- **Yahoo/AOL and 2FA.** Neither documents two-step verification as a precondition
  for app passwords, so neither is placed in the conditional group — but neither
  states outright that the *account* password is refused either. What is documented
  is that third-party apps not using the branded sign-in page require an app
  password, and that is what the note says.
- **Microsoft SMTP AUTH.** The basic-auth retirement for SMTP AUTH runs on a
  separately published timeline that this page does not restate, since it does not
  change the answer for a connector that needs IMAP.

## Adding a provider

Same standard as the hosts and ports it sits next to. Read the provider's **own
current** documentation, put the URL in the entry, and if the documentation does not
answer the question, leave the note out. A provider with no verifiable note simply
has none — the field is optional, and an entry without one is valid.

Decide which table it belongs in, and it may be both. A `MAIL_PROVIDERS` preset
needs documented hosts and ports that are the same for every customer of that
provider; anything less than that is a wrong preset, which is worse than none. A
`PROVIDER_ADVICE` entry needs domains its customers' addresses actually end in —
keep that list short, because a domain missing from it costs an operator a
sentence, while a domain wrongly in it tells them something untrue. `credentialNote`
and `unsupported` are mutually exclusive in practice: a provider that cannot be
served has no app password to recommend.
