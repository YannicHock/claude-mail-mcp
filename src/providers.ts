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
    note:
      "Needs an app-specific password, which needs two-factor authentication. The IMAP " +
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
    note:
      "The ports are mailcow's defaults; the host is a guess from your domain, since it is " +
      "whatever FQDN the server was installed under. Check it on the next screen.",
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
