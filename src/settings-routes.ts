/**
 * The connector's operator-facing settings routes: list, create, edit, delete and
 * "make default" for mailbox accounts, plus a probe-only "test connection" action
 * on both the create and edit forms.
 *
 * Every route is declared at its full path (`/settings/mailboxes/...`) so that
 * `req.path` matches the `htu` the OAuth layer signed into the assertion — see the
 * mounting note on {@link requireSettingsAssertion}. The guard is applied per
 * route, not via `router.use`, for the same reason: this router is mounted at `/`,
 * never at a `/settings` prefix.
 *
 * Two independent credentials gate every route here: the caller must already have
 * passed the static Bearer check (mounted separately, ahead of this router — see
 * app.ts) and must present a valid, path-bound assertion. State-changing routes add
 * a third check, `requireFormCsrf`, comparing the form's `_csrf` field against the
 * assertion's own `csrf` claim in constant time — this is the connector checking
 * CSRF without ever having seen the session cookie, which the OAuth layer strips
 * before forwarding.
 *
 * ## The same routes, in JSON
 *
 * Three of them answer `Accept: application/json` with a document instead of a
 * page: `GET /settings/mailboxes/new` (the accounts stamp), `POST
 * /settings/mailboxes/test` (the probe) and `POST /settings/mailboxes` (the
 * write). That is the surface the OAuth layer's setup wizard uses, and before
 * #69 it had to read those three facts back out of the rendered markup with
 * regular expressions.
 *
 * Content negotiation rather than a second set of `/settings/api/…` paths, for
 * three reasons. The guards are already attached here — `requireSettingsAssertion`,
 * then the body parser, then `requireFormCsrf` — and a JSON branch inside a
 * handler cannot become a route that forgot one, which a new path can. The
 * assertion binds the method and the path it was signed for, so keeping the
 * paths means the wizard signs exactly what it already signed and no new URL
 * appears for an operator to rate-limit, document or firewall. And the probe
 * and the account write stay in one place each: the JSON branch is a different
 * send at the end of the same handler, over the same `parseAccountForm`, the
 * same `probeAccount` and the same `store.create`.
 *
 * The request body may be JSON too — `{ _csrf, _stamp, mailbox }`, where
 * `mailbox` is a `MailboxDraft` from settings-api.ts. The two bookkeeping
 * fields keep their form names deliberately, so the CSRF guard and the stamp
 * check are the same lines of code for both content types; `submittedFields`
 * flattens the draft onto the field names the form parser already reads.
 * Nothing else about the vocabulary is written here: it comes from
 * `MAILBOX_FIELDS`, which the OAuth layer mirrors.
 *
 * The `/:id` edit routes are not negotiated. They have no second caller, and a
 * surface with no user is a surface with no tests.
 *
 * ## The two routes that are JSON and nothing else
 *
 * `POST /settings/autoconfig` answers a document whatever it is asked for,
 * because there is no page behind it: it is the wizard's tier-1 lookup, run here
 * rather than there because `src/autoconfig.ts` and the §7 constraints that make
 * a user-derived fetch safe are in this package and cannot be imported out of
 * it. See the route itself for why it is a POST and why it always answers 200.
 *
 * `POST /settings/providers` is the second, and is the same shape for a related
 * reason. The provider table lives in this package (`src/providers.ts`) because
 * this package now has a reader for it — the *Add mailbox* cascade below, which
 * calls `providerPresets` as a function — and mirroring it into the OAuth layer
 * would have made a fourth byte-for-byte cross-package duplicate, which #126
 * argues against at length. The wizard reads the list here instead.
 *
 * ## Add mailbox, address first
 *
 * `GET /settings/mailboxes/new` is the address screen, `?view=providers` is the
 * provider list and `?view=manual` is the eighteen-field form that used to be
 * the only thing behind that URL; `POST /settings/mailboxes/new` moves between
 * them. Nothing there stores, probes or validates a mailbox — every path that
 * ends in an account still ends at `POST /settings/mailboxes`, unchanged.
 *
 * The branching between the screens is not written here and is not written in
 * the wizard either: `stepFromLookup`, `stepFromProvider` and `stepFromEdit` in
 * settings-api.ts are the cascade, both entry points call them, and what each
 * package writes for itself is the chrome around the result (#141).
 *
 * Route path collisions: "new" and "test" are reserved path segments — GET
 * /settings/mailboxes/new and POST /settings/mailboxes/test are registered ahead of
 * the `:id` routes they would otherwise be ambiguous with. An operator who names an
 * account "new" or "test" cannot reach it through the single-segment GET/POST
 * routes (they will hit the reserved handler instead); the two-segment routes
 * (`/:id/test`, `/:id/default`, `/:id/delete`) are unaffected since no reserved
 * literal exists at that depth. This mirrors a limitation already present in how
 * settings-pages.ts builds these URLs, not something introduced here. Creating
 * such an account is refused, but one that already exists still loads, so the
 * list route below hands the renderer a per-row notice saying what is broken and
 * that the remedy is to delete and recreate it.
 */

import { timingSafeEqual } from "node:crypto";
import express, { type Request, type RequestHandler, type Response, type Router } from "express";

import type { Logger } from "./app.js";
import { lookupMailboxSettings, type MailboxSuggestion as LookupSuggestion } from "./autoconfig.js";
import {
  AccountsStore,
  AccountsStoreError,
  NoSuchAccountError,
  RESERVED_IDS,
  reservedIdAccounts,
  reservedIdNotice,
  type Account,
  type CalDavCreds,
} from "./accounts.js";
import { StaleStampError } from "./accounts-writer.js";
import { probeAccount, type ProbeReport } from "./probe.js";
import { credentialNoteFor, providerPresets, unsupportedNoticeFor } from "./providers.js";
import {
  ADDRESS_FIELD,
  caldavFailureNotice,
  CHECKBOX_ON,
  anyCredentialRejection,
  credentialRejectionRefusesSave,
  flattenDraft,
  MAILBOX_FIELDS,
  MAILBOX_SECRET_FIELDS,
  parseMailboxDraft,
  probeFailed,
  probeRefusesSave,
  PROVIDER_FIELD,
  readSaveAnyway,
  SAVE_ANYWAY_FIELD,
  saveRefusedNotice,
  SHARED_PASSWORD_FIELD,
  stepFromEdit,
  stepFromLookup,
  stringField,
  stepFromProvider,
  withSharedPassword,
  type AutoconfigAnswer,
  type MailboxCreatedAnswer,
  type MailboxErrorAnswer,
  type MailboxProbeAnswer,
  type MailboxSetupStep,
  type MailboxStampAnswer,
  type ProvidersAnswer,
  type MailboxProbeReport,
} from "../shared/settings-api.js";
import {
  renderMailboxAddress,
  renderMailboxForm,
  renderMailboxList,
  renderMailboxProviders,
  renderMailboxSuggestion,
  SETTINGS_HEADERS,
  type ProbeReportView,
} from "./settings-pages.js";
import { requireSettingsAssertion, type VerifiedAssertion } from "./settings-assertion.js";

export interface SettingsRouterDeps {
  store: AccountsStore;
  issuer: string;
  settingsKey: string;
  log: Logger;
}

// The three per-service passwords a draft has, plus the cascade's own single
// box — which is not one of `MAILBOX_FIELDS` and would otherwise survive
// `sanitize()` into a re-rendered page's values as the one secret the strip
// missed.
const PASSWORD_FIELDS = new Set<string>([...MAILBOX_SECRET_FIELDS, SHARED_PASSWORD_FIELD]);
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** Thrown by an individual field parser; caught and folded into the errors record. */
class FormError extends Error {
  constructor(
    public readonly field: string,
    message: string
  ) {
    super(message);
    this.name = "FormError";
  }
}

type FormBody = Record<string, unknown>;

/**
 * A form field, or "" for one that is missing or repeated.
 *
 * This is {@link stringField} applied to a body and a key, and it is written as
 * a call to it rather than as a fourth copy of the rule. There were three: one
 * in `shared/settings-api.ts`, one in `oauth/src/setup-routes.ts`, and a `text`
 * closure in `draftFromFields` — #134 collapsed those and its CHANGELOG entry
 * said "there is one now, exported", which was untrue while this one stood.
 * The duplicate guard could not see it: it collides on the *body*, not on the
 * name, which is the same fail-open class that guard has now been widened for
 * twice.
 */
function raw(body: FormBody, key: string): string {
  return stringField(body[key]);
}

function checkbox(body: FormBody, key: string): boolean {
  return raw(body, key) === CHECKBOX_ON;
}

/**
 * A blank password field means "keep the stored one", which is the whole reason the
 * form can be rendered without ever emitting a password. On create there is nothing
 * to keep, so blank is an error instead.
 */
function mergedPassword(field: string, submitted: string, stored: string | undefined): string {
  if (submitted !== "") return submitted;
  if (stored !== undefined) return stored;
  throw new FormError(field, "Required.");
}

/** Everything the operator submitted, minus every password field and the
 * CSRF/stamp/action bookkeeping fields — safe to hand back into the form on
 * a validation failure. */
function sanitize(body: FormBody): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(body)) {
    if (key === "_csrf" || key === "_stamp" || key === "_action") continue;
    // Not a field of the mailbox: the button that asked for *Save anyway*.
    // Echoing it back into a re-rendered form would make the next submission
    // an override the operator did not press anything for.
    if (key === SAVE_ANYWAY_FIELD) continue;
    if (PASSWORD_FIELDS.has(key)) continue;
    if (typeof value === "string") values[key] = value;
  }
  return values;
}

/**
 * The same values, with the submitted passwords kept rather than stripped.
 *
 * Every re-render of a mailbox form uses this, and it is not a convenience.
 * {@link sanitize} strips every password, and `renderMailboxForm` marks the IMAP
 * and SMTP boxes `required` when there is no account behind the form — so any
 * re-render of the **create** form handed the operator two empty, mandatory
 * password boxes. On the probe-refusal page, whose notice ends "…or press Save
 * anyway to store it without testing it", pressing that button did nothing but
 * pop the browser's "Please fill out this field" bubble on a box the server had
 * just cleared: the advertised escape hatch was a dead end, on the exact screen
 * the milestone's deployment failure happened on. The *Test connection* answer
 * had the same shape — probe, then a form you cannot save.
 *
 * Carrying them is the rule the cascade already follows (#120): they came from
 * this operator over this session, they are already in memory, and the form says
 * on its face that the password is carried rather than asked for again.
 *
 * This used to say the **edit** form needed none of it, because blank there
 * means "keep the stored one", so its boxes are not `required` and clearing them
 * is right. The first half of that is still true and is why this function
 * carries only the *submitted* non-empty secrets — a box the operator left blank
 * stays blank, and still means "unchanged". The second half was the browser's
 * half of the question and missed the data half (#184): a cleared box on the
 * edit form does not merely fail to be re-typed, it *resubmits as blank*, and
 * `mergedPassword` reads blank as the stored password. So *Save anyway* on a
 * refused edit stored the password that was already there — the one the server
 * had just refused — while telling the operator the one they typed had been
 * stored without testing it. Carrying the submitted secrets is what makes a
 * blank box mean "unchanged" and a filled one mean what they typed.
 *
 * `fields` is the *flattened* submission: the cascade's single password box has
 * already been spread across the services it names, which raw `body` has not.
 * The edit routes have no such box, and pass `body` itself.
 */
function withCarriedPasswords(body: FormBody, fields: FormBody): Record<string, string> {
  const values = sanitize(body);
  for (const name of MAILBOX_SECRET_FIELDS) {
    const submitted = raw(fields, name);
    if (submitted !== "") values[name] = submitted;
  }
  return values;
}

type ParsedForm = { account: Account; errors?: undefined } | { account?: undefined; errors: Record<string, string> };

/**
 * Build an `Account` from a submitted form, applying the blank-password merge
 * rule against `existing` (null on create). Every validation failure is
 * collected by field name rather than the parse stopping at the first one, so
 * a resubmission can fix everything at once instead of one field per round trip.
 */
function parseAccountForm(body: FormBody, existing: Account | null): ParsedForm {
  const errors: Record<string, string> = {};

  function requireStr(key: string): string {
    const v = raw(body, key);
    if (v.trim() === "") {
      errors[key] = "Required.";
    }
    return v;
  }

  function requirePort(key: string): number {
    const v = raw(body, key);
    const n = Number(v);
    if (v.trim() === "" || !Number.isInteger(n) || n < 1 || n > 65535) {
      errors[key] = "Must be a port number between 1 and 65535.";
      return 0;
    }
    return n;
  }

  function password(key: string, stored: string | undefined): string {
    try {
      return mergedPassword(key, raw(body, key), stored);
    } catch (err) {
      if (err instanceof FormError) {
        errors[err.field] = err.message;
        return "";
      }
      throw err;
    }
  }

  let id: string;
  if (existing) {
    id = existing.id;
  } else {
    id = requireStr(MAILBOX_FIELDS.id);
    if (id !== "" && !ID_PATTERN.test(id)) {
      errors[MAILBOX_FIELDS.id] ="Use lowercase letters, digits, _ or -, up to 32 characters, starting alphanumeric.";
    } else if (RESERVED_IDS.has(id)) {
      // Same rule AccountsStore.create() enforces (see RESERVED_IDS in
      // accounts.ts) — caught here too so the operator sees a clean field
      // error instead of the generic AccountsStoreError re-render below.
      errors[MAILBOX_FIELDS.id] =`"${id}" is reserved and can't be used as a mailbox id. Choose another id.`;
    }
  }

  const label = requireStr(MAILBOX_FIELDS.label);
  const isDefault = checkbox(body, MAILBOX_FIELDS.isDefault);

  const imapHost = requireStr(MAILBOX_FIELDS.imapHost);
  const imapPort = requirePort(MAILBOX_FIELDS.imapPort);
  const imapUser = requireStr(MAILBOX_FIELDS.imapUser);
  const imapPass = password(MAILBOX_FIELDS.imapPass, existing?.imap.pass);
  const imapTls = checkbox(body, MAILBOX_FIELDS.imapTls);

  const smtpHost = requireStr(MAILBOX_FIELDS.smtpHost);
  const smtpPort = requirePort(MAILBOX_FIELDS.smtpPort);
  const smtpUser = requireStr(MAILBOX_FIELDS.smtpUser);
  const smtpPass = password(MAILBOX_FIELDS.smtpPass, existing?.smtp.pass);
  const smtpTls = checkbox(body, MAILBOX_FIELDS.smtpTls);

  const defaultFrom = requireStr(MAILBOX_FIELDS.mailDefaultFrom);
  const defaultFromNameRaw = raw(body, MAILBOX_FIELDS.mailDefaultFromName);
  const draftsFolderRaw = raw(body, MAILBOX_FIELDS.mailDraftsFolder);
  const draftsFolder = draftsFolderRaw.trim() === "" ? "Drafts" : draftsFolderRaw;
  const sentFolderRaw = raw(body, MAILBOX_FIELDS.mailSentFolder);
  const sentFolder = sentFolderRaw.trim() === "" ? null : sentFolderRaw;

  const removeCaldav = checkbox(body, "remove_caldav");
  const caldavUrl = raw(body, MAILBOX_FIELDS.caldavUrl);
  const caldavUser = raw(body, MAILBOX_FIELDS.caldavUser);

  let caldav: CalDavCreds | undefined;
  if (removeCaldav) {
    // Explicit removal — caldav stays undefined below.
  } else if (caldavUrl.trim() === "") {
    if (existing?.caldav) {
      // Clearing the URL field is not how a CalDAV block is removed — that is
      // the "Remove CalDAV" checkbox above. Falling through to `undefined`
      // here would silently drop the stored CalDAV username and password
      // from accounts.json the moment the operator saves.
      errors[MAILBOX_FIELDS.caldavUrl] = 'Required — tick "Remove CalDAV" to remove it.';
    }
    // No existing CalDAV block and a blank URL: there was never a CalDAV
    // block to begin with, which is not an error.
  } else {
    if (caldavUser.trim() === "") {
      errors[MAILBOX_FIELDS.caldavUser] = "Required.";
    }
    const caldavPass = password(MAILBOX_FIELDS.caldavPass, existing?.caldav?.pass);
    caldav = { url: caldavUrl, user: caldavUser, pass: caldavPass };
  }

  if (Object.keys(errors).length > 0) {
    return { errors };
  }

  return {
    account: {
      id,
      label,
      default: isDefault ? true : undefined,
      imap: { host: imapHost, port: imapPort, user: imapUser, pass: imapPass, tls: imapTls },
      smtp: { host: smtpHost, port: smtpPort, user: smtpUser, pass: smtpPass, tls: smtpTls },
      mail: {
        defaultFrom,
        defaultFromName: defaultFromNameRaw.trim() === "" ? undefined : defaultFromNameRaw,
        draftsFolder,
        sentFolder,
      },
      caldav,
    },
  };
}

/** `ProbeReport` (probe.ts) and `ProbeReportView` (settings-pages.ts) declare
 * the same shape independently rather than sharing a type, since
 * settings-pages.ts must compile without importing probe.ts; this is a
 * structural, no-op conversion between the two. */
function toProbeView(report: ProbeReport): ProbeReportView {
  return { imap: report.imap, smtp: report.smtp, caldav: report.caldav };
}

/**
 * The same report, as the wire contract declares it.
 *
 * Also a no-op conversion: `ProbeResult` carries `credentialRejection` as a
 * required boolean and `MailboxProbeOutcome` as an optional one, which is a
 * widening. Spelled out so that a change to either shape fails here rather than
 * silently sending the wizard a document it reads as unreadable.
 */
function toWireReport(report: ProbeReport): MailboxProbeReport {
  return { imap: report.imap, smtp: report.smtp, caldav: report.caldav };
}

/**
 * What the provider table has to say to somebody whose password was just
 * refused, or null.
 *
 * Whether to say anything at all is `credentialRejectionRefusesSave`, in the
 * wire contract, walking the same two services `saveRefusedNotice` walks. This
 * file used to answer that question for itself, over all three services, and
 * the two disagreed about CalDAV — see that function's comment. A host that
 * never answered has said nothing about which password it wanted, which is the
 * distinction `shared/credential-failure.ts` exists to draw (#148, #146).
 *
 * `unsupported` comes first, and that ordering is the whole of #184's second
 * half. An entry that carries one says no password this connector can send will
 * ever be accepted; an entry that carries a `credentialNote` says which password
 * to go and find. Where the table has both kinds of knowledge about an address
 * it only ever has the stronger one — `microsoft` and `proton` carry
 * `unsupported` and deliberately carry no note — so without this line an
 * `@outlook.com` refusal fell through to the generic app-password sentence and
 * sent its operator hunting for a passcode Microsoft does not issue.
 */
function rejectionNoteFor(email: string, rejected: boolean): string | null {
  // The two halves are gated differently, and that is the correction #184's
  // first attempt got wrong. An `unsupported` entry is a fact about the
  // *address* — it holds however the probe failed, and Proton is the reason it
  // has to: Proton answers no IMAP from the internet, so its failure is
  // connectivity and a rejection-only gate hid the one note that explains it.
  // A `credentialNote` is about a password, so it needs a server to have
  // actually complained about one.
  return unsupportedNoticeFor(email) ?? (rejected ? credentialNoteFor(email) : null);
}

/**
 * The sentence above a refused save, carrying this provider's own requirement
 * when the failure was a rejection and the address's domain has one.
 *
 * `saveRefusedNotice` substitutes it for the generic app-password sentence
 * rather than printing both — see its own comment. Three ways to get the
 * untargeted sentence back, all of them deliberate: the failure was
 * connectivity rather than credentials, the domain is not in the advice table,
 * or its entry carries neither an `unsupported` warning nor a note.
 */
function refusalNotice(wire: MailboxProbeReport, email: string): string {
  const note = probeRefusesSave(wire)
    ? rejectionNoteFor(email, credentialRejectionRefusesSave(wire))
    : null;
  return saveRefusedNotice(wire, note ?? undefined) ?? "";
}

/**
 * The same note on the routes that only test, which store nothing and so have
 * no refusal sentence for it to replace.
 *
 * The scope is wider here than on a save, deliberately. A save is refused by
 * IMAP or SMTP alone, so that path asks {@link credentialRejectionRefusesSave};
 * *Test connection* stores nothing, so the honest question is whether **any**
 * probed server refused a password — CalDAV included. Asking the save-scoped
 * question here silently dropped the note from a Fastmail mailbox whose CalDAV
 * password was wrong while IMAP and SMTP answered, which is the one case where
 * Fastmail's note is the whole explanation.
 */
function credentialAdvice(report: ProbeReport, email: string): { notice?: string } {
  const wire = toWireReport(report);
  const note = probeFailed(wire) ? rejectionNoteFor(email, anyCredentialRejection(wire)) : null;
  return note === null ? {} : { notice: note };
}

/**
 * The gate #147 put in front of both write routes: test the credentials before
 * anything is written, and hand the caller the report.
 *
 * `null` is "nothing was probed", which is the operator having pressed *Save
 * anyway* — the whole of the escape hatch: a server in maintenance, a network
 * blip, or someone who knows better is not made to argue with a probe. What
 * makes a report a refusal is `probeRefusesSave`, which is in the wire contract
 * rather than here, because the wizard has to reach the same verdict.
 *
 * The rule lives here, in the connector, and in one place. Before #147 it lived
 * in the setup wizard — which called the probe route, read the result and only
 * then called the create route — so the rule was in the caller rather than in
 * the thing being protected, and the settings UI, the path an operator uses for
 * every mailbox after the first, had no such rule at all. That is how a Gmail
 * mailbox whose password the server rejects came to sit in `accounts.json`
 * having never authenticated once.
 *
 * CalDAV is not in the condition. It is optional in the account model and fails
 * for benign reasons far too often to gate a mailbox on; the report comes back
 * either way, so the failure is *shown* on the page the save succeeded on
 * rather than costing the operator their mailbox.
 */
async function probeBeforeWrite(
  account: Account,
  saveAnyway: boolean
): Promise<ProbeReport | null> {
  if (saveAnyway) return null;
  return probeAccount({
    imap: account.imap,
    smtp: account.smtp,
    caldav: account.caldav,
  });
}

/**
 * What {@link gateOnProbe} decided, for the route that has to act on it.
 *
 * `proceed: false` means the answer has already gone out; the route returns and
 * writes nothing. `report` on the other branch is the wire-shaped report to
 * carry into the response the write produces, and `undefined` when nothing was
 * probed at all.
 */
type WriteGate = { proceed: false } | { proceed: true; report: MailboxProbeReport | undefined };

/**
 * Probe, decide, log, and answer a refusal — the whole of it, once.
 *
 * `probeBeforeWrite` above is the probe. This is the four steps around it, and
 * it exists because create and edit ran those four steps *separately* and had
 * already drifted apart doing so (#130, on the shape #147 left behind): one
 * routed its refusal through a helper that answered both content types and the
 * other inlined an HTML-only render; one sent `message` on the JSON path and the
 * other had no equivalent; the two `log("warn", …)` lines were hand-written
 * near-duplicates with different message strings; and `toWireReport(report)` was
 * recomputed three times on each path. It is converted exactly once here, and
 * the log line is one line with an `action` field rather than two strings that
 * an operator grepping their log has to know both of.
 */
async function gateOnProbe(opts: {
  res: Response;
  json: boolean;
  log: Logger;
  /** Which write this is. The only thing the two paths legitimately differ on. */
  action: "create" | "edit";
  /** The id the mailbox is stored under — the existing one on an edit. */
  id: string;
  /** The account as submitted, which is what gets probed. */
  candidate: Account;
  /** Everything a refusal needs to re-render the form the submission came from. */
  draft: Omit<DraftRefusal, "status" | "errors" | "probe" | "notice">;
}): Promise<WriteGate> {
  const { res, json, log, action, id, candidate, draft } = opts;
  const report = await probeBeforeWrite(candidate, readSaveAnyway(draft.body));
  // Null is *Save anyway*: nothing was probed, so there is nothing to refuse on
  // and nothing to state afterwards either.
  if (report === null) return { proceed: true, report: undefined };
  const wire = toWireReport(report);
  if (!probeRefusesSave(wire)) return { proceed: true, report: wire };
  log("warn", "settings: a mailbox was refused by the connection test", {
    action,
    id,
    imap: report.imap.ok,
    smtp: report.smtp.ok,
  });
  sendDraftRefusal(res, json, {
    ...draft,
    status: 400,
    probe: report,
    // #148: on a credential rejection this carries what *this provider* wants
    // in place of the wire contract's generic app-password sentence — a
    // replacement, never a second sentence beside it. The address comes off the
    // candidate rather than the body because that is the one already parsed.
    notice: refusalNotice(wire, candidate.mail.defaultFrom),
  });
  return { proceed: false };
}

function findAccount(store: AccountsStore, id: string): Account | undefined {
  return store.list().find((a) => a.id === id);
}

/** `:id` is declared as a single path segment, so Express only ever hands back a
 * plain string here — the `string | string[]` in the type is for wildcard/array
 * params elsewhere in Express's typings, not a case this route can hit. */
function idParam(req: { params: Record<string, string | string[]> }): string {
  const value = req.params.id;
  return Array.isArray(value) ? (value[0] ?? "") : value;
}

/**
 * Which screen of the *Add mailbox* cascade a GET is asking for.
 *
 * Anything unrecognised is tier 1, because a mistyped query is not a reason to
 * show someone eighteen empty boxes.
 */
function viewOf(req: Request): "address" | "providers" | "manual" {
  const view = req.query?.view;
  if (view === "providers" || view === "manual") return view;
  return "address";
}

/**
 * An id and a label for a mailbox that is not the first one.
 *
 * The setup wizard has no need of this: its mailbox is `main`, there is nothing
 * on disk to collide with, and it says so on the screen. Every mailbox added
 * afterwards needs an id of its own, and one derived from the address is the
 * obvious guess — so it is offered as a *filled-in box* on the confirmation
 * screen rather than applied, which is the same rule the derived server settings
 * beside it follow. Deriving it here rather than letting the operator meet
 * "Mailbox 'anna' already exists." after pressing Save is the whole point.
 *
 * It has to satisfy {@link ID_PATTERN}, so it is built to: lowercased, anything
 * outside the allowed set folded to `-`, a leading non-alphanumeric trimmed, and
 * short enough that the collision suffix still fits.
 */
function suggestedIdentity(email: string, taken: readonly string[]): { id: string; label: string } {
  const at = email.lastIndexOf("@");
  const localPart = at <= 0 ? email : email.slice(0, at);
  const stem =
    localPart
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^[^a-z0-9]+/, "")
      .slice(0, 32) || "mailbox";

  let id = stem;
  for (let n = 2; taken.includes(id) || RESERVED_IDS.has(id); n += 1) {
    id = `${stem.slice(0, 28)}-${n}`;
  }
  return { id, label: email };
}

function assertionOf(res: Response): VerifiedAssertion {
  // Safe: every route below runs `requireSettingsAssertion` first, which is the
  // only place that ever sets `res.locals.assertion`.
  return res.locals.assertion!;
}

function sendHtml(res: Response, status: number, html: string): void {
  res.status(status).type("html").set(SETTINGS_HEADERS).send(html);
}

function sendPlain(res: Response, status: number, text: string): void {
  res.status(status).type("text/plain").set(SETTINGS_HEADERS).send(text);
}

/**
 * The same answers, as JSON.
 *
 * The header set goes out unchanged. Most of it is about a page rather than a
 * document — a CSP means nothing to a `fetch` — but `Cache-Control: no-store`
 * means exactly as much here, these bodies carry the same account details the
 * pages do, and one send path with one header set is easier to keep right than
 * two.
 */
function sendJson(
  res: Response,
  status: number,
  payload:
    | MailboxProbeAnswer
    | MailboxStampAnswer
    | MailboxCreatedAnswer
    | MailboxErrorAnswer
    | AutoconfigAnswer
    | ProvidersAnswer
): void {
  res.status(status).type("application/json").set(SETTINGS_HEADERS).json(payload);
}

/**
 * The fourth send site: a redirect, with the same header set and no body.
 *
 * Every other answer this router gives goes out through one of the three above,
 * each of which chains `.set(SETTINGS_HEADERS)`. The redirects did not: they
 * were bare `res.redirect(303, …)` calls, so an operator's browser got the
 * response after *Save*, *Make default* or *Delete* with no `Cache-Control:
 * no-store`, no CSP, no `X-Frame-Options` and no `Referrer-Policy` (#127).
 *
 * `.end()` rather than `res.redirect()` for the same reason the OAuth layer's
 * namesake uses it (#136): `res.redirect` content-negotiates a courtesy
 * `<p>See Other. Redirecting to …</p>` into a response whose status says there
 * is nothing to read. An empty body is the contract here, not an incidental
 * property of a 303 — see `oauth/src/settings-pages.ts`.
 *
 * There is deliberately no `csp` parameter. `SETTINGS_HEADERS` is hardcoded
 * because a response with no body has no document for a CSP to govern; the
 * header rides along only so that a set which must not drift stays one set.
 *
 * This lives here beside its three siblings rather than in settings-pages.ts,
 * where the OAuth package keeps its own. See the note on the re-exports in
 * `src/settings-pages.ts` for why the two are not mirrored.
 */
function sendRedirect(res: Response, status: number, location: string): void {
  res.status(status).set(SETTINGS_HEADERS).set("Location", location).end();
}

/**
 * Whether this caller wants JSON rather than a page.
 *
 * `req.accepts` decides it, which fails safe in the direction that matters: a
 * browser sends `text/html,…` and a bare `fetch` sends the wildcard, and both
 * of those pick "html" out of this list. Only an explicit `application/json`
 * picks JSON. A body that arrived as JSON counts too — answering a JSON
 * document with a rendered form would be a half-and-half state nobody could
 * act on.
 */
function wantsJson(req: Request): boolean {
  return req.accepts(["html", "json"]) === "json" || req.is("application/json") === "application/json";
}

/** What a JSON body that is not a mailbox draft is told. */
const MALFORMED_DRAFT =
  "The request body was not a mailbox draft: it needs a `mailbox` object with id, " +
  "label, default, mail, imap and smtp.";

/**
 * A refused write, said back to whoever asked for it.
 *
 * Everything below that says "no" to a mailbox draft says the same two things
 * in the same two ways: as `MailboxErrorAnswer` for a JSON caller, and as the
 * form re-rendered with the submission still in it for a browser. That fork was
 * written out five separate times — a closure in `POST /settings/mailboxes`, a
 * second closure beside it for the probe's refusal, and longhand in the three
 * routes after (#130).
 */
interface DraftRefusal {
  status: number;
  csrf: string;
  /** The stamp the re-rendered form resubmits under — the caller's, or a fresh one after a stale-stamp 409. */
  stamp: string;
  /** The submission, echoed back minus its passwords and bookkeeping fields. */
  body: FormBody;
  /** The account being edited, or null on the create routes. */
  account: Account | null;
  /** Per-field messages. Empty when no field the operator typed is wrong. */
  errors?: Record<string, string>;
  /**
   * The probe report, when the probe is why nothing was stored (#147).
   *
   * `errors` stays empty in that case on purpose: what failed is the server on
   * the other end, and marking a box red would send the operator to correct
   * something that is already correct.
   */
  probe?: ProbeReport;
  /** The sentence above the form. `saveRefusedNotice`'s, so the wizard says the same one. */
  notice?: string;
  /**
   * The submitted fields, flattened, whose passwords the re-rendered form keeps.
   * Set on every route that re-renders a mailbox form — see
   * {@link withCarriedPasswords}, which is where the reasoning lives. Leaving it
   * unset on the edit routes is what #184 was.
   */
  carry?: FormBody;
}

function sendDraftRefusal(res: Response, json: boolean, refusal: DraftRefusal): void {
  const { status, csrf, stamp, body, account, errors = {}, probe, notice, carry } = refusal;
  if (json) {
    // Status and not a shape of its own: from a caller's side a probe refusal
    // is the same class of answer as a field the parser would not take, which
    // the wizard's `ConnectorAnswer` already reads as `rejected`. What makes it
    // actionable is the report, so it travels with the refusal.
    sendJson(res, status, {
      ...(notice === undefined ? {} : { message: notice }),
      errors,
      ...(probe === undefined ? {} : { probe: toWireReport(probe) }),
    });
    return;
  }
  sendHtml(
    res,
    status,
    renderMailboxForm({
      csrf,
      stamp,
      account,
      values: carry === undefined ? sanitize(body) : withCarriedPasswords(body, carry),
      errors,
      ...(probe === undefined ? {} : { probe: toProbeView(probe) }),
      ...(notice === undefined ? {} : { notice }),
      // This is the one function that refuses a draft, so it is the one place
      // that says so. The form used to work it out from `notice` being set,
      // which stopped being true the moment the /test routes gained a notice
      // of their own.
      refused: true,
    })
  );
}

/**
 * The submitted mailbox, as `parseAccountForm` wants it.
 *
 * The flat form body for an HTML submission; for a JSON one, the draft under
 * `mailbox` flattened onto the very same names. One parser, one set of rules,
 * one place a blank password means "keep the stored one" — the content type
 * changes how the fields arrive and nothing else. Null means the JSON body was
 * not a draft at all.
 */
function submittedFields(body: FormBody, json: boolean): FormBody | null {
  // The one password the cascade's screens ask for, spread across the services
  // the submission names. Inert for every other caller: the full form sends no
  // field under that name, and a JSON draft has its three password fields inside
  // `mailbox` where a top-level one cannot reach them.
  if (!json) return withSharedPassword(body);
  const draft = parseMailboxDraft(body.mailbox);
  return draft === null ? null : flattenDraft(draft);
}

function csrfMatches(expected: string, submitted: unknown): boolean {
  if (typeof submitted !== "string" || submitted.length === 0) return false;
  const expectedBuf = Buffer.from(expected, "utf8");
  const submittedBuf = Buffer.from(submitted, "utf8");
  if (expectedBuf.length !== submittedBuf.length) {
    // Still do a comparison of matching length so a length mismatch doesn't
    // finish measurably faster than a same-length mismatch.
    timingSafeEqual(expectedBuf, expectedBuf);
    return false;
  }
  return timingSafeEqual(expectedBuf, submittedBuf);
}

/**
 * Guard every state-changing settings route. Compares `req.body._csrf` against
 * the assertion's own `csrf` claim — never a cookie, which the OAuth layer never
 * forwards here.
 */
function requireFormCsrf(): RequestHandler {
  return (req, res, next) => {
    const assertion = assertionOf(res);
    const submitted = (req.body as FormBody | undefined)?._csrf;
    if (!csrfMatches(assertion.csrf, submitted)) {
      sendPlain(res, 403, "Forbidden");
      return;
    }
    next();
  };
}

export function createSettingsRouter(deps: SettingsRouterDeps): Router {
  const { store, issuer, settingsKey, log } = deps;
  const router = express.Router();
  const formBody = express.urlencoded({ extended: false, limit: "64kb" });
  // Chained ahead of `formBody` on the routes that also answer JSON. Each
  // parser ignores a body of the other's content type, so the pair is exactly
  // "read whichever of the two this is" and neither route grew a branch for it.
  //
  // The pair only *is* that, rather than looking like it, because nothing
  // upstream parses JSON first: body-parser sets `req._body` and every later
  // json() short-circuits on it, so an app-wide express.json() would make this
  // one dead code and its 64 KB a fiction — which it was until #137. src/app.ts
  // now scopes its 5 MB parser to the single route that needs that size. Both
  // branches of a settings route cap here, at the same number.
  const jsonBody = express.json({ limit: "64kb" });
  const guardAssertion = requireSettingsAssertion({ key: settingsKey, issuer, log });
  const guardCsrf = requireFormCsrf();

  /**
   * What a new mailbox starts out as, before a lookup or a preset fills it in.
   *
   * The wizard's equivalent is a four-entry constant; this one has to look at
   * the store, because a *second* mailbox needs an id nothing else has taken and
   * because whether it should be the default depends on whether there is
   * anything else. Everything in here is shown to the operator in a box they can
   * change before anything is written.
   */
  function newMailboxDefaults(email: string): Record<string, string> {
    const existing = store.list();
    const identity = suggestedIdentity(
      email,
      existing.map((account) => account.id)
    );
    return {
      [MAILBOX_FIELDS.id]: identity.id,
      [MAILBOX_FIELDS.label]: identity.label,
      // The first mailbox on a fresh instance is the one the mail tools reach
      // for when none is named; a further one is not, unless the operator says
      // so on the full form.
      [MAILBOX_FIELDS.isDefault]: existing.length === 0 ? CHECKBOX_ON : "",
      [MAILBOX_FIELDS.imapPort]: "993",
      [MAILBOX_FIELDS.smtpPort]: "465",
      [MAILBOX_FIELDS.mailDraftsFolder]: "Drafts",
      [MAILBOX_FIELDS.mailSentFolder]: "Sent",
    };
  }

  /**
   * One step of the cascade, rendered in this UI's chrome.
   *
   * The switch is total over {@link MailboxSetupStep}, so a screen added to the
   * cascade stops this file compiling rather than falling through to a blank
   * page. Which step it is was decided in settings-api.ts, by the same functions
   * the wizard calls; what is decided here is only how it looks and what status
   * it goes out under.
   *
   * Two slots, not one, which is #186. `notice` is the screen's own sentence
   * about **this submission** — "Nothing has been saved…", "…settings have been
   * filled in…" — and stays a parameter, because only the caller knows what it
   * just did. The warning is about **the address**, stays true for every screen
   * that address survives on, and travels on the step itself, decided by the
   * `stepFrom*` functions in settings-api.ts that the wizard calls too. They
   * shared this one parameter until #186, and the three `_action` branches
   * fought over it: an operator who typed `anna@outlook.com`, was correctly
   * warned, and pressed *Edit these* got a sentence about nothing having been
   * saved in its place.
   */
  async function sendStep(
    res: Response,
    csrf: string,
    step: MailboxSetupStep,
    notice?: string
  ): Promise<void> {
    // Rendered as its own box above the screen's own notice, on every screen
    // that can carry one. Absent rather than empty, the way `notice` is, so a
    // page never paints a box with nothing in it.
    const warning = step.unsupported === null ? {} : { warning: step.unsupported };

    switch (step.view) {
      case "address":
        // The only way back to tier 1 is an address that could not be read, so
        // this is a rejected submission rather than a fresh screen. Nothing is
        // known about an address with no domain in it, which is why this screen
        // is the one variant with no warning slot on it.
        sendHtml(
          res,
          400,
          renderMailboxAddress({ csrf, email: step.email, errors: step.errors })
        );
        return;

      case "suggestion":
        sendHtml(
          res,
          200,
          renderMailboxSuggestion({
            csrf,
            stamp: await store.stamp(),
            domain: step.domain,
            sourceLabel: step.sourceLabel,
            values: step.values,
            password: step.password,
            // #151 arrives here: a domain whose autoconfig answers — Microsoft's
            // does — but whose server will refuse every password anyway.
            ...warning,
            ...(notice === undefined ? {} : { notice }),
          })
        );
        return;

      case "providers":
        sendHtml(
          res,
          Object.keys(step.errors).length === 0 ? 200 : 400,
          renderMailboxProviders({
            csrf,
            providers: providerPresets(step.email),
            domain: step.domain,
            email: step.email,
            selected: step.selected,
            password: step.password,
            errors: step.errors,
            // #151's other landing: Proton publishes no autoconfig, so an
            // address there falls to the provider list, and this is where the
            // Bridge sentence has to be.
            ...warning,
            ...(notice === undefined ? {} : { notice }),
          })
        );
        return;

      case "manual":
        sendHtml(
          res,
          200,
          renderMailboxForm({
            csrf,
            stamp: await store.stamp(),
            account: null,
            values: step.values,
            ...warning,
            notice:
              notice ??
              (step.preset === null
                ? "Nothing has been saved. Fill in the rest and press Save."
                : `${step.preset.label} settings have been filled in. Check them, ` +
                  "and test the connection before saving."),
          })
        );
        return;
    }
  }

  /**
   * Where a browser lands after a save: the mailbox list.
   *
   * Still a 303 when there is nothing extra to say, so a reload of the list
   * cannot re-submit the form. The one exception is the failure the save
   * deliberately does not refuse on — a CalDAV block that did not work. That
   * has to be *shown*, and a redirect carries nothing, so the list is rendered
   * here instead with the notice on it. The operator is on the same page either
   * way; they are simply told the one thing a 303 could not have told them.
   */
  async function sendSavedPage(
    res: Response,
    csrf: string,
    report: MailboxProbeReport | undefined
  ): Promise<void> {
    const notice = report === undefined ? null : caldavFailureNotice(report);
    if (notice === null) {
      sendRedirect(res, 303, "/settings/mailboxes");
      return;
    }
    const accounts = store.list();
    sendHtml(
      res,
      200,
      renderMailboxList({
        csrf,
        stamp: await store.stamp(),
        accounts,
        notice,
        rowNotices: Object.fromEntries(
          reservedIdAccounts(accounts).map((a) => [a.id, reservedIdNotice(a.id)])
        ),
      })
    );
  }

  router.get("/settings/mailboxes", guardAssertion, async (_req, res) => {
    const assertion = assertionOf(res);
    const stamp = await store.stamp();
    const accounts = store.list();
    sendHtml(
      res,
      200,
      renderMailboxList({
        csrf: assertion.csrf,
        stamp,
        accounts,
        // An account that predates the create-time check (or was hand-written
        // into accounts.json) keeps a broken in-place edit, and the list page is
        // the one place its operator is certain to look. See RESERVED_IDS in
        // accounts.ts for why the file is still loaded rather than refused.
        rowNotices: Object.fromEntries(
          reservedIdAccounts(accounts).map((a) => [a.id, reservedIdNotice(a.id)])
        ),
      })
    );
  });

  /**
   * Add mailbox — the address screen by default, the other two on `?view=`.
   *
   * A bare URL is tier 1, which is what makes the address screen the one an
   * operator meets from the *Add mailbox* link and the full form the fallback
   * rather than the front door (#141). Anything unrecognised in `?view=` is
   * tier 1 too: a mistyped query is not a reason to show someone eighteen boxes.
   *
   * The JSON branch is unchanged and is still the stamp. It is what the setup
   * wizard reads here, and it does not go through the cascade at all — the
   * wizard runs its own copy of these screens in its own chrome and posts
   * finished drafts to `/settings/mailboxes`.
   */
  router.get("/settings/mailboxes/new", guardAssertion, async (req, res) => {
    const assertion = assertionOf(res);
    const stamp = await store.stamp();
    if (wantsJson(req)) {
      // The stamp is the whole of what a programmatic caller comes here for: it
      // is what a later write has to still be against, and reading it off this
      // route rather than a new one is why there is no new route.
      sendJson(res, 200, { stamp });
      return;
    }

    const view = viewOf(req);
    if (view === "manual") {
      sendHtml(res, 200, renderMailboxForm({ csrf: assertion.csrf, stamp, account: null }));
      return;
    }
    if (view === "providers") {
      sendHtml(
        res,
        200,
        renderMailboxProviders({
          csrf: assertion.csrf,
          providers: providerPresets(""),
          domain: "",
          email: "",
          selected: "",
          password: "",
        })
      );
      return;
    }
    sendHtml(res, 200, renderMailboxAddress({ csrf: assertion.csrf, email: "" }));
  });

  /**
   * Add mailbox — the cascade's three steps, told apart by `_action`.
   *
   *   `lookup`    tier 1 — ask this connector's own autoconfig what the
   *               address's domain says, and show it for confirmation, or fall
   *               through to tier 2
   *   `provider`  tier 2 — a chosen preset, filled into the full form
   *   `edit`      the confirmation screen's `Edit these`, likewise
   *
   * None of them stores anything, probes anything or decides anything about a
   * mailbox: each one produces the next screen, and every path that ends in an
   * account ends at `POST /settings/mailboxes`, which is unchanged. The
   * branching itself is `stepFrom*` in settings-api.ts — the same three
   * functions the wizard's step 2 calls, so the cascade exists once (#141).
   *
   * Registered ahead of `POST /settings/mailboxes/:id`, which it would otherwise
   * be ambiguous with; `new` is already a reserved account id for exactly that
   * reason (see RESERVED_IDS in accounts.ts).
   */
  router.post(
    "/settings/mailboxes/new",
    guardAssertion,
    formBody,
    guardCsrf,
    async (req, res) => {
      const body = req.body as FormBody;
      const assertion = assertionOf(res);
      const action = raw(body, "_action");
      const email = raw(body, ADDRESS_FIELD);
      const password = raw(body, SHARED_PASSWORD_FIELD);
      // #151 and #186. The warning is a fact about the address, so it is read
      // once here for every branch rather than at one of them: the address is
      // in the body of all three submissions, and re-deriving it is a table
      // lookup in this package. Nothing is carried between screens for it,
      // which is the difference between this UI and the wizard — the wizard is
      // *told* the sentence over the wire (#180) because it must not grow a
      // second copy of the domain set, and carries it forward from there.
      //
      // It warns and nothing else: the save is never blocked, because an
      // operator running a Proton Mail Bridge has a configuration that works
      // and must be able to carry on.
      const unsupported = unsupportedNoticeFor(email);

      if (action === "lookup") {
        // Reached as a function call, not over a hop: `src/autoconfig.ts` is in
        // this package, which is the half of #141 that was already easy. The §7
        // rules that make a user-derived fetch safe are in there and are not
        // restated here.
        const found = await lookupMailboxSettings(email);
        // A boolean and nothing else. Not the address, and not the hosts.
        log("info", "settings: add mailbox looked up an address", { found: found !== null });
        // The domain is known for the first time here, which is the earliest
        // this connector can say that no password will work at this provider —
        // and it is said now rather than after the save, because telling
        // somebody that once they have typed a password is worse than not
        // telling them at all.
        await sendStep(
          res,
          assertion.csrf,
          stepFromLookup({
            email,
            password,
            found,
            defaults: newMailboxDefaults(email),
            unsupported,
          })
        );
        return;
      }

      if (action === "provider") {
        const chosen = raw(body, PROVIDER_FIELD);
        await sendStep(
          res,
          assertion.csrf,
          stepFromProvider({
            email,
            password,
            chosen,
            presets: providerPresets(email),
            defaults: newMailboxDefaults(email),
            unsupported,
          })
        );
        return;
      }

      if (action === "edit") {
        await sendStep(
          res,
          assertion.csrf,
          stepFromEdit({
            fields: body,
            password,
            defaults: newMailboxDefaults(email),
            unsupported,
          }),
          "Nothing has been saved. Change whatever is wrong and test the connection."
        );
        return;
      }

      // Anything else is a submission this build does not have a screen for.
      // Tier 1 rather than a 400 page: there is nothing an operator could do
      // with the difference, and the address screen is where they were going.
      sendHtml(res, 400, renderMailboxAddress({ csrf: assertion.csrf, email: "" }));
    }
  );

  /**
   * The provider table, for the setup wizard.
   *
   * The table is `src/providers.ts`, in this package, because the settings UI
   * reads it as a local function call and because mirroring it into the OAuth
   * layer would have been the fourth byte-for-byte cross-package duplicate #126
   * is about. The wizard reads it here instead, over the same JSON surface it
   * already uses for the probe, the write, the accounts stamp and the autoconfig
   * lookup.
   *
   * Not negotiated, like `/settings/autoconfig` and for the same reason: there
   * is no page behind it. The connector's own screens call `providerPresets`
   * directly, so an HTML branch here would be a surface with no caller.
   *
   * `POST` rather than `GET` for the same two reasons the lookup is one: the
   * address stays out of the request line and out of everything that records
   * one, and the CSRF guard applies unchanged. The answer is always 200 — the
   * table is in code, so there is no failure for it to report.
   */
  router.post(
    "/settings/providers",
    guardAssertion,
    jsonBody,
    formBody,
    guardCsrf,
    (req, res) => {
      const email = raw(req.body as FormBody, "email");
      const answer: ProvidersAnswer = { providers: providerPresets(email) };
      sendJson(res, 200, answer);
    }
  );

  router.get("/settings/mailboxes/:id", guardAssertion, async (req, res) => {
    const account = findAccount(store, idParam(req));
    if (!account) {
      sendPlain(res, 404, "Mailbox not found.");
      return;
    }
    const assertion = assertionOf(res);
    const stamp = await store.stamp();
    sendHtml(res, 200, renderMailboxForm({ csrf: assertion.csrf, stamp, account }));
  });

  router.post(
    "/settings/mailboxes",
    guardAssertion,
    jsonBody,
    formBody,
    guardCsrf,
    async (req, res) => {
      const body = req.body as FormBody;
      const json = wantsJson(req);
      const assertion = assertionOf(res);
      const submittedStamp = raw(body, "_stamp");

      const fields = submittedFields(body, json);
      if (fields === null) {
        sendJson(res, 400, { message: MALFORMED_DRAFT, errors: {} });
        return;
      }

      // The one thing this route still binds for itself: which draft, whose
      // CSRF, and which content type. The fork itself is `sendDraftRefusal`.
      const rejected = (status: number, errors: Record<string, string>, stamp: string): void =>
        sendDraftRefusal(res, json, {
          status,
          csrf: assertion.csrf,
          stamp,
          body,
          account: null,
          errors,
          carry: fields,
        });

      const parsed = parseAccountForm(fields, null);
      if (parsed.errors) {
        rejected(400, parsed.errors, submittedStamp);
        return;
      }

      // Probe before the write, not beside it, and answer the refusal in one
      // place both write routes share. See `gateOnProbe`.
      const gate = await gateOnProbe({
        res,
        json,
        log,
        action: "create",
        id: parsed.account.id,
        candidate: parsed.account,
        draft: { csrf: assertion.csrf, stamp: submittedStamp, body, account: null, carry: fields },
      });
      if (!gate.proceed) return;

      try {
        await store.create(parsed.account, submittedStamp);
      } catch (err) {
        if (err instanceof StaleStampError) {
          rejected(409, { [MAILBOX_FIELDS.id]: err.message }, await store.stamp());
          return;
        }
        if (err instanceof AccountsStoreError) {
          rejected(400, { [MAILBOX_FIELDS.id]: err.message }, submittedStamp);
          return;
        }
        throw err;
      }
      const wireReport = gate.report;
      if (json) {
        // 201 and not the browser's 303: there is nowhere to send a caller that
        // is not a browser, and the two facts it wants are the id it now has
        // and where accounts.json got to. The status is what says "stored" —
        // the setup wizard reads nothing else out of this body, and an answer
        // that never arrives is settled by asking for the stamp again. The
        // report rides along so a caller that wants to say something about a
        // CalDAV block that did not work can, without probing a second time.
        sendJson(res, 201, {
          id: parsed.account.id,
          stamp: await store.stamp(),
          ...(wireReport === undefined ? {} : { probe: wireReport }),
        });
        return;
      }
      await sendSavedPage(res, assertion.csrf, wireReport);
    }
  );

  router.post(
    "/settings/mailboxes/test",
    guardAssertion,
    jsonBody,
    formBody,
    guardCsrf,
    async (req, res) => {
      const body = req.body as FormBody;
      const json = wantsJson(req);
      const assertion = assertionOf(res);
      const submittedStamp = raw(body, "_stamp");

      const fields = submittedFields(body, json);
      if (fields === null) {
        sendJson(res, 400, { message: MALFORMED_DRAFT, errors: {} });
        return;
      }

      const parsed = parseAccountForm(fields, null);
      if (parsed.errors) {
        // The same refusal the create route gives, because it is the same
        // refusal: this route is that one without the write (#130).
        sendDraftRefusal(res, json, {
          status: 400,
          csrf: assertion.csrf,
          stamp: submittedStamp,
          body,
          account: null,
          errors: parsed.errors,
          carry: fields,
        });
        return;
      }
      const report = await probeAccount({
        imap: parsed.account.imap,
        smtp: parsed.account.smtp,
        caldav: parsed.account.caldav,
      });
      if (json) {
        // `ProbeReport` already is the wire shape — `{ ok }` or
        // `{ ok, message }` per service, and null for a CalDAV block that was
        // never given. Nothing is stored on this route whatever it finds.
        sendJson(res, 200, { probe: report });
        return;
      }
      sendHtml(
        res,
        200,
        renderMailboxForm({
          csrf: assertion.csrf,
          stamp: submittedStamp,
          account: null,
          // Carried for the same reason a refusal carries them: this form's
          // password boxes are `required`, and the panel below tells the
          // operator to press Save next. See `withCarriedPasswords`.
          values: withCarriedPasswords(body, fields),
          probe: toProbeView(report),
          // #148. Nothing was stored and nothing was refused, so there is no
          // sentence for the note to replace — it is the whole notice here, and
          // only when the server actually rejected the credentials.
          ...credentialAdvice(report, raw(body, ADDRESS_FIELD)),
        })
      );
    }
  );

  /**
   * Tier 1 of the wizard's step 2: what this domain says its own mail settings
   * are.
   *
   * The lookup is `src/autoconfig.ts`, which is in this package because the §7
   * constraints that make it safe are — it fetches URLs derived from an address
   * an operator typed, and resolve-then-refuse, HTTPS-after-redirect, the two
   * deadlines and the body cap all live there and are tested there. The OAuth
   * layer cannot import any of that and must not grow a second copy, so it asks
   * here, exactly as it asks for a probe.
   *
   * Not negotiated, unlike the three mailbox routes: there is no page behind
   * this and never was one. The wizard renders the answer in its own chrome, and
   * an HTML branch here would be a surface with no caller and therefore no test.
   *
   * `POST` rather than `GET` for the two reasons a lookup keyed on an address
   * usually is: the address stays out of the request line and out of everything
   * that records one, and the CSRF guard the state-changing routes carry applies
   * unchanged — this route makes an outbound request on the strength of its
   * body, which is worth binding to the assertion the same way a write is.
   *
   * The answer is always 200. `lookupMailboxSettings` resolves with `null` for
   * every refusal in the cascade and never rejects, and this route keeps that
   * property rather than converting some of it into a status code: §7 says no
   * autoconfig failure is ever shown to the operator as an error, and the
   * wizard's response to `null` — the provider list — is the same one it has for
   * a domain that simply publishes nothing.
   *
   * ## What this route answers, since #180
   *
   * Not "what does this domain publish" but **"what does this connector know
   * about this address"**. The `unsupported` field on the answer is the
   * widening, and it is a widening worth making: the wizard posts an address
   * here at the one moment the domain becomes known and before any password is
   * typed, and "no password will work here" is knowledge about that address
   * rather than about the DNS records under it — which is arguably what an
   * operator was asking in the first place.
   *
   * The consequence to hold on to is that a **miss can carry a warning**. A
   * domain that publishes nothing and cannot be served — Proton — answers 200
   * with `suggestion: null` and a sentence, which is a shape this route did not
   * have before. Whatever the wizard does with a miss has to keep it.
   */
  router.post("/settings/autoconfig", guardAssertion, jsonBody, formBody, guardCsrf, async (req, res) => {
    const email = raw(req.body as FormBody, "email");

    // Structurally the type declared in settings-api.ts. Assigned rather than
    // mapped field by field on purpose: if the connector's own suggestion shape
    // ever moves, this line stops compiling instead of quietly sending the
    // wizard a document it will read as unreadable.
    const suggestion: LookupSuggestion | null = await lookupMailboxSettings(email);

    // #180. This is what widens the route from "what does this domain publish"
    // to "what does this connector know about this address" — which is what the
    // wizard was asking it, and is the objection option B has to answer. "No
    // password will work here" is knowledge about the address, not about the
    // DNS records under it, and this is the one moment the wizard already has
    // the address in hand and has not yet asked for a password.
    //
    // The domain match stays here, beside the table it reads, so the two UIs
    // cannot disagree about which addresses are warned and the wizard gets no
    // second copy of the domain set. Sent only when there is something to say:
    // an absent field is what a wizard on an older release already handles, and
    // what the field means for every ordinary address.
    const unsupported = unsupportedNoticeFor(email);

    // The address is not logged — nothing an operator types into the wizard is,
    // and an email address is the one field here that identifies a person.
    log("info", "settings: autoconfig lookup", { found: suggestion !== null });
    sendJson(res, 200, {
      suggestion,
      ...(unsupported === null ? {} : { unsupported }),
    });
  });

  router.post("/settings/mailboxes/:id", guardAssertion, formBody, guardCsrf, async (req, res) => {
    const existing = findAccount(store, idParam(req));
    if (!existing) {
      sendPlain(res, 404, "Mailbox not found.");
      return;
    }
    const body = req.body as FormBody;
    const assertion = assertionOf(res);
    const submittedStamp = raw(body, "_stamp");
    // `json` is false at every call below: this route is not negotiated — it has
    // no second caller — so the only branch `sendDraftRefusal` ever takes here
    // is the page one. It is used anyway so that the form a rejected edit comes
    // back on is assembled in exactly one place.
    const parsed = parseAccountForm(body, existing);
    if (parsed.errors) {
      sendDraftRefusal(res, false, {
        status: 400,
        csrf: assertion.csrf,
        stamp: submittedStamp,
        body,
        account: existing,
        errors: parsed.errors,
        carry: body,
      });
      return;
    }
    // The same gate the create route has — literally the same function now, so
    // the two cannot drift again — and for the same reason: an edit that
    // replaces a working password with one the server refuses leaves exactly
    // the mailbox #147 is about, and this is the route an operator uses for
    // every mailbox they already have.
    //
    // `carry` is what makes the refusal it produces honest (#184). Without it
    // the re-rendered form has empty password boxes, blank resubmits as "keep
    // the stored one", and *Save anyway* wrote back the very password the
    // server had just refused. `body` rather than a flattened draft: these
    // routes have no shared-password box to spread.
    const gate = await gateOnProbe({
      res,
      json: false,
      log,
      action: "edit",
      id: existing.id,
      candidate: parsed.account,
      draft: { csrf: assertion.csrf, stamp: submittedStamp, body, account: existing, carry: body },
    });
    if (!gate.proceed) return;

    try {
      await store.update(existing.id, parsed.account, submittedStamp);
    } catch (err) {
      if (err instanceof StaleStampError) {
        sendDraftRefusal(res, false, {
          status: 409,
          csrf: assertion.csrf,
          // The stamp the file is on now, not the one that lost the race: the
          // operator's next submission has to be able to win.
          stamp: await store.stamp(),
          body,
          account: existing,
          errors: { id: err.message },
          carry: body,
        });
        return;
      }
      if (err instanceof NoSuchAccountError || err instanceof AccountsStoreError) {
        sendDraftRefusal(res, false, {
          status: 400,
          csrf: assertion.csrf,
          stamp: submittedStamp,
          body,
          account: existing,
          errors: { id: err.message },
          carry: body,
        });
        return;
      }
      throw err;
    }
    await sendSavedPage(res, assertion.csrf, gate.report);
  });

  router.post("/settings/mailboxes/:id/test", guardAssertion, formBody, guardCsrf, async (req, res) => {
    const existing = findAccount(store, idParam(req));
    if (!existing) {
      sendPlain(res, 404, "Mailbox not found.");
      return;
    }
    const body = req.body as FormBody;
    const assertion = assertionOf(res);
    const submittedStamp = raw(body, "_stamp");
    const parsed = parseAccountForm(body, existing);
    if (parsed.errors) {
      sendDraftRefusal(res, false, {
        status: 400,
        csrf: assertion.csrf,
        stamp: submittedStamp,
        body,
        account: existing,
        errors: parsed.errors,
        carry: body,
      });
      return;
    }
    const report = await probeAccount({
      imap: parsed.account.imap,
      smtp: parsed.account.smtp,
      caldav: parsed.account.caldav,
    });
    sendHtml(
      res,
      200,
      renderMailboxForm({
        csrf: assertion.csrf,
        stamp: submittedStamp,
        account: existing,
        // Carried, not stripped, for the same reason as the refusal above it
        // (#184): the operator's next action here is Save, and a password box
        // this answer emptied resubmits as blank, which `mergedPassword` reads
        // as the stored password. A box they left blank is still carried as
        // blank and still means "unchanged".
        values: withCarriedPasswords(body, body),
        probe: toProbeView(report),
        // #148, on the edit form's own Test connection.
        ...credentialAdvice(report, raw(body, ADDRESS_FIELD)),
      })
    );
  });

  router.post("/settings/mailboxes/:id/default", guardAssertion, formBody, guardCsrf, async (req, res) => {
    const body = req.body as FormBody;
    const assertion = assertionOf(res);
    const submittedStamp = raw(body, "_stamp");
    try {
      await store.setDefault(idParam(req), submittedStamp);
    } catch (err) {
      if (err instanceof StaleStampError) {
        sendHtml(
          res,
          409,
          renderMailboxList({
            csrf: assertion.csrf,
            stamp: await store.stamp(),
            accounts: store.list(),
            notice: err.message,
          })
        );
        return;
      }
      if (err instanceof NoSuchAccountError) {
        sendHtml(
          res,
          404,
          renderMailboxList({
            csrf: assertion.csrf,
            stamp: await store.stamp(),
            accounts: store.list(),
            notice: err.message,
          })
        );
        return;
      }
      throw err;
    }
    sendRedirect(res, 303, "/settings/mailboxes");
  });

  router.post("/settings/mailboxes/:id/delete", guardAssertion, formBody, guardCsrf, async (req, res) => {
    const body = req.body as FormBody;
    const assertion = assertionOf(res);
    const submittedStamp = raw(body, "_stamp");
    try {
      await store.remove(idParam(req), submittedStamp);
    } catch (err) {
      if (err instanceof StaleStampError) {
        sendHtml(
          res,
          409,
          renderMailboxList({
            csrf: assertion.csrf,
            stamp: await store.stamp(),
            accounts: store.list(),
            notice: err.message,
          })
        );
        return;
      }
      if (err instanceof NoSuchAccountError) {
        sendHtml(
          res,
          404,
          renderMailboxList({
            csrf: assertion.csrf,
            stamp: await store.stamp(),
            accounts: store.list(),
            notice: err.message,
          })
        );
        return;
      }
      throw err;
    }
    sendRedirect(res, 303, "/settings/mailboxes");
  });

  return router;
}
