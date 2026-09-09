/**
 * The JSON shape of the connector's mailbox operations — probe a candidate
 * mailbox, and write one — and the field vocabulary both of them speak.
 *
 * This file is the setup wizard's copy. `src/settings-api.ts` in the connector
 * is the other, and the two are identical below this comment; the drift test in
 * the connector's test/unit/settings-api.test.ts fails if they part company,
 * the same way secrets.test.ts pins the two copies of secrets.ts. The packages
 * have separate Docker build contexts and cannot import from one another, so a
 * mirrored module is the closest thing to a shared one they can have — and
 * unlike the HTML readers it replaced (#69), a mirrored module is compared by a
 * test rather than by a comment saying "change one, change both".
 *
 * Nothing here does any I/O, imports anything, or validates a mailbox. It is
 * types, one table of names, the translation between the nested document on the
 * wire and the flat form body the connector's parser reads, and a set of total,
 * fail-closed readers for the answers.
 */

// ---- The field vocabulary --------------------------------------------------

/**
 * Every name a mailbox field goes by on the wire, spelled once.
 *
 * The values are dotted paths into {@link MailboxDraft}, and that is not a
 * coincidence: they are the names the connector's own mailbox form has always
 * used, and {@link flattenDraft} and {@link draftFromFields} are the two halves
 * of the translation between the flat form and the nested document.
 *
 * Nothing in either package may spell one of these as a literal. The connector's
 * form renders them, its parser reads them, the wizard's form renders them and
 * its client builds a draft out of them — four places that used to agree by
 * hand, and where disagreeing was silent: a field the other side did not know
 * about simply went missing, and the connector then reported "Required." for a
 * box the operator had filled in.
 */
export const MAILBOX_FIELDS = {
  id: "id",
  label: "label",
  isDefault: "default",
  imapHost: "imap.host",
  imapPort: "imap.port",
  imapUser: "imap.user",
  imapPass: "imap.pass",
  imapTls: "imap.tls",
  smtpHost: "smtp.host",
  smtpPort: "smtp.port",
  smtpUser: "smtp.user",
  smtpPass: "smtp.pass",
  smtpTls: "smtp.tls",
  mailDefaultFrom: "mail.defaultFrom",
  mailDefaultFromName: "mail.defaultFromName",
  mailDraftsFolder: "mail.draftsFolder",
  mailSentFolder: "mail.sentFolder",
  caldavUrl: "caldav.url",
  caldavUser: "caldav.user",
  caldavPass: "caldav.pass",
} as const;

export type MailboxFieldName = (typeof MAILBOX_FIELDS)[keyof typeof MAILBOX_FIELDS];

/** The same names as a list, for the tests that pin a form against them. */
export const MAILBOX_FIELD_NAMES: readonly MailboxFieldName[] = Object.values(MAILBOX_FIELDS);

/** Never echoed back into a page, never logged, on either side of the hop. */
export const MAILBOX_SECRET_FIELDS: readonly MailboxFieldName[] = [
  MAILBOX_FIELDS.imapPass,
  MAILBOX_FIELDS.smtpPass,
  MAILBOX_FIELDS.caldavPass,
];

/** What a ticked checkbox submits, which is also what the connector reads. */
export const CHECKBOX_ON = "1";

// ---- The draft -------------------------------------------------------------

/**
 * One mail or calendar server, as the operator typed it.
 *
 * `port` is a string, deliberately. A draft is a *submission*, not an account:
 * every scalar here is exactly what came out of a form box, and the connector's
 * `parseAccountForm` is the only thing that decides whether "993" is a port.
 * Parsing it on the way in would make the caller a second opinion on that, and a
 * second opinion is what this module exists to remove — an operator who types
 * "nine hundred and ninety three" must get the connector's own message about it,
 * not a client-side guess at one.
 */
export interface MailboxServerDraft {
  host: string;
  port: string;
  user: string;
  pass: string;
  tls: boolean;
}

export interface MailboxCalDavDraft {
  url: string;
  user: string;
  pass: string;
}

export interface MailboxMailDraft {
  defaultFrom: string;
  defaultFromName?: string;
  draftsFolder?: string;
  sentFolder?: string;
}

/**
 * A candidate mailbox: what to probe, and what to store once the probe holds.
 *
 * The whole vocabulary of the mailbox operations, in one type. A field renamed
 * here stops compiling in {@link flattenDraft} and {@link draftFromFields}
 * immediately, in both packages, which is the point of it being a type at all.
 */
export interface MailboxDraft {
  id: string;
  label: string;
  /** Make this the account the mail tools reach for when none is named. */
  default: boolean;
  mail: MailboxMailDraft;
  imap: MailboxServerDraft;
  smtp: MailboxServerDraft;
  /** null when the operator left every CalDAV box empty: mail only. */
  caldav: MailboxCalDavDraft | null;
}

/**
 * A draft, flattened onto the field names the connector's form parser reads.
 *
 * Every name is present, including the ones a caller left out — a blank string
 * is what an untouched form box submits, and `parseAccountForm` already has a
 * rule for each of them (a blank drafts folder is "Drafts", a blank sent folder
 * is none, a blank password on create is an error). The exception is CalDAV,
 * whose three names are omitted entirely when there is no CalDAV block, because
 * that is what a form with nothing typed into it sends.
 */
export function flattenDraft(draft: MailboxDraft): Record<string, string> {
  const fields: Record<string, string> = {
    [MAILBOX_FIELDS.id]: draft.id,
    [MAILBOX_FIELDS.label]: draft.label,
    [MAILBOX_FIELDS.isDefault]: draft.default ? CHECKBOX_ON : "",
    [MAILBOX_FIELDS.mailDefaultFrom]: draft.mail.defaultFrom,
    [MAILBOX_FIELDS.mailDefaultFromName]: draft.mail.defaultFromName ?? "",
    [MAILBOX_FIELDS.mailDraftsFolder]: draft.mail.draftsFolder ?? "",
    [MAILBOX_FIELDS.mailSentFolder]: draft.mail.sentFolder ?? "",
    [MAILBOX_FIELDS.imapHost]: draft.imap.host,
    [MAILBOX_FIELDS.imapPort]: draft.imap.port,
    [MAILBOX_FIELDS.imapUser]: draft.imap.user,
    [MAILBOX_FIELDS.imapPass]: draft.imap.pass,
    [MAILBOX_FIELDS.imapTls]: draft.imap.tls ? CHECKBOX_ON : "",
    [MAILBOX_FIELDS.smtpHost]: draft.smtp.host,
    [MAILBOX_FIELDS.smtpPort]: draft.smtp.port,
    [MAILBOX_FIELDS.smtpUser]: draft.smtp.user,
    [MAILBOX_FIELDS.smtpPass]: draft.smtp.pass,
    [MAILBOX_FIELDS.smtpTls]: draft.smtp.tls ? CHECKBOX_ON : "",
  };
  if (draft.caldav !== null) {
    fields[MAILBOX_FIELDS.caldavUrl] = draft.caldav.url;
    fields[MAILBOX_FIELDS.caldavUser] = draft.caldav.user;
    fields[MAILBOX_FIELDS.caldavPass] = draft.caldav.pass;
  }
  return fields;
}

/**
 * The inverse: a submitted form body, read into a draft.
 *
 * Anything that is not a string is read as absent, which is what a repeated or
 * missing field arrives as. A CalDAV block appears as soon as any one of its
 * three boxes has something in it — not only the URL — so that a half-filled
 * CalDAV section comes back to the operator with what they typed still in it.
 */
export function draftFromFields(fields: Record<string, unknown>): MailboxDraft {
  const text = (name: MailboxFieldName): string => {
    const value = fields[name];
    return typeof value === "string" ? value : "";
  };
  const flag = (name: MailboxFieldName): boolean => text(name) === CHECKBOX_ON;

  const caldav: MailboxCalDavDraft = {
    url: text(MAILBOX_FIELDS.caldavUrl),
    user: text(MAILBOX_FIELDS.caldavUser),
    pass: text(MAILBOX_FIELDS.caldavPass),
  };

  return {
    id: text(MAILBOX_FIELDS.id),
    label: text(MAILBOX_FIELDS.label),
    default: flag(MAILBOX_FIELDS.isDefault),
    mail: {
      defaultFrom: text(MAILBOX_FIELDS.mailDefaultFrom),
      defaultFromName: text(MAILBOX_FIELDS.mailDefaultFromName),
      draftsFolder: text(MAILBOX_FIELDS.mailDraftsFolder),
      sentFolder: text(MAILBOX_FIELDS.mailSentFolder),
    },
    imap: {
      host: text(MAILBOX_FIELDS.imapHost),
      port: text(MAILBOX_FIELDS.imapPort),
      user: text(MAILBOX_FIELDS.imapUser),
      pass: text(MAILBOX_FIELDS.imapPass),
      tls: flag(MAILBOX_FIELDS.imapTls),
    },
    smtp: {
      host: text(MAILBOX_FIELDS.smtpHost),
      port: text(MAILBOX_FIELDS.smtpPort),
      user: text(MAILBOX_FIELDS.smtpUser),
      pass: text(MAILBOX_FIELDS.smtpPass),
      tls: flag(MAILBOX_FIELDS.smtpTls),
    },
    caldav: caldav.url === "" && caldav.user === "" && caldav.pass === "" ? null : caldav,
  };
}

// ---- The request envelope --------------------------------------------------

/**
 * What a JSON caller posts to `/settings/mailboxes` and `/settings/mailboxes/test`.
 *
 * `_csrf` and `_stamp` keep the names and the meanings the form has always given
 * them, so the connector's CSRF guard and its optimistic-concurrency check are
 * literally the same code on both content types. `_csrf` is not a browser
 * defence on this hop — there is no cookie and no browser — it is the assertion's
 * own `csrf` claim handed back, which is what the connector compares it to.
 */
export interface MailboxRequestBody {
  _csrf: string;
  /** The stamp the write must still be against. Ignored by the probe route. */
  _stamp: string;
  mailbox: MailboxDraft;
}

// ---- The answers -----------------------------------------------------------

/** One service's verdict. Mirrors `ProbeResult` in the connector's probe.ts. */
export type MailboxProbeOutcome = { ok: true } | { ok: false; message: string };

/**
 * The three services, reported one by one.
 *
 * `caldav: null` is "not tested", which is what a draft with no CalDAV block
 * gets. It is not a failure, and folding it into one would tell an operator
 * their calendar is broken when they never asked for one.
 */
export interface MailboxProbeReport {
  imap: MailboxProbeOutcome;
  smtp: MailboxProbeOutcome;
  caldav: MailboxProbeOutcome | null;
}

/** 200 from `POST /settings/mailboxes/test`. Nothing was stored. */
export interface MailboxProbeAnswer {
  probe: MailboxProbeReport;
}

/** 200 from `GET /settings/mailboxes/new`: what accounts.json looks like now. */
export interface MailboxStampAnswer {
  stamp: string;
}

/** 201 from `POST /settings/mailboxes`: the account, and where the file got to. */
export interface MailboxCreatedAnswer {
  id: string;
  stamp: string;
}

/**
 * 400 or 409: nothing was stored, and here is why.
 *
 * `errors` is keyed by {@link MailboxFieldName}, so a caller can put each one
 * against the box it belongs to. `message` is for a refusal that is about the
 * request rather than about a field — a body that was not a draft at all.
 */
export interface MailboxErrorAnswer {
  message?: string;
  errors: Record<string, string>;
}

// ---- Reading them ----------------------------------------------------------
//
// Hand-rolled and total: every one of these returns null rather than throwing
// on anything it does not recognise, and the caller treats null as "no result".
// That is the same fail-closed rule the HTML readers these replaced were
// written under — an answer this build cannot read is never evidence that a
// mailbox works.

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function parseProbeOutcome(value: unknown): MailboxProbeOutcome | null {
  const obj = asObject(value);
  if (obj === null || typeof obj.ok !== "boolean") return null;
  if (obj.ok) return { ok: true };
  const message = asString(obj.message);
  return message === null ? null : { ok: false, message };
}

/** The probe answer, or null when IMAP and SMTP are not both in it. */
export function parseProbeAnswer(value: unknown): MailboxProbeReport | null {
  const body = asObject(value);
  const probe = body === null ? null : asObject(body.probe);
  if (probe === null) return null;
  const imap = parseProbeOutcome(probe.imap);
  const smtp = parseProbeOutcome(probe.smtp);
  if (imap === null || smtp === null) return null;
  // Absent and null are both "not tested". Present but unreadable is not: an
  // answer that says something about CalDAV in a form this build cannot read
  // is not one to guess at.
  if (probe.caldav === null || probe.caldav === undefined) return { imap, smtp, caldav: null };
  const caldav = parseProbeOutcome(probe.caldav);
  return caldav === null ? null : { imap, smtp, caldav };
}

export function parseStampAnswer(value: unknown): string | null {
  const body = asObject(value);
  return body === null ? null : asString(body.stamp);
}

export function parseCreatedAnswer(value: unknown): MailboxCreatedAnswer | null {
  const body = asObject(value);
  if (body === null) return null;
  const id = asString(body.id);
  const stamp = asString(body.stamp);
  return id === null || stamp === null ? null : { id, stamp };
}

/**
 * The per-field rejections out of a 400 or a 409.
 *
 * Total rather than nullable: a refusal this build cannot read is still a
 * refusal, and the caller has a message of its own for that case. Only entries
 * that are strings under known field names survive, so a connector on a
 * different release cannot put arbitrary keys into a page's error map.
 */
export function parseErrorAnswer(value: unknown): MailboxErrorAnswer {
  const body = asObject(value);
  if (body === null) return { errors: {} };
  const errors: Record<string, string> = {};
  const submitted = asObject(body.errors);
  if (submitted !== null) {
    for (const name of MAILBOX_FIELD_NAMES) {
      const message = asString(submitted[name]);
      if (message !== null) errors[name] = message;
    }
  }
  const message = asString(body.message);
  return message === null ? { errors } : { message, errors };
}

/**
 * A posted body, read into a draft.
 *
 * Structural only: it says whether this is a mailbox draft at all, never whether
 * the mailbox in it is any good. That second question has exactly one answer in
 * this project and it lives in the connector's `parseAccountForm`, which is what
 * {@link flattenDraft} hands the result to.
 */
export function parseMailboxDraft(value: unknown): MailboxDraft | null {
  const draft = asObject(value);
  if (draft === null) return null;

  const server = (raw: unknown): MailboxServerDraft | null => {
    const obj = asObject(raw);
    if (obj === null || typeof obj.tls !== "boolean") return null;
    const host = asString(obj.host);
    const port = asString(obj.port);
    const user = asString(obj.user);
    const pass = asString(obj.pass);
    if (host === null || port === null || user === null || pass === null) return null;
    return { host, port, user, pass, tls: obj.tls };
  };

  const id = asString(draft.id);
  const label = asString(draft.label);
  if (id === null || label === null || typeof draft.default !== "boolean") return null;

  const mailRaw = asObject(draft.mail);
  if (mailRaw === null) return null;
  const defaultFrom = asString(mailRaw.defaultFrom);
  if (defaultFrom === null) return null;
  const optional = (raw: unknown): string | undefined | null =>
    raw === undefined ? undefined : asString(raw);
  const defaultFromName = optional(mailRaw.defaultFromName);
  const draftsFolder = optional(mailRaw.draftsFolder);
  const sentFolder = optional(mailRaw.sentFolder);
  if (defaultFromName === null || draftsFolder === null || sentFolder === null) return null;

  const imap = server(draft.imap);
  const smtp = server(draft.smtp);
  if (imap === null || smtp === null) return null;

  let caldav: MailboxCalDavDraft | null = null;
  if (draft.caldav !== null && draft.caldav !== undefined) {
    const obj = asObject(draft.caldav);
    if (obj === null) return null;
    const url = asString(obj.url);
    const user = asString(obj.user);
    const pass = asString(obj.pass);
    if (url === null || user === null || pass === null) return null;
    caldav = { url, user, pass };
  }

  return {
    id,
    label,
    default: draft.default,
    mail: { defaultFrom, defaultFromName, draftsFolder, sentFolder },
    imap,
    smtp,
    caldav,
  };
}

// ---- The autoconfig lookup -------------------------------------------------
//
// Tier 1 of the wizard's step 2. The lookup itself lives in the connector
// (`src/autoconfig.ts`): it fetches URLs derived from what the operator typed,
// and the resolve-then-refuse rules that make that safe are the connector's to
// keep. The wizard has no business owning a second copy of them, and cannot
// import the first, so it asks over this hop the way it asks for a probe.
//
// Everything below is the *shape of the answer*, not the lookup. The connector's
// own `MailboxSuggestion` is structurally identical to the one declared here,
// which is deliberate: `settings-routes.ts` hands one straight over as the
// other, so a field that changes there stops compiling rather than going
// quietly missing on the way across.

/** An implicit-TLS socket, or a plaintext one upgraded with STARTTLS. */
export type SuggestedSocketType = "SSL" | "STARTTLS";

/**
 * One suggested server: the connectable half of a {@link MailboxServerDraft},
 * and — like {@link MailboxSuggestion} — with no password field anywhere in it.
 *
 * `port` is a number here, unlike a draft's. This is not something an operator
 * typed: it came out of a provider's own configuration document, where it was
 * already a port or was not read at all.
 */
export interface SuggestedServer {
  host: string;
  port: number;
  /** Implicit TLS from the first byte. STARTTLS is `false`, as `imap.tls` means. */
  tls: boolean;
  socketType: SuggestedSocketType;
  user: string;
}

export interface SuggestedCalDav {
  url: string;
  user: string;
  source: "well-known" | "dns-srv";
}

/** Which probe in the cascade produced the answer. */
export type SuggestionSource =
  | "autoconfig-subdomain"
  | "autoconfig-well-known"
  | "ispdb"
  | "dns-srv";

/**
 * What was found for a domain — shown to the operator for confirmation, never
 * applied on its own.
 *
 * There is no password field at any depth, on purpose: a suggestion cannot be
 * turned into a {@link MailboxDraft} without going back through a form the
 * operator has read, because the one thing a draft needs is the one thing this
 * does not carry. A wrong autoconfig answer that fails at connect time is far
 * harder to diagnose than one the operator saw first, and the shape of the type
 * is what enforces that rather than a comment asking callers to behave.
 *
 * `caldav: null` is the ordinary case, not a failure. CalDAV is optional in the
 * account model and most mail providers publish nothing for it.
 */
export interface MailboxSuggestion {
  email: string;
  domain: string;
  source: SuggestionSource;
  imap: SuggestedServer;
  smtp: SuggestedServer;
  caldav: SuggestedCalDav | null;
}

/** What the wizard posts to `/settings/autoconfig`. */
export interface AutoconfigRequestBody {
  _csrf: string;
  /** The address to look the domain up from. Nothing else is sent — no password. */
  email: string;
}

/**
 * 200 from `POST /settings/autoconfig`.
 *
 * `suggestion: null` is the only failure this route has. Every rejection inside
 * the cascade — a refused address, a redirect to plain HTTP, a timeout, a
 * document that would not parse — arrives here as the same empty answer a domain
 * with no autoconfig at all produces, because §7 of the wizard design says no
 * autoconfig failure is ever shown to the operator as an error, and an operator
 * cannot act on "the ISPDB returned 502" anyway.
 */
export interface AutoconfigAnswer {
  suggestion: MailboxSuggestion | null;
}

function parseSuggestedServer(value: unknown): SuggestedServer | null {
  const obj = asObject(value);
  if (obj === null || typeof obj.tls !== "boolean") return null;
  const host = asString(obj.host);
  const user = asString(obj.user);
  const socketType = asString(obj.socketType);
  if (host === null || user === null) return null;
  if (socketType !== "SSL" && socketType !== "STARTTLS") return null;
  const port = obj.port;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host, port, tls: obj.tls, socketType, user };
}

function parseSuggestedCalDav(value: unknown): SuggestedCalDav | null {
  const obj = asObject(value);
  if (obj === null) return null;
  const url = asString(obj.url);
  const user = asString(obj.user);
  const source = asString(obj.source);
  if (url === null || user === null) return null;
  if (source !== "well-known" && source !== "dns-srv") return null;
  return { url, user, source };
}

const SUGGESTION_SOURCES: readonly string[] = [
  "autoconfig-subdomain",
  "autoconfig-well-known",
  "ispdb",
  "dns-srv",
];

/**
 * The lookup answer, read fail-closed like every other reader here — and then
 * some, because this one's failure mode is benign.
 *
 * `null` means "this build could not read that", and the caller does with it
 * exactly what it does with `{ suggestion: null }`: shows the provider list. So
 * an answer from a connector on a different release degrades into the tier below
 * rather than into a screen full of half-read hosts, and a suggestion whose SMTP
 * server is unreadable is never shown with only its IMAP half filled in.
 */
export function parseAutoconfigAnswer(value: unknown): AutoconfigAnswer | null {
  const body = asObject(value);
  if (body === null) return null;
  if (body.suggestion === null || body.suggestion === undefined) return { suggestion: null };

  const raw = asObject(body.suggestion);
  if (raw === null) return null;
  const email = asString(raw.email);
  const domain = asString(raw.domain);
  const source = asString(raw.source);
  if (email === null || domain === null || source === null) return null;
  if (!SUGGESTION_SOURCES.includes(source)) return null;

  const imap = parseSuggestedServer(raw.imap);
  const smtp = parseSuggestedServer(raw.smtp);
  if (imap === null || smtp === null) return null;

  // Absent and null are both "no CalDAV was found", which is the ordinary
  // answer. Present but unreadable is neither, and is not guessed at.
  let caldav: SuggestedCalDav | null = null;
  if (raw.caldav !== null && raw.caldav !== undefined) {
    caldav = parseSuggestedCalDav(raw.caldav);
    if (caldav === null) return null;
  }

  return {
    suggestion: { email, domain, source: source as SuggestionSource, imap, smtp, caldav },
  };
}
