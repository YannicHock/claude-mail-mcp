/**
 * The JSON shape of the connector's mailbox operations — probe a candidate
 * mailbox, and write one — and the field vocabulary both of them speak.
 *
 * This is the wire contract between the connector, which serves it, and the
 * OAuth layer's setup wizard, which speaks it. There is one copy: until #126 it
 * was mirrored as `src/settings-api.ts` and `oauth/src/settings-api.ts` and
 * compared by a whole-file drift test, because the two packages had separate
 * Docker build contexts and could not import from one another. They build from
 * one context now, so a contract that used to be identical by comparison is
 * identical by construction — and the file that both sides read a rename out of
 * (#69) is genuinely one file.
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
  /**
   * *Save anyway*: store this mailbox without probing it first (#147).
   *
   * The write routes probe before they write, and a rejected IMAP or SMTP
   * refuses the write. That rule is the connector's, in one place, and this
   * field is how a caller says the operator has deliberately asked to bypass
   * it - a server in maintenance, a network blip, or an operator who knows
   * better. It is never a default: absent, `false`, and anything unrecognised
   * all mean "probe first".
   *
   * The key is {@link SAVE_ANYWAY_FIELD}, which is also the name the two HTML
   * forms' *Save anyway* buttons submit - one field name for both content
   * types, read by {@link readSaveAnyway}, so the form path and the JSON path
   * cannot drift into disagreeing about what a save means.
   */
  save_anyway?: boolean;
}

/**
 * The name {@link MailboxRequestBody.save_anyway} travels under, in JSON and in
 * a form body alike.
 *
 * Typed against the interface rather than merely spelled the same as it:
 * rename the field and this line stops compiling.
 */
export const SAVE_ANYWAY_FIELD: keyof MailboxRequestBody & string = "save_anyway";

/**
 * Did this submission ask for *Save anyway*?
 *
 * `true` from a JSON body, {@link CHECKBOX_ON} from the button a browser posts.
 * Everything else - absent, `false`, `"0"`, a number, a string nobody meant -
 * is "probe first", because the escape hatch has to be an explicit act and a
 * value this build cannot read is not one.
 */
export function readSaveAnyway(body: Record<string, unknown>): boolean {
  const value = body[SAVE_ANYWAY_FIELD];
  return value === true || value === CHECKBOX_ON;
}

// ---- The answers -----------------------------------------------------------

/**
 * One service's verdict. Mirrors `ProbeResult` in the connector's probe.ts.
 *
 * `credentialRejection` is the classification `shared/credential-failure.ts`
 * makes: the server was reached, answered, and refused the login. It is
 * optional on the wire so an answer from a build that predates #147 still
 * parses - absent means "not stated", which is read as "not a rejection",
 * never as one.
 */
export type MailboxProbeOutcome =
  | { ok: true }
  | { ok: false; message: string; credentialRejection?: boolean };

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
  /**
   * What the probe found on the way in (#147), when there was one.
   *
   * A 201 carrying a report means the mailbox was stored *and* something the
   * save does not gate on — CalDAV — has something to say about itself. Absent
   * when the operator asked for *Save anyway*, since then nothing was probed
   * and there is nothing to state.
   */
  probe?: MailboxProbeReport;
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
  /**
   * Present when the refusal was the probe's (#147): the write routes probe
   * before they write, and a rejected IMAP or SMTP refuses the write. What the
   * operator has to see to act on that is the report, per service, so it
   * travels with the refusal rather than costing a second round trip against
   * credentials the caller would have to send again.
   *
   * Absent for every other refusal - a field the parser did not accept, a
   * stale stamp, a body that was not a draft - and absent from a build that
   * predates the probing save. A caller reads it as "the probe is why nothing
   * was stored", never as "the probe passed".
   */
  probe?: MailboxProbeReport;
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
  if (message === null) return null;
  // A boolean is carried through as it was stated, `false` included, so a
  // report survives this reader unchanged. Anything else — absent, a string, a
  // number — is dropped rather than coerced, and an outcome with nothing stated
  // reads as "not a rejection". That is the safe half of the distinction:
  // saying a server refused a password when it was merely unreachable is
  // exactly the confusion #146 exists to prevent.
  return typeof obj.credentialRejection === "boolean"
    ? { ok: false, message, credentialRejection: obj.credentialRejection }
    : { ok: false, message };
}

/** The three services out of one document, or null when IMAP and SMTP are not both in it. */
function parseProbeReport(value: unknown): MailboxProbeReport | null {
  const probe = asObject(value);
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

/** The probe answer, or null when IMAP and SMTP are not both in it. */
export function parseProbeAnswer(value: unknown): MailboxProbeReport | null {
  const body = asObject(value);
  return body === null ? null : parseProbeReport(body.probe);
}

// ---- What a probe means for a save ----------------------------------------

/**
 * The two services a mailbox is not a mailbox without.
 *
 * CalDAV is deliberately absent. It is optional in the account model and it
 * fails for benign reasons far too often to gate a mailbox on: showing the
 * failure is right, refusing the save on it is not (#147, spec §4.2). The
 * names are the ones both probe panels already print, so a notice and the rows
 * above it name the same thing.
 */
const SAVE_BLOCKING_SERVICES = ["IMAP", "SMTP"] as const;

/** One blocking service that failed, and how. */
interface BlockedService {
  name: string;
  credentialRejection: boolean;
}

function blockedServices(report: MailboxProbeReport): BlockedService[] {
  const outcomes: Record<(typeof SAVE_BLOCKING_SERVICES)[number], MailboxProbeOutcome> = {
    IMAP: report.imap,
    SMTP: report.smtp,
  };
  const blocked: BlockedService[] = [];
  for (const name of SAVE_BLOCKING_SERVICES) {
    const outcome = outcomes[name];
    if (outcome.ok) continue;
    blocked.push({ name, credentialRejection: outcome.credentialRejection === true });
  }
  return blocked;
}

/** True when this report is a reason to refuse a write. */
export function probeRefusesSave(report: MailboxProbeReport): boolean {
  return blockedServices(report).length > 0;
}

/**
 * What the operator is told when a probe refused their save, or null when the
 * report is not a refusal at all.
 *
 * One sentence, written once, for both UIs. The connector renders it above its
 * own probe panel and the wizard renders it above its own, and neither writes a
 * second account of the same fact — which is the point of the rule moving into
 * the connector rather than being enforced twice.
 *
 * It names the services, because a refusal that says only "the connection test
 * failed" sends an operator to look at all three. And it tells a rejection
 * apart from a host that never answered — the distinction
 * `shared/credential-failure.ts` exists to draw — because the two have
 * completely different remedies: one is the password, the other is the host,
 * the port, or a server that is simply down.
 */
/**
 * What the operator is told about a CalDAV failure that did *not* stop the save,
 * or null when there is nothing to say.
 *
 * The other half of the CalDAV rule. Refusing on it would be wrong; saying
 * nothing would be worse, because the calendar tools will then be quietly
 * missing for a mailbox the operator was just told was saved. So the write goes
 * through and this is shown on the way out.
 */
export function caldavFailureNotice(report: MailboxProbeReport): string | null {
  const caldav = report.caldav;
  if (caldav === null || caldav.ok) return null;
  return (
    `The mailbox was saved. Its CalDAV server did not work: ${caldav.message}. ` +
    "Mail is unaffected; the calendar tools stay unavailable for this mailbox until " +
    "that is fixed, which can be done by editing it here at any time."
  );
}

export function saveRefusedNotice(report: MailboxProbeReport): string | null {
  const blocked = blockedServices(report);
  if (blocked.length === 0) return null;
  const clauses = blocked.map((service) =>
    service.credentialRejection
      ? `${service.name} rejected these credentials`
      : `${service.name} did not answer`
  );
  const remedy = blocked.some((service) => service.credentialRejection)
    ? "Check the password this mailbox needs — some providers want an app password " +
      "rather than the account one — then try again"
    : "Check what failed above, then try again";
  return `${clauses.join(", and ")}, so nothing was saved. ${remedy}, or press ` +
    "Save anyway to store it without testing it.";
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
  if (id === null || stamp === null) return null;
  // The account is stored whether or not the report is readable; an unreadable
  // one is dropped rather than turned into a failure to have written it.
  const probe = parseProbeReport(body.probe);
  return probe === null ? { id, stamp } : { id, stamp, probe };
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
  const answer: MailboxErrorAnswer = message === null ? { errors } : { message, errors };
  // Unreadable is absent, not a failure: the refusal stands whatever shape the
  // report arrived in, and a caller with no report says so rather than guessing.
  const probe = parseProbeReport(body.probe);
  return probe === null ? answer : { ...answer, probe };
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

// ---- The provider table, as connector data ---------------------------------
//
// Tier 2 of the cascade below is a short list of providers whose settings are
// known, so that a domain publishing no autoconfig document still does not send
// the operator straight to eighteen empty boxes. That table used to live in the
// OAuth layer next to the wizard that was its only reader (#70). It has a second
// reader now — the connector's own *Add mailbox* page, which is where an
// operator adds every mailbox after the first (#141) — and the reflex move was
// to mirror it into the connector as a fourth byte-for-byte pair.
//
// #126 is the argument against that reflex: six cross-package duplicates
// protected four different ways, applied when a wave notices a shared rule and
// absent when it does not. So the table was not mirrored. It moved *into* the
// connector, where every other answer step 2 needs already comes from — the
// probe, the write, the accounts stamp and the autoconfig lookup are all
// connector answers the wizard asks for over this hop — and the wizard now asks
// for the provider list the same way. One copy of the values, in the package
// that can also read them locally, and no new drift test.
//
// What lives here is the shape of that answer, which is the one thing this
// module has always been for.

/**
 * One provider, ready to render and ready to use.
 *
 * `values` is keyed by {@link MAILBOX_FIELDS} and already filled in for the
 * address that was asked about: the entries whose hosts are a pattern rather
 * than a name are resolved on the connector's side, so a caller never learns the
 * table's own vocabulary and cannot get the substitution wrong. There is no
 * password in it at any depth, for the same reason a {@link MailboxSuggestion}
 * has none — a preset is something to confirm, not something to connect with.
 */
export interface ProviderPreset {
  /** Stable, and what the provider radio submits. Not shown. */
  id: string;
  label: string;
  /** What the operator has to know before this preset works. "" for nothing. */
  note: string;
  values: Record<string, string>;
}

/** What a caller posts to `/settings/providers`. */
export interface ProvidersRequestBody {
  _csrf: string;
  /**
   * The address the presets are filled in for. "" is allowed and is what the
   * list is rendered from before anyone has typed one; the entries whose hosts
   * are templates simply come back with an empty host, which is the same prompt
   * an operator would have got from the table directly.
   */
  email: string;
}

/** 200 from `POST /settings/providers`. */
export interface ProvidersAnswer {
  providers: ProviderPreset[];
}

/**
 * The provider list, read fail-closed like every other answer here.
 *
 * One unreadable entry fails the whole answer rather than being quietly
 * dropped: a list with a provider missing from it is a list an operator scrolls
 * twice before concluding their provider is not supported, and the caller's
 * response to `null` — the full form — is at least honest about knowing
 * nothing. Values under names this build does not have are dropped the way
 * {@link parseErrorAnswer} drops unknown error keys, so a connector on a
 * different release cannot put arbitrary keys into a form.
 */
export function parseProvidersAnswer(value: unknown): ProvidersAnswer | null {
  const body = asObject(value);
  if (body === null || !Array.isArray(body.providers)) return null;

  const providers: ProviderPreset[] = [];
  for (const entry of body.providers) {
    const obj = asObject(entry);
    if (obj === null) return null;
    const id = asString(obj.id);
    const label = asString(obj.label);
    const note = asString(obj.note);
    const submitted = asObject(obj.values);
    if (id === null || label === null || note === null || submitted === null) return null;

    const values: Record<string, string> = {};
    for (const name of MAILBOX_FIELD_NAMES) {
      const field = asString(submitted[name]);
      if (field !== null) values[name] = field;
    }
    providers.push({ id, label, note, values });
  }
  return { providers };
}

// ---- The address-first cascade ---------------------------------------------
//
// Four screens: an address and a password; what the lookup found, for
// confirmation; the provider list, when it found nothing or the operator asked
// for it; and the full form, which every other screen leads to, which is
// reachable directly, and which is always the fallback.
//
// Two entry points render them — the setup wizard's step 2, and the connector's
// own *Add mailbox* page — and before #141 only the first existed. What is in
// this section is the **cascade**: which screen comes next, with what in it, and
// what the operator is told when the address itself could not be read.
//
// What is deliberately *not* here is the rendering. The wizard's chrome is a
// three-of-three stepper with a Skip button on every screen; the settings UI's
// is a CSRF token, an accounts stamp and a link back to the mailbox list. A
// mirrored renderer would be the fourth duplicate #126 is about, and it would be
// mirroring the half that genuinely differs. The branching is the half that was
// going to be written twice and drift, so the branching is the half that lives
// in one text.

/** The name the address box submits: the connector's own, so it carries onward. */
export const ADDRESS_FIELD = MAILBOX_FIELDS.mailDefaultFrom;

/**
 * The one password box tiers 1 and 2 have.
 *
 * Not one of {@link MAILBOX_FIELDS}, on purpose: a draft has three passwords and
 * these screens ask once (#120). {@link withSharedPassword} is what spreads the
 * one answer across the services that need it, and the full form — which can
 * express three different passwords — sends no field under this name at all, so
 * that function is inert there.
 */
export const SHARED_PASSWORD_FIELD = "password";

/** The name the provider list submits. */
export const PROVIDER_FIELD = "provider";

/** What `Other` submits: no preset, straight to the full form. */
export const PROVIDER_OTHER = "other";

/**
 * What the two screens with an address box say when they could not read one.
 *
 * This is not an autoconfig failure and is not covered by the rule that none of
 * those is ever shown: it is about what the operator typed, which they can see
 * and fix, on a submission that never became a lookup at all.
 */
export const ADDRESS_REQUIRED = "Enter a full email address, like anna@example.com.";

/** What the provider list says when the submission named no preset it has. */
export const PROVIDER_REQUIRED = "Choose a provider, or pick Other.";

/** The domain half of an address, lowercased, or "" if there is not one. */
export function domainOf(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) return "";
  return email.slice(at + 1).toLowerCase();
}

/** Where a suggestion came from, said so an operator could go and check it. */
export function suggestionSourceLabel(suggestion: MailboxSuggestion): string {
  switch (suggestion.source) {
    case "autoconfig-subdomain":
      return `Published by autoconfig.${suggestion.domain}.`;
    case "autoconfig-well-known":
      return `Published by ${suggestion.domain} itself.`;
    case "ispdb":
      return "From the Mozilla ISP database, not from the provider directly.";
    case "dns-srv":
      return `From ${suggestion.domain}'s DNS service records.`;
  }
}

/** What may be put back into a page: everything the draft holds except passwords. */
export function formValues(draft: MailboxDraft): Record<string, string> {
  const values = flattenDraft(draft);
  for (const name of MAILBOX_SECRET_FIELDS) delete values[name];
  return values;
}

/**
 * A suggestion, as the values a confirmation screen shows and submits.
 *
 * Under {@link MAILBOX_FIELDS} names, because that is the only vocabulary that
 * reaches the connector's parser, and over `defaults` the caller supplies — the
 * wizard's first mailbox is `main` and is the default account, and a second
 * mailbox added from the settings UI is neither, which is the whole of the
 * difference between the two callers here.
 *
 * There is no password in it, and nowhere in a {@link MailboxSuggestion} for one
 * to come from. The one the operator typed is carried beside these rather than
 * mixed into them, so the rows a screen renders from the connector's own field
 * names stay what they have always been.
 */
export function suggestedValues(
  suggestion: MailboxSuggestion,
  defaults: Record<string, string> = {}
): Record<string, string> {
  const values: Record<string, string> = {
    ...defaults,
    [MAILBOX_FIELDS.mailDefaultFrom]: suggestion.email,
    [MAILBOX_FIELDS.imapHost]: suggestion.imap.host,
    [MAILBOX_FIELDS.imapPort]: String(suggestion.imap.port),
    [MAILBOX_FIELDS.imapUser]: suggestion.imap.user,
    [MAILBOX_FIELDS.imapTls]: suggestion.imap.tls ? CHECKBOX_ON : "",
    [MAILBOX_FIELDS.smtpHost]: suggestion.smtp.host,
    [MAILBOX_FIELDS.smtpPort]: String(suggestion.smtp.port),
    [MAILBOX_FIELDS.smtpUser]: suggestion.smtp.user,
    [MAILBOX_FIELDS.smtpTls]: suggestion.smtp.tls ? CHECKBOX_ON : "",
  };
  if (suggestion.caldav !== null) {
    values[MAILBOX_FIELDS.caldavUrl] = suggestion.caldav.url;
    values[MAILBOX_FIELDS.caldavUser] = suggestion.caldav.user;
  }
  return values;
}

/**
 * The full form with only the address in it, for `Other — enter the settings
 * myself`.
 *
 * The two TLS boxes are stated rather than left out. An absent checkbox is how a
 * browser submits an unticked one, so a form that reads a non-empty `values` as
 * a previous submission renders TLS off — which is the wrong default and, on
 * this path, one nobody chose.
 */
export function emptyMailboxValues(email: string): Record<string, string> {
  return {
    [MAILBOX_FIELDS.mailDefaultFrom]: email,
    [MAILBOX_FIELDS.imapTls]: CHECKBOX_ON,
    [MAILBOX_FIELDS.smtpTls]: CHECKBOX_ON,
  };
}

/** A field of a form body, or "" for a missing one or a repeated one. */
function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * The one password, spread across the services the fields name. The whole rule,
 * in one place.
 *
 * A screen with one password box cannot express a mailbox whose IMAP and SMTP
 * logins take different passwords, and does not try to: it collects the one
 * password an ordinary mailbox has, and this puts it wherever there is a service
 * and no password of its own yet. A per-service password already present always
 * wins, and an empty shared password changes nothing.
 *
 * **CalDAV is the clause that is not symmetrical with the other two**, and the
 * reason this is worth having exactly once: it is filled in only when there is a
 * CalDAV URL beside it. {@link draftFromFields} builds a CalDAV block as soon as
 * any one of its three fields is non-empty, so a block that is nothing but a
 * password is a probe against a server that was never named.
 *
 * Generic over the field map because the same rule runs in both directions —
 * see {@link carrying} and {@link withSharedPassword} — and the two directions
 * disagree about nothing except whether the values have already been narrowed to
 * strings. Reading through {@link stringField} covers both.
 */
function spreadSharedPassword<T extends Record<string, unknown>>(fields: T, shared: string): T {
  if (shared === "") return fields;

  const text = (name: string): string => stringField(fields[name]);
  const filled: Record<string, unknown> = { ...fields };
  for (const name of [MAILBOX_FIELDS.imapPass, MAILBOX_FIELDS.smtpPass]) {
    if (text(name) === "") filled[name] = shared;
  }
  if (text(MAILBOX_FIELDS.caldavUrl) !== "" && text(MAILBOX_FIELDS.caldavPass) === "") {
    filled[MAILBOX_FIELDS.caldavPass] = shared;
  }
  return filled as T;
}

/**
 * The one password the operator typed, put into the form that is about to ask
 * for three.
 *
 * The values direction of {@link spreadSharedPassword}: it fills in a page on
 * its way to the operator, so that a form they are being sent to does not open
 * by asking them for something they have already given it (#120). An empty
 * password — tier 2 reached from its own link — leaves the boxes as they were.
 */
export function carrying(
  values: Record<string, string>,
  password: string
): Record<string, string> {
  return spreadSharedPassword(values, password);
}

/**
 * Tiers 1 and 2 ask for one password; a draft has three.
 *
 * The body direction of {@link spreadSharedPassword}: it fills in a submission
 * on its way to the connector's parser. The full form is where a mailbox with
 * two different passwords is expressed, and it sends no
 * {@link SHARED_PASSWORD_FIELD} at all, so this is inert there.
 */
export function withSharedPassword(body: Record<string, unknown>): Record<string, unknown> {
  return spreadSharedPassword(body, stringField(body[SHARED_PASSWORD_FIELD]));
}

/**
 * Which screen the cascade is on. `manual` is the full form — the last of the
 * four rather than the first, which is what #141 is about.
 */
export type MailboxSetupView = "address" | "suggestion" | "providers" | "manual";

/**
 * The next screen, and everything it needs that is not chrome.
 *
 * A discriminated union rather than a bag of optionals, so a caller that forgets
 * a screen does not compile. `errors` is keyed by field name — either
 * {@link ADDRESS_FIELD} or {@link PROVIDER_FIELD} — so each one sits against the
 * box it is about.
 */
export type MailboxSetupStep =
  | {
      view: "address";
      email: string;
      password: string;
      errors: Record<string, string>;
    }
  | {
      view: "suggestion";
      email: string;
      /** The domain the settings were found for, which is the lookup's own. */
      domain: string;
      sourceLabel: string;
      /** Never contains a password: see {@link suggestedValues}. */
      values: Record<string, string>;
      /** Carried beside the values, not mixed into them (#120). */
      password: string;
    }
  | {
      view: "providers";
      email: string;
      /** The domain nothing was found for, or "" when nobody has typed one. */
      domain: string;
      /** Which radio is on when a submission is being re-rendered. */
      selected: string;
      password: string;
      errors: Record<string, string>;
    }
  | {
      view: "manual";
      email: string;
      /** Already carrying the password, which is why there is not one beside it. */
      values: Record<string, string>;
      /** The preset these came from, or null when the operator chose `Other`. */
      preset: ProviderPreset | null;
    };

/**
 * Tier 1's Continue: the address screen, given what the lookup answered.
 *
 * `found === null` is not a failure and is never rendered as one — the next
 * screen is simply the provider list, carrying the address and the password, so
 * neither is typed twice. A connector that was unreachable, one on a release
 * whose answer could not be read, and a domain that publishes nothing all arrive
 * here as the same `null` on purpose.
 */
export function stepFromLookup(input: {
  email: string;
  password: string;
  found: MailboxSuggestion | null;
  defaults?: Record<string, string>;
}): MailboxSetupStep {
  const email = input.email.trim();
  const password = input.password;

  if (domainOf(email) === "") {
    return {
      view: "address",
      email,
      password,
      errors: { [ADDRESS_FIELD]: ADDRESS_REQUIRED },
    };
  }

  if (input.found === null) {
    return {
      view: "providers",
      email,
      domain: domainOf(email),
      selected: "",
      password,
      errors: {},
    };
  }

  return {
    view: "suggestion",
    email,
    domain: input.found.domain,
    sourceLabel: suggestionSourceLabel(input.found),
    values: suggestedValues(input.found, input.defaults ?? {}),
    password,
  };
}

/**
 * Tier 2's Continue: a chosen preset, filled into the full form.
 *
 * It leads to the form rather than straight to a save, because the values are
 * the whole reason to pick a provider and the form is the only screen that shows
 * them — and for the entries whose hosts are a pattern rather than a name, it is
 * also where the host gets corrected.
 */
export function stepFromProvider(input: {
  email: string;
  password: string;
  chosen: string;
  presets: readonly ProviderPreset[];
  defaults?: Record<string, string>;
}): MailboxSetupStep {
  const email = input.email.trim();
  const password = input.password;
  const defaults = input.defaults ?? {};

  if (domainOf(email) === "") {
    return {
      view: "providers",
      email,
      domain: "",
      selected: input.chosen,
      password,
      errors: { [ADDRESS_FIELD]: ADDRESS_REQUIRED },
    };
  }

  if (input.chosen === PROVIDER_OTHER) {
    return {
      view: "manual",
      email,
      values: carrying({ ...defaults, ...emptyMailboxValues(email) }, password),
      preset: null,
    };
  }

  const preset = input.presets.find((entry) => entry.id === input.chosen) ?? null;
  if (preset === null) {
    return {
      view: "providers",
      email,
      domain: domainOf(email),
      selected: "",
      password,
      errors: { [PROVIDER_FIELD]: PROVIDER_REQUIRED },
    };
  }

  return {
    view: "manual",
    email,
    values: carrying({ ...defaults, ...preset.values }, password),
    preset,
  };
}

/**
 * The confirmation screen's `Edit these`: the same settings, in the form that
 * can change them.
 *
 * Through a draft rather than by echoing the body back, so {@link formValues}
 * strips every password out of it — and then {@link carrying} puts back the one
 * the operator typed, which came in on this submission rather than out of
 * anything that was stored.
 */
export function stepFromEdit(input: {
  fields: Record<string, unknown>;
  password: string;
  defaults?: Record<string, string>;
}): MailboxSetupStep {
  const values = formValues(draftFromFields(input.fields));
  return {
    view: "manual",
    email: values[MAILBOX_FIELDS.mailDefaultFrom] ?? "",
    values: carrying({ ...(input.defaults ?? {}), ...values }, input.password),
    preset: null,
  };
}
