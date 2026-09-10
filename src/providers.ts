/**
 * Tier 2 of the address-first cascade: a short list of providers whose settings
 * are known, so that a domain with no autoconfig document still does not send
 * the operator straight to eighteen empty boxes.
 *
 * ## Why this table is in the connector
 *
 * It was in the OAuth layer until #141, next to the setup wizard that was its
 * only reader, and the argument for that was that the connector would never read
 * it: what the connector receives is a `MailboxDraft` with concrete values in
 * it, and it has no opinion about which of them came from a table.
 *
 * That premise is what #141 removed. The connector's own *Add mailbox* page now
 * offers the same cascade — it is where every mailbox after the first is added,
 * which is the mailbox an operator is *least* likely to know the settings for —
 * so there are two readers, one in each package.
 *
 * The reflex answer was to mirror the file and add a fourth drift test. #126 is
 * the argument against it: six cross-package duplicates protected four different
 * ways, applied when a wave notices a shared rule and absent when it does not.
 * So the table moved to the reader that can hold it *locally* — this one, where
 * the settings UI calls {@link prefillFor} as a function — and the wizard reads
 * the list over the same JSON surface it already uses for the probe, the write,
 * the accounts stamp and the autoconfig lookup. `POST /settings/providers` in
 * settings-routes.ts is that answer; `ProviderPreset` in settings-api.ts is its
 * shape, and settings-api.ts is the module that already exists for exactly this
 * kind of cross-package agreement — mirrored in both packages when this was
 * written, and one shared/settings-api.ts since #126.
 *
 * What this table does *not* get to do is invent a second vocabulary: every
 * entry is turned into the `MAILBOX_FIELDS` names by {@link prefillFor} before
 * it reaches a form or the wire, so a field renamed in the shared contract still
 * breaks this file at compile time.
 *
 * ## Every entry is verified, or absent
 *
 * A wrong preset is worse than no preset: it produces an authentication failure
 * that looks like a wrong password, on a screen the operator has no reason to
 * distrust. Each entry below carries the provider's own documentation URL that
 * its values were read off, and anything that documentation did not state is not
 * here — no CalDAV URL guessed from a pattern, no STARTTLS port inferred from
 * the fact that most providers have one. A short list that is right beats a long
 * one that is nearly right.
 *
 * The table is in code rather than fetched: deterministic, testable offline, and
 * it cannot fail halfway through somebody's setup.
 */

import {
  CHECKBOX_ON,
  domainOf,
  MAILBOX_FIELDS,
  type ProviderPreset,
} from "../shared/settings-api.js";

/**
 * The placeholders an entry may carry in a host or a URL, filled in from the
 * address the operator typed.
 *
 * Two of the entries need them for different reasons. A self-hosted stack has no
 * fixed hostname — each deployment picks its own — so mailcow's entry carries
 * the ports, the TLS mode and the `mail.<domain>` shape its own documentation
 * uses in its examples, and the operator corrects the host on the next screen,
 * which is where they would have had to type it anyway. Posteo's CalDAV URL, by
 * contrast, is exact and documented, and simply has the mailbox's own name in
 * the middle of it — lowercased, which their documentation is explicit about.
 */
export const DOMAIN_PLACEHOLDER = "%DOMAIN%";
/** The part before the `@`, lowercased. */
export const LOCALPART_PLACEHOLDER = "%LOCALPART%";
/** The whole address. */
export const EMAIL_PLACEHOLDER = "%EMAIL%";

/** How a provider says to spell the login name. */
export type LoginName =
  /** The whole address, `anna@example.com`. The common case. */
  | "address"
  /** The part before the `@`. iCloud's IMAP login, and almost nothing else. */
  | "localpart";

export interface ProviderServer {
  /** A hostname, or one containing {@link DOMAIN_PLACEHOLDER}. */
  host: string;
  port: number;
  /** Implicit TLS from the first byte. STARTTLS is `false`, as `imap.tls` means. */
  tls: boolean;
  user: LoginName;
}

export interface MailProvider {
  /** Stable, and what the radio submits. Not shown. */
  id: string;
  label: string;
  imap: ProviderServer;
  smtp: ProviderServer;
  /** null when the provider's documentation states no CalDAV endpoint. */
  caldav: { url: string; user: LoginName } | null;
  /**
   * What the operator has to know before this preset can work — an app-specific
   * password, a login that is not the address, a host they still have to supply.
   * Shown next to the choice. Empty when there is nothing to say.
   */
  note: string;
  /** The documentation these values were read off, for whoever checks them next. */
  source: string;
}

/**
 * The list, in the order it is shown.
 *
 * Hetzner is here deliberately: it is where this project is deployed and a
 * likely provider for someone who found it there.
 */
export const MAIL_PROVIDERS: readonly MailProvider[] = [
  {
    id: "gmail",
    label: "Gmail",
    // Added by #150. The connection settings were never Gmail's problem — the
    // first multi-account deployment's autoconfig lookup found these on its own
    // — but an operator who reaches tier 2 because their lookup was blocked or
    // slow should not scroll a list of eight and conclude Gmail is unsupported.
    imap: { host: "imap.gmail.com", port: 993, tls: true, user: "address" },
    // 587/STARTTLS, which is what Google's own client-setup table gives; it
    // names 465/SSL only as the alternative if you change the encryption type.
    // The documented preference wins, as it does for Hetzner.
    smtp: { host: "smtp.gmail.com", port: 587, tls: false, user: "address" },
    // Google's CalDAV endpoint exists but is an OAuth-only API surface, and
    // this connector sends a password. A URL that cannot authenticate is worse
    // than no URL.
    caldav: null,
    note:
      "With 2-Step Verification on, Gmail needs an app password rather than your Google " +
      "password. IMAP itself is always on — the switch for it was removed in 2025.",
    source:
      "https://knowledge.workspace.google.com/admin/sync/set-up-gmail-with-a-third-party-email-client",
  },
  {
    id: "mailbox-org",
    label: "mailbox.org",
    imap: { host: "imap.mailbox.org", port: 993, tls: true, user: "address" },
    smtp: { host: "smtp.mailbox.org", port: 465, tls: true, user: "address" },
    caldav: { url: "https://dav.mailbox.org/", user: "address" },
    note:
      "Log in with your main address, not an alias. External calendar access needs an " +
      "app password, and so does mail if you have two-factor authentication on.",
    source: "https://kb.mailbox.org/en/private/e-mail/e-mail-configuration/",
  },
  {
    id: "fastmail",
    label: "Fastmail",
    imap: { host: "imap.fastmail.com", port: 993, tls: true, user: "address" },
    smtp: { host: "smtp.fastmail.com", port: 465, tls: true, user: "address" },
    caldav: { url: "https://caldav.fastmail.com/", user: "address" },
    note:
      "Your normal Fastmail password will not work: create an app password, and give it " +
      "both mail and calendar access.",
    source: "https://www.fastmail.help/hc/en-us/articles/1500000278342-Server-names-and-ports",
  },
  {
    id: "icloud",
    label: "iCloud Mail",
    // The one asymmetric entry in the table, and the reason `user` is a field
    // rather than an assumption. Apple documents the IMAP login as the part
    // before the @ and the SMTP login as the whole address, which a single
    // "username" box would get wrong for every iCloud operator.
    imap: { host: "imap.mail.me.com", port: 993, tls: true, user: "localpart" },
    // 587 with STARTTLS, which is what Apple documents. Apple never states an
    // implicit-TLS port for iCloud submission, so this table does not either.
    smtp: { host: "smtp.mail.me.com", port: 587, tls: false, user: "address" },
    // Apple's own server-settings article gives no CalDAV address, and the
    // per-account `pXX-caldav.icloud.com` hosts that circulate are not in any
    // Apple document. Left out rather than guessed at.
    caldav: null,
    // Reworded by #150. "Needs an app-specific password, which needs two-factor
    // authentication" read as a condition — do the 2FA and then you need one —
    // when it is not one: 2FA is the default on current Apple Accounts and
    // cannot be removed, so there is no configuration in which the account
    // password is the right credential. See docs/PROVIDERS.md.
    note:
      "Always needs an app-specific password, never your Apple Account password. The IMAP " +
      "username is the part before the @; the SMTP username is the whole address.",
    source: "https://support.apple.com/en-us/102525",
  },
  {
    id: "migadu",
    label: "Migadu",
    imap: { host: "imap.migadu.com", port: 993, tls: true, user: "address" },
    smtp: { host: "smtp.migadu.com", port: 465, tls: true, user: "address" },
    caldav: { url: "https://cdav.migadu.com/", user: "address" },
    note: "The hosts are the same whatever your own domain is. Use the mailbox password.",
    source: "https://www.migadu.com/support/",
  },
  {
    id: "posteo",
    label: "Posteo",
    // `posteo.de` for every customer, including the ones whose address ends
    // .com or .net — their help page answers that question explicitly.
    imap: { host: "posteo.de", port: 993, tls: true, user: "address" },
    smtp: { host: "posteo.de", port: 465, tls: true, user: "address" },
    // Port 8443, not 443, and the path carries the local part rather than the
    // whole address. Both are exactly as documented; either one guessed the
    // ordinary way produces a CalDAV URL that does not answer.
    caldav: { url: `https://posteo.de:8443/calendars/${LOCALPART_PLACEHOLDER}/default`, user: "address" },
    note:
      "The server is posteo.de whatever your address ends in. Posteo wants an app password " +
      "rather than your account password.",
    source:
      "https://posteo.de/en/help/how-do-i-set-up-posteo-in-an-email-client-pop3-imap-and-smtp",
  },
  {
    id: "hetzner-webhosting",
    label: "Hetzner Web Hosting / Managed Server",
    // The hostname really is this literal string for every customer — Hetzner's
    // own page says "(literally!)" twice, which is what stops this entry from
    // templating the operator's domain into it the way a reader would expect.
    imap: { host: "mail.your-server.de", port: 993, tls: true, user: "address" },
    // 587/STARTTLS rather than 465, because Hetzner recommends it in the same
    // table it lists 465 in. Both work; the documented preference wins.
    smtp: { host: "mail.your-server.de", port: 587, tls: false, user: "address" },
    // Hetzner deliberately publishes no CalDAV URL pattern: the address is
    // per-calendar and has to be copied out of Webmail. Nothing to preset.
    caldav: null,
    note:
      "The server is literally mail.your-server.de, not your own domain. This is the " +
      "web hosting mail service — Hetzner Cloud has no mailboxes.",
    source: "https://docs.hetzner.com/konsoleh/account-management/email/setting-up-an-email-account/",
  },
  {
    id: "mailcow",
    label: "mailcow (self-hosted)",
    imap: { host: `mail.${DOMAIN_PLACEHOLDER}`, port: 993, tls: true, user: "address" },
    smtp: { host: `mail.${DOMAIN_PLACEHOLDER}`, port: 465, tls: true, user: "address" },
    caldav: {
      url: `https://mail.${DOMAIN_PLACEHOLDER}/SOGo/dav/${EMAIL_PLACEHOLDER}/Calendar/personal/`,
      user: "address",
    },
    // The app-password sentence is here rather than in PROVIDER_ADVICE because
    // mailcow is self-hosted: its mailboxes are on the operator's own domain,
    // so no domain match can ever recognise one. This screen is the only place
    // that knows it is mailcow, so this is the only place the rule can be said.
    note:
      "The ports are mailcow's defaults; the host is a guess from your domain, since it is " +
      "whatever FQDN the server was installed under. Check it on the next screen. A " +
      "mailbox with two-factor authentication on needs an app password.",
    source: "https://docs.mailcow.email/client/client-manual/",
  },
  {
    id: "iredmail",
    label: "iRedMail (self-hosted)",
    // No host, on purpose. iRedMail requires an FQDN and its own examples use
    // `mx.example.com`; `mail.<domain>` is a convention the project does not
    // have, and an empty required box is a better prompt than a wrong guess.
    imap: { host: "", port: 993, tls: true, user: "address" },
    // 587/STARTTLS only. iRedMail's ports page lists 25 and 587 for Postfix and
    // says port 465 "has been deprecated for years"; it is not documented as
    // open, so it is not offered here.
    smtp: { host: "", port: 587, tls: false, user: "address" },
    // CalDAV comes from SOGo, which is optional at install time — an operator
    // who chose Roundcube has none. A URL that is right only sometimes is one
    // more thing to debug, so this entry presets mail and leaves calendars
    // to the full form.
    caldav: null,
    note:
      "iRedMail has no standard hostname — type your own server's. Login is the full " +
      "email address. Calendars only exist if SOGo was installed.",
    source: "https://docs.iredmail.org/network.ports.html",
  },
  // Nextcloud is not in this table, and was in the design sketch. It runs no
  // IMAP or SMTP server at all — its Mail app is a client that connects to
  // somebody else's — so every mail field an entry for it could carry would be
  // wrong by construction. Its CalDAV URL is real and stable
  // (`<instance>/remote.php/dav`), and belongs wherever calendars are set up on
  // their own, not on a screen whose output is a mailbox.
];

/** Looked up by what the provider radio submitted. */
export function findProvider(id: string): MailProvider | null {
  return MAIL_PROVIDERS.find((provider) => provider.id === id) ?? null;
}

function localPartOf(email: string): string {
  const at = email.lastIndexOf("@");
  return at <= 0 ? email : email.slice(0, at);
}

/**
 * Fill a template's placeholders from the address.
 *
 * A template that still has a placeholder left in it renders as the empty
 * string rather than as itself: an empty required box is a prompt, and
 * `mail.%DOMAIN%` is a puzzle. That happens only for an address this function
 * could not split, which the screen before this one has already refused.
 */
export function fillTemplate(template: string, email: string): string {
  const domain = domainOf(email);
  // An address this could not split has no domain and no meaningful local part,
  // so a template that wants either of them has nothing to become. Substituting
  // the empty string would leave `mail.` in a required box, which looks like a
  // value and is not one.
  const substitutions: Array<[string, string]> = [
    [EMAIL_PLACEHOLDER, email],
    [LOCALPART_PLACEHOLDER, localPartOf(email).toLowerCase()],
    [DOMAIN_PLACEHOLDER, domain],
  ];

  let filled = template;
  for (const [placeholder, value] of substitutions) {
    if (!filled.includes(placeholder)) continue;
    if (value === "" || domain === "") return "";
    filled = filled.replaceAll(placeholder, value);
  }
  return filled;
}

function loginFor(name: LoginName, email: string): string {
  return name === "localpart" ? localPartOf(email) : email;
}

/**
 * One provider plus one address, as values for the full mailbox form.
 *
 * Keyed by `MAILBOX_FIELDS`, because that is what the form renders and what the
 * connector's parser reads — this table never gets to name a field itself.
 *
 * No password is filled in, at any depth. Nothing in this file has one, and the
 * form's password boxes are the only place a mailbox password is ever typed.
 */
export function prefillFor(provider: MailProvider, email: string): Record<string, string> {
  const values: Record<string, string> = {
    [MAILBOX_FIELDS.mailDefaultFrom]: email,
    [MAILBOX_FIELDS.imapHost]: fillTemplate(provider.imap.host, email),
    [MAILBOX_FIELDS.imapPort]: String(provider.imap.port),
    [MAILBOX_FIELDS.imapUser]: loginFor(provider.imap.user, email),
    [MAILBOX_FIELDS.imapTls]: provider.imap.tls ? CHECKBOX_ON : "",
    [MAILBOX_FIELDS.smtpHost]: fillTemplate(provider.smtp.host, email),
    [MAILBOX_FIELDS.smtpPort]: String(provider.smtp.port),
    [MAILBOX_FIELDS.smtpUser]: loginFor(provider.smtp.user, email),
    [MAILBOX_FIELDS.smtpTls]: provider.smtp.tls ? CHECKBOX_ON : "",
  };
  if (provider.caldav !== null) {
    values[MAILBOX_FIELDS.caldavUrl] = fillTemplate(provider.caldav.url, email);
    values[MAILBOX_FIELDS.caldavUser] = loginFor(provider.caldav.user, email);
  }
  return values;
}

/**
 * The whole table, as the answer both readers work from.
 *
 * The values are resolved here rather than by whoever renders them, so no caller
 * ever meets {@link DOMAIN_PLACEHOLDER} or has to know that iCloud's IMAP login
 * is not its SMTP one. That is what makes the wire answer and the settings UI's
 * local call the same thing: one is `JSON.stringify` of the other, and there is
 * no second code path for the wizard to be subtly wrong on.
 *
 * `source` is deliberately absent from it. That is the documentation URL each
 * entry was verified against — for whoever checks the table next, not for the
 * operator — and nothing renders it, so nothing sends it.
 */
export function providerPresets(email: string): ProviderPreset[] {
  return MAIL_PROVIDERS.map((provider) => ({
    id: provider.id,
    label: provider.label,
    note: provider.note,
    values: prefillFor(provider, email),
  }));
}

// ---- What the password has to be, and where no password will do -------------
//
// #148 and #151. Both are advice keyed by the **address's domain** rather than
// by a chosen preset, because both are shown at a moment when nothing has been
// chosen: #151 renders when the operator's address has just been looked up, and
// #148 renders when a server has just refused the password behind that address.
// Neither moment carries a provider id.
//
// That is why this is a second table rather than two more fields on
// {@link MailProvider}. The two sets are genuinely different:
//
//   - Some entries here have no preset and must not gain one. Gmail does — its
//     hosts are documented — but Zoho's IMAP host depends on whether the
//     account is personal or domain-based, Yahoo and AOL are one platform under
//     two names, and Microsoft and Proton have nothing this connector can dial.
//     Shipping a preset for those just to hang a note off would put a
//     possibly-wrong host in a required box, which is what this file's header
//     forbids.
//   - Some presets have no advice entry and cannot have one. mailcow and
//     iRedMail are self-hosted, and Migadu and Hetzner customers use their own
//     domains, so there is no domain to recognise any of them by. mailcow's
//     documented app-password rule is therefore carried by its `note`, on the
//     screen where the operator picks it — the only screen that knows it is
//     mailcow.
//
// Everything below is verified against the provider's own current
// documentation, the same standard the presets are held to; the quotations and
// the reasoning are in `docs/PROVIDERS.md`. What is *not* verifiable is not
// here: no note describes Gmail's app password as four groups of four, and none
// tells a Gmail operator to switch IMAP on, because Google removed that switch
// in January 2025 and the advice would send them looking for it.

/**
 * One provider, recognised by the domains its customers' addresses end in.
 *
 * Both message fields are optional, an entry may carry either, and an absence
 * is a finding rather than a gap: a provider whose documentation does not
 * answer the question gets no sentence here.
 */
export interface ProviderAdvice {
  /** Stable; equal to a {@link MailProvider} id when there is a preset too. */
  id: string;
  label: string;
  /**
   * The address domains this entry is recognised by, lowercase and matched
   * whole. Deliberately short: a domain missing from this list costs an
   * operator a sentence they would not otherwise have had, while a domain
   * wrongly in it tells them something untrue about their own provider. Only
   * the first of those is acceptable.
   */
  domains: readonly string[];
  /**
   * #148 — shown **only** when a probe classified the failure as a credential
   * rejection, never on a connectivity failure. It answers "the server refused
   * my password, why?", which is a question nobody is asking until a server has
   * actually refused one.
   */
  credentialNote?: string;
  /**
   * #151 — shown at address lookup, as soon as the domain is known. Its
   * presence means no password this connector can send will be accepted.
   *
   * It warns and does not block. Proton's "no" has one working configuration
   * behind it — a local Proton Mail Bridge — and refusing the save would lock
   * out the operator who has one.
   */
  unsupported?: string;
  /** The documentation this entry was read off, for whoever checks it next. */
  source: string;
}

/** The advice table. The order is for reading; nothing renders the list. */
export const PROVIDER_ADVICE: readonly ProviderAdvice[] = [
  {
    id: "gmail",
    label: "Gmail",
    domains: ["gmail.com", "googlemail.com"],
    credentialNote:
      "With 2-Step Verification on, Gmail takes an app password over IMAP rather than " +
      "your Google password: a 16-digit passcode created at myaccount.google.com under " +
      "Security → App passwords. IMAP itself is always on and has had no switch since " +
      "January 2025, so there is no setting to go and enable.",
    source: "https://support.google.com/accounts/answer/185833",
  },
  {
    id: "mailbox-org",
    label: "mailbox.org",
    domains: ["mailbox.org"],
    credentialNote:
      "With two-factor authentication on, mailbox.org needs an app password for external " +
      "programmes rather than your mailbox password. Log in with your main address, not " +
      "an alias.",
    source: "https://kb.mailbox.org/en/private/e-mail/e-mail-configuration/",
  },
  {
    id: "zoho",
    label: "Zoho Mail",
    // Personal accounts only. A Zoho business account is on the customer's own
    // domain, which nothing here can recognise — and which is also why Zoho has
    // no preset: the IMAP host differs between the two kinds of account.
    domains: ["zoho.com", "zohomail.com"],
    credentialNote:
      "With two-factor authentication on, Zoho takes a 12-digit application-specific " +
      "password instead of your regular one, and it has to be entered without any " +
      "spaces. Zoho's application-specific passwords do not expire.",
    source: "https://www.zoho.com/mail/help/imap-access.html",
  },
  {
    id: "fastmail",
    label: "Fastmail",
    // fastmail.com only. Fastmail sells addresses on many domains and its
    // customers bring their own; the ones this misses simply get no sentence.
    domains: ["fastmail.com"],
    credentialNote:
      "Your regular Fastmail password never works here, with two-step verification on or " +
      "off: every third-party program needs its own app password. Create one and give it " +
      "both mail and calendar access.",
    source: "https://www.fastmail.help/hc/en-us/articles/360058752854-App-passwords",
  },
  {
    id: "icloud",
    label: "iCloud Mail",
    domains: ["icloud.com", "me.com", "mac.com"],
    credentialNote:
      "iCloud always needs an app-specific password here, never your Apple Account " +
      "password. Generating one needs two-factor authentication, which is the default on " +
      "current Apple Accounts and cannot be removed. The IMAP username is the part " +
      "before the @; the SMTP username is the whole address.",
    source: "https://support.apple.com/en-us/102654",
  },
  {
    id: "yahoo",
    label: "Yahoo Mail",
    domains: ["yahoo.com", "ymail.com", "rocketmail.com"],
    credentialNote:
      "Yahoo requires an app password for any app that does not use its own sign-in page, " +
      "whether or not two-step verification is on. Create one on the Yahoo account " +
      "security page under External connections. Yahoo can refuse to create one from a " +
      "browser session it does not recognise.",
    source: "https://help.yahoo.com/kb/SLN15241.html",
  },
  {
    id: "aol",
    label: "AOL Mail",
    domains: ["aol.com"],
    credentialNote:
      "AOL requires an app password for any app that does not use its own sign-in page, " +
      "whether or not two-step verification is on. Create one on the AOL account " +
      "security page.",
    source: "https://help.aol.com/articles/create-and-manage-app-password",
  },
  {
    id: "posteo",
    label: "Posteo",
    domains: ["posteo.de", "posteo.net"],
    // What Posteo *tells you to use*, which is documented, rather than what
    // Posteo refuses, which is not. See docs/PROVIDERS.md.
    credentialNote:
      "Posteo tells you to use an app password for both servers — including the outgoing " +
      "one, even where your client calls its authentication optional. You can hold up to " +
      "five at a time.",
    source: "https://posteo.de/en/help/app-passwords",
  },
  {
    id: "microsoft",
    label: "Outlook.com and Microsoft 365",
    domains: ["outlook.com", "hotmail.com", "live.com", "msn.com"],
    unsupported:
      "Microsoft has removed password authentication for IMAP and says it cannot be " +
      "switched back on — for Microsoft 365 tenants, and for outlook.com, hotmail.com, " +
      "live.com and msn.com since 16 September 2024. IMAP now requires OAuth 2.0, which " +
      "this connector does not speak, and there is no app password that gets around it. " +
      "You can carry on, but no password will connect.",
    source:
      "https://learn.microsoft.com/en-us/exchange/clients-and-mobile-in-exchange-online/deprecation-of-basic-authentication-exchange-online",
  },
  {
    id: "proton",
    label: "Proton Mail",
    domains: ["proton.me", "protonmail.com", "protonmail.ch", "pm.me"],
    unsupported:
      "Proton's servers answer no IMAP or SMTP from the internet: a desktop client " +
      "reaches Proton through Proton Mail Bridge, which runs on your own machine and " +
      "needs a paid plan. If you are running Bridge, carry on — point this mailbox at " +
      "Bridge's own local IMAP and SMTP addresses with the credentials Bridge generated, " +
      "which is a configuration that works. Without Bridge, no password will connect.",
    source: "https://proton.me/support/imap-smtp-and-pop3-setup",
  },
];

/**
 * The entry an address's domain matches, or null.
 *
 * Exact, lowercased, whole-domain. A subdomain is somebody else's mail system
 * often enough that reading `gmail.com.example.org` as Gmail would be a lie
 * told confidently, and an address this cannot split matches nothing at all.
 */
export function adviceForAddress(email: string): ProviderAdvice | null {
  const domain = domainOf(email).toLowerCase();
  if (domain === "") return null;
  return PROVIDER_ADVICE.find((entry) => entry.domains.includes(domain)) ?? null;
}

/**
 * #148, as the one thing a render site needs: the sentence, or null.
 *
 * Null for a domain the table does not know, for a known domain whose entry has
 * no note, and for an address with no domain in it. Every caller renders
 * nothing for null, which is what makes the field optional and what keeps
 * adding a provider without a note valid.
 *
 * **This does not decide *whether* to show it.** That is the caller's, and the
 * rule is one line long: only on a classified credential rejection, never on a
 * connectivity failure. Deciding it in here would make it possible to call this
 * with an error nobody classified, which is the mistake #146 exists to prevent.
 */
export function credentialNoteFor(email: string): string | null {
  return adviceForAddress(email)?.credentialNote ?? null;
}

/** #151: what to say at address lookup, or null when there is nothing to say. */
export function unsupportedNoticeFor(email: string): string | null {
  return adviceForAddress(email)?.unsupported ?? null;
}
