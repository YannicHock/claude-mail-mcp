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

// ---- The connector's budgets -----------------------------------------------

/**
 * How long the connector gives itself to probe one candidate mailbox.
 *
 * Here rather than in `src/probe.ts`, where it was, because it is not only the
 * connector's business: the setup wizard waits on this call, and a wizard that
 * gives up first abandons work that is still running and tells the operator
 * *"the connector did not answer"* about a probe that was going to succeed —
 * #82's failure, reached from the other end. The two constants lived in
 * different npm packages, so no compiler and no single suite saw both, and the
 * rule "the wizard waits longer" was three comments in `setup-routes.ts` and
 * nothing else. Raising this to 40 s used to break the wizard silently.
 *
 * The wizard derives its own budget by adding slack to this number, so raising
 * it now raises the wizard's with it. `src/probe.ts` takes it as its default —
 * it is still `TOTAL_TIMEOUT_MS` there, for every caller that has always
 * imported that name.
 */
export const CONNECTOR_PROBE_BUDGET_MS = 25_000;

/**
 * How long the connector gives the whole autoconfig cascade before it answers
 * `null`. Shared for the same reason, and used the same way: `src/autoconfig.ts`
 * takes it as `AUTOCONFIG_TOTAL_TIMEOUT_MS`, and the wizard's lookup timeout is
 * this plus slack.
 *
 * The slack matters more here than the arithmetic does. A cascade that runs to
 * the end of its deadline still has an answer to send — "nothing found" is an
 * answer, and the screen after it is the provider list. Aborting at exactly this
 * number turns that into no answer at all: the same screen for the operator, and
 * a warning in the log about a connector that did precisely what it promised.
 */
export const CONNECTOR_AUTOCONFIG_BUDGET_MS = 10_000;

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
  const text = (name: MailboxFieldName): string => stringField(fields[name]);
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
 * True when one of the services that *can* refuse a save refused it over the
 * credentials — the one condition under which anything about a password is
 * worth saying.
 *
 * Exported because settings-routes.ts had its own copy of this question and the
 * two answered it differently: that one scanned all three services, this one
 * walks {@link SAVE_BLOCKING_SERVICES}. A report where IMAP was merely
 * unreachable while CalDAV rejected its credentials came out true there and
 * false here, so the provider note was looked up, handed to
 * {@link saveRefusedNotice} — and discarded by it. Harmless in what it
 * rendered, and exactly the kind of two-predicates-one-question drift that
 * stops being harmless the moment either side is edited.
 *
 * The IMAP/SMTP scope is the same deliberate one `blockedServices` has: a
 * CalDAV block that refused a password does not refuse the save, so it is not
 * what the sentence above a refused save is about.
 */
export function credentialRejectionRefusesSave(report: MailboxProbeReport): boolean {
  return blockedServices(report).some((service) => service.credentialRejection);
}

/**
 * True when any probed service failed at all — including CalDAV, which cannot
 * refuse a save.
 *
 * The routes that only *test* need a wider question than the ones that write.
 * A save is refused by IMAP or SMTP alone, so {@link probeRefusesSave} walks
 * those two; but *Test connection* stores nothing, and a CalDAV row glowing red
 * with no explanation beside it is exactly the silence #146 was filed about.
 */
export function probeFailed(report: MailboxProbeReport): boolean {
  return !report.imap.ok || !report.smtp.ok || (report.caldav !== null && !report.caldav.ok);
}

/**
 * True when any probed service refused the credentials, CalDAV included.
 *
 * The counterpart of {@link credentialRejectionRefusesSave} for those same
 * test-only routes. The two scopes are deliberately different and the
 * difference is load-bearing: a Fastmail mailbox whose *CalDAV* password is
 * wrong while IMAP and SMTP answer is not a refused save — nothing was being
 * saved — but it is a rejected password, and Fastmail's note is the sentence
 * that explains it. Reusing the save-scoped predicate there dropped that note.
 */
export function anyCredentialRejection(report: MailboxProbeReport): boolean {
  return [report.imap, report.smtp, report.caldav].some(
    (outcome) => outcome !== null && !outcome.ok && outcome.credentialRejection === true
  );
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
 *
 * `credentialNote` (#148) is the one thing a caller may say better than this
 * function can: what *this provider* wants, when the caller recognised the
 * address's domain. It **replaces** the generic app-password sentence rather
 * than being printed beside it — both on one screen would say the same thing
 * twice, the second time specifically, and the whole argument for the note is
 * that it is targeted. Passing one for a refusal that was not a credential
 * rejection changes nothing: there is no generic sentence there to replace,
 * because no server said anything about any password.
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

export function saveRefusedNotice(
  report: MailboxProbeReport,
  credentialNote?: string,
  /**
   * The screen already carries the standing warning about this address in its
   * own box, so this sentence prints no remedy of its own (#191).
   *
   * The third state of the same rule the note is the second of: the generic
   * "some providers want an app password" clause is the weakest thing that can
   * be said, and both the others displace it rather than sitting beside it.
   * Until #191 the connector passed the `unsupported` sentence in as the note,
   * which put a 60-word paragraph inside the refusal sentence — and once the
   * warning has a box of its own on every screen, that is the same paragraph
   * twice, one above the other. Dropping it without this flag would hand an
   * `@outlook.com` refusal back the generic app-password clause and send its
   * operator hunting for a passcode Microsoft does not issue, which is #184.
   *
   * Deliberately not derived from the report: no report says anything about an
   * address, and this function has no table to ask.
   */
  addressWarned?: boolean
): string | null {
  const blocked = blockedServices(report);
  if (blocked.length === 0) return null;
  const clauses = blocked.map((service) =>
    service.credentialRejection
      ? `${service.name} rejected these credentials`
      : `${service.name} did not answer`
  );
  const rejected = blocked.some((service) => service.credentialRejection);
  // The note is the targeted form of the generic sentence below it, so it takes
  // that sentence's place — never both. An empty string is read as no note, the
  // way `ProviderPreset.note` already spells "nothing to say".
  //
  // Whether a note applies is the caller's question, not this one's. It used to
  // be gated on `rejected` here as well, on the reasoning that a note is always
  // about a password and there is no generic password sentence to replace when
  // no server complained about one. That is true of a `credentialNote` and
  // false of an `unsupported` warning, which is a fact about the address and
  // holds however the probe failed — Proton answers no IMAP from the internet
  // at all, so its refusal is connectivity, and gating here swallowed the one
  // entry that explains it.
  const targeted = credentialNote !== undefined && credentialNote !== "";
  // The warning box says what to do and says it in stronger terms, so this
  // sentence stops at the report and the escape hatch. A note still wins over
  // it: a caller that has both has recognised the domain twice over and the
  // note is the more specific of the two.
  const deferred = !targeted && addressWarned === true;
  const remedy = targeted
    ? credentialNote
    : rejected
      ? "Check the password this mailbox needs — some providers want an app password " +
        "rather than the account one — then try again"
      : "Check what failed above, then try again";
  // A note is prose of its own and ends in a full stop; the generic remedies are
  // clauses written to be continued. Joining both with ", or press" would run a
  // paragraph into a subordinate clause.
  const tail = targeted
    ? " Or press Save anyway to store it without testing it."
    : ", or press Save anyway to store it without testing it.";
  if (deferred) {
    return `${clauses.join(", and ")}, so nothing was saved. Press Save anyway to store it ` +
      "without testing it.";
  }
  return `${clauses.join(", and ")}, so nothing was saved. ${remedy}${tail}`;
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
  /**
   * What the connector knows about the **address**, when it is that no password
   * it can send will ever be accepted there — #180.
   *
   * This widens the route from "what does this domain publish" to "what does
   * this connector know about this address", and that widening is the only real
   * objection to carrying the warning here. It is answered by what the wizard is
   * actually asking: it posts an address at the one moment the domain becomes
   * known and before any password is typed, and "no password will work here" is
   * knowledge about that address rather than about the DNS records under it.
   *
   * Independent of {@link AutoconfigAnswer.suggestion} in both directions.
   * Microsoft publishes autoconfig and answers no password, so a warning arrives
   * beside a suggestion; Proton publishes nothing and answers no password, so
   * one arrives beside a miss — a shape this route did not have before, and the
   * one the wizard's tier-2 fallback has to keep rather than drop.
   *
   * The sentence is the connector's, out of `PROVIDER_ADVICE` in
   * `src/providers.ts`, and the domain match stays there beside the table.
   * Sending it means the two UIs cannot disagree about which addresses are
   * warned, and the wizard gets no second copy of the domain set. Absent from a
   * connector that predates the field, which is what makes it optional.
   */
  unsupported?: string;
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

  // Read before the suggestion is, because a warning arrives with a miss as
  // readily as with a hit — Proton publishes nothing and still cannot be served.
  // Absent, null and empty are all "nothing to say", the way `ProviderPreset.note`
  // already spells it, and are what a connector predating #180 sends for every
  // address. A value that is neither absent nor a string is a build disagreeing
  // with this one about the wire, and is read the way an unreadable host is.
  let unsupported: string | undefined;
  if (body.unsupported !== null && body.unsupported !== undefined) {
    const sentence = asString(body.unsupported);
    if (sentence === null) return null;
    if (sentence !== "") unsupported = sentence;
  }
  const warning = unsupported === undefined ? {} : { unsupported };

  if (body.suggestion === null || body.suggestion === undefined) {
    return { suggestion: null, ...warning };
  }

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
    ...warning,
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

/**
 * The standing warning, carried from one cascade screen to the next.
 *
 * The two entry points get the sentence from different places, and only one of
 * them needs this field. The connector holds `PROVIDER_ADVICE` and re-derives
 * the warning from the submitted address on every step, so its own screens
 * carry nothing. The setup wizard is *told* the sentence once, on the answer to
 * `POST /settings/autoconfig` (#180), and must not grow a second copy of the
 * domain set to work it out again — so its screens carry the connector's own
 * words forward in a hidden input, the way they already carry the one password
 * the operator typed.
 *
 * Not one of {@link MAILBOX_FIELDS}: it is not part of a mailbox and never
 * reaches a draft. `draftFromFields` does not know the name, so a submission
 * carrying it produces the same account as one that does not.
 */
export const UNSUPPORTED_FIELD = "_unsupported";

/**
 * The address {@link UNSUPPORTED_FIELD} was derived for, carried beside it.
 *
 * A carried sentence travels with the *form*, not with the address, and two of
 * the wizard's screens have an address box the operator can edit — so without
 * this field an operator who lands on the provider list with `anna@proton.me`,
 * corrects the box to `anna@fastmail.com` and picks a preset reads Proton's
 * Bridge paragraph over a Fastmail mailbox, and goes on reading it through
 * *Test connection* and a refused save, because the full form emits no lookup.
 *
 * So the sentence carries the address it is about, and the reader of the
 * submission drops it when the submitted address is at a different domain. That
 * needs no round trip and no copy of the domain set (#180). It closes the false
 * positive only: an address corrected the *other* way — unwarned to warned — is
 * not warned until the next lookup, because nothing on this side can recognise
 * a domain. See the reader in `oauth/src/setup-routes.ts`.
 *
 * Not one of {@link MAILBOX_FIELDS}, for the same reason as the sentence: it is
 * bookkeeping between two screens and never reaches a draft.
 */
export const UNSUPPORTED_FOR_FIELD = "_unsupported_for";

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

/**
 * A field of a form body, or "" for a missing one or a repeated one.
 *
 * Exported since #134 because it was not only this module's coercion: the setup
 * wizard declared it byte-for-byte in `oauth/src/setup-routes.ts` and called its
 * own copy eleven times, in the two packages #126 spent 1,650 lines
 * de-mirroring. {@link draftFromFields} had a third copy as a local closure.
 * There is one now, and `test/unit/shared-modules.test.ts` sees private
 * declarations too, which is why nothing noticed the first two.
 */
export function stringField(value: unknown): string {
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
 * Returns **only the fields it adds**, rather than a filled-in copy of the map
 * it was given, and that is what lets the same rule run in both directions
 * without a cast. It used to be generic over the field map and end
 * `return filled as T`, which was sound only for as long as every value in every
 * map here was a string: {@link carrying} is declared as returning
 * `Record<string, string>` and got its answer through that cast unchecked, so
 * the first number in this module — {@link CONNECTOR_PROBE_BUDGET_MS}, one
 * section up — would have made that declaration a lie at compile time with no
 * error anywhere. Reading through {@link stringField} and writing only strings
 * keeps both callers honest at their own boundary.
 */
function spreadSharedPassword(
  fields: Record<string, unknown>,
  shared: string
): Record<string, string> {
  if (shared === "") return {};

  const text = (name: string): string => stringField(fields[name]);
  const filled: Record<string, string> = {};
  for (const name of [MAILBOX_FIELDS.imapPass, MAILBOX_FIELDS.smtpPass]) {
    if (text(name) === "") filled[name] = shared;
  }
  if (text(MAILBOX_FIELDS.caldavUrl) !== "" && text(MAILBOX_FIELDS.caldavPass) === "") {
    filled[MAILBOX_FIELDS.caldavPass] = shared;
  }
  return filled;
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
  return { ...values, ...spreadSharedPassword(values, password) };
}

/**
 * Tiers 1 and 2 ask for one password; a draft has three.
 *
 * The body direction of {@link spreadSharedPassword}: it fills in a submission
 * on its way to the connector's parser. The full form is where a mailbox with
 * two different passwords is expressed, and it sends no
 * {@link SHARED_PASSWORD_FIELD} at all, so this is inert there.
 *
 * The widening happens here rather than inside the rule: a body's other values
 * are whatever the form parser produced — an array for a repeated field — and
 * they are carried through untouched.
 */
export function withSharedPassword(body: Record<string, unknown>): Record<string, unknown> {
  return { ...body, ...spreadSharedPassword(body, stringField(body[SHARED_PASSWORD_FIELD])) };
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
 *
 * `unsupported` is on every variant, and #186 is why it is a field here at all.
 * It used to be a fourth argument to each UI's own `sendStep`, sharing one slot
 * with the screen's own notice — and the three branches fought over that slot,
 * so an operator who was correctly warned about `anna@outlook.com` and pressed
 * *Edit these* lost the warning to a sentence about nothing having been saved.
 * The two are different kinds of thing: a notice is about **this submission**,
 * the warning is about **the address** and stays true for every screen the
 * address survives on. So it is decided here, where the cascade already decides
 * what comes next, and each render site has two slots and shows both.
 *
 * Every variant carries it, including `address` — which can never have one,
 * because an address with no domain in it matches no entry in the table — so
 * that no render site has to narrow the union before reading it.
 */
export type MailboxSetupStep =
  | {
      view: "address";
      email: string;
      password: string;
      errors: Record<string, string>;
      /** Always null here: no domain was read, so nothing could be recognised. */
      unsupported: string | null;
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
      /** What this connector knows about the address, or null. See above. */
      unsupported: string | null;
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
      /** What this connector knows about the address, or null. See above. */
      unsupported: string | null;
    }
  | {
      view: "manual";
      email: string;
      /** Already carrying the password, which is why there is not one beside it. */
      values: Record<string, string>;
      /** The preset these came from, or null when the operator chose `Other`. */
      preset: ProviderPreset | null;
      /** What this connector knows about the address, or null. See above. */
      unsupported: string | null;
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
  /**
   * What this connector knows about the address, from the caller that can
   * answer it: the connector reads its own table, the wizard reads
   * {@link AutoconfigAnswer.unsupported} off the answer to the same lookup.
   * Neither works the domain match out for itself (#180).
   */
  unsupported?: string | null;
}): MailboxSetupStep {
  const email = input.email.trim();
  const password = input.password;
  const unsupported = input.unsupported ?? null;

  if (domainOf(email) === "") {
    return {
      view: "address",
      email,
      password,
      errors: { [ADDRESS_FIELD]: ADDRESS_REQUIRED },
      // Not the caller's value, even if one was handed in: there is no domain
      // here to have recognised, so there is nothing true to say.
      unsupported: null,
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
      unsupported,
    };
  }

  return {
    view: "suggestion",
    email,
    domain: input.found.domain,
    sourceLabel: suggestionSourceLabel(input.found),
    values: suggestedValues(input.found, input.defaults ?? {}),
    password,
    unsupported,
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
  /** See {@link stepFromLookup}: the same fact, one screen further on. */
  unsupported?: string | null;
}): MailboxSetupStep {
  const email = input.email.trim();
  const password = input.password;
  const defaults = input.defaults ?? {};
  const unsupported = input.unsupported ?? null;

  if (domainOf(email) === "") {
    return {
      view: "providers",
      email,
      domain: "",
      selected: input.chosen,
      password,
      errors: { [ADDRESS_FIELD]: ADDRESS_REQUIRED },
      // The address was edited into something with no domain in it, so whatever
      // was known about the old one is no longer about what is on the screen.
      unsupported: null,
    };
  }

  if (input.chosen === PROVIDER_OTHER) {
    return {
      view: "manual",
      email,
      values: carrying({ ...defaults, ...emptyMailboxValues(email) }, password),
      preset: null,
      unsupported,
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
      unsupported,
    };
  }

  return {
    view: "manual",
    email,
    values: carrying({ ...defaults, ...preset.values }, password),
    preset,
    unsupported,
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
  /**
   * See {@link stepFromLookup}. This is the press #186 was filed about: the
   * screen this leads to has its own sentence — "Nothing has been saved…" — and
   * that sentence used to arrive in the same slot as the warning and win.
   */
  unsupported?: string | null;
}): MailboxSetupStep {
  const values = formValues(draftFromFields(input.fields));
  const email = values[MAILBOX_FIELDS.mailDefaultFrom] ?? "";
  return {
    view: "manual",
    email,
    values: carrying({ ...(input.defaults ?? {}), ...values }, input.password),
    preset: null,
    // The same rule the other two state: with no domain on the screen there is
    // nothing the table could have recognised, so whatever was handed in is not
    // about what the operator is looking at. Written here as well because one
    // rule omitted from one of three functions is the shape a drift takes.
    unsupported: domainOf(email) === "" ? null : (input.unsupported ?? null),
  };
}
