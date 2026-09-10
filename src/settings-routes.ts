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
import { providerPresets } from "./providers.js";
import {
  ADDRESS_FIELD,
  caldavFailureNotice,
  CHECKBOX_ON,
  flattenDraft,
  MAILBOX_FIELDS,
  MAILBOX_SECRET_FIELDS,
  parseMailboxDraft,
  probeRefusesSave,
  PROVIDER_FIELD,
  readSaveAnyway,
  SAVE_ANYWAY_FIELD,
  saveRefusedNotice,
  SHARED_PASSWORD_FIELD,
  stepFromEdit,
  stepFromLookup,
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

function raw(body: FormBody, key: string): string {
  const v = body[key];
  return typeof v === "string" ? v : "";
}

function checkbox(body: FormBody, key: string): boolean {
  return raw(body, key) === "1";
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
   */
  async function sendStep(
    res: Response,
    csrf: string,
    step: MailboxSetupStep,
    notice?: string
  ): Promise<void> {
    switch (step.view) {
      case "address":
        // The only way back to tier 1 is an address that could not be read, so
        // this is a rejected submission rather than a fresh screen.
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
      res.redirect(303, "/settings/mailboxes");
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

      if (action === "lookup") {
        // Reached as a function call, not over a hop: `src/autoconfig.ts` is in
        // this package, which is the half of #141 that was already easy. The §7
        // rules that make a user-derived fetch safe are in there and are not
        // restated here.
        const found = await lookupMailboxSettings(email);
        // A boolean and nothing else. Not the address, and not the hosts.
        log("info", "settings: add mailbox looked up an address", { found: found !== null });
        await sendStep(
          res,
          assertion.csrf,
          stepFromLookup({ email, password, found, defaults: newMailboxDefaults(email) })
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
          })
        );
        return;
      }

      if (action === "edit") {
        await sendStep(
          res,
          assertion.csrf,
          stepFromEdit({ fields: body, password, defaults: newMailboxDefaults(email) }),
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

      const rejected = (status: number, errors: Record<string, string>, stamp: string): void => {
        if (json) {
          sendJson(res, status, { errors });
          return;
        }
        sendHtml(
          res,
          status,
          renderMailboxForm({
            csrf: assertion.csrf,
            stamp,
            account: null,
            values: sanitize(body),
            errors,
          })
        );
      };

      /**
       * The probe refused, so nothing was stored — said per service, in both
       * content types.
       *
       * 400 rather than a status of its own: from a caller's side this is the
       * same class of answer as a field the parser would not take, which the
       * wizard's `ConnectorAnswer` already reads as `rejected`. The report is
       * what makes it actionable, and the notice above it is
       * `saveRefusedNotice` — the wire contract's, so this page and the
       * wizard's say the same sentence.
       *
       * `errors` is empty: no field the operator typed is wrong. What failed is
       * the server on the other end of it, and marking a box red would send
       * them to correct something that is already correct.
       */
      const refusedByProbe = (report: ProbeReport, stamp: string): void => {
        const notice = saveRefusedNotice(toWireReport(report)) ?? "";
        if (json) {
          sendJson(res, 400, { message: notice, errors: {}, probe: toWireReport(report) });
          return;
        }
        sendHtml(
          res,
          400,
          renderMailboxForm({
            csrf: assertion.csrf,
            stamp,
            account: null,
            values: sanitize(body),
            probe: toProbeView(report),
            notice,
          })
        );
      };

      const parsed = parseAccountForm(fields, null);
      if (parsed.errors) {
        rejected(400, parsed.errors, submittedStamp);
        return;
      }

      // Before the write, not beside it. See `probeBeforeWrite`. Null means the
      // operator pressed *Save anyway* and nothing was probed at all.
      const report = await probeBeforeWrite(parsed.account, readSaveAnyway(body));
      if (report !== null && probeRefusesSave(toWireReport(report))) {
        log("warn", "settings: a mailbox was refused by the connection test", {
          id: parsed.account.id,
          imap: report.imap.ok,
          smtp: report.smtp.ok,
        });
        refusedByProbe(report, submittedStamp);
        return;
      }

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
      const wireReport = report === null ? undefined : toWireReport(report);
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
        if (json) {
          sendJson(res, 400, { errors: parsed.errors });
          return;
        }
        sendHtml(
          res,
          400,
          renderMailboxForm({
            csrf: assertion.csrf,
            stamp: submittedStamp,
            account: null,
            values: sanitize(body),
            errors: parsed.errors,
          })
        );
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
          values: sanitize(body),
          probe: toProbeView(report),
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
   */
  router.post("/settings/autoconfig", guardAssertion, jsonBody, formBody, guardCsrf, async (req, res) => {
    const email = raw(req.body as FormBody, "email");

    // Structurally the type declared in settings-api.ts. Assigned rather than
    // mapped field by field on purpose: if the connector's own suggestion shape
    // ever moves, this line stops compiling instead of quietly sending the
    // wizard a document it will read as unreadable.
    const suggestion: LookupSuggestion | null = await lookupMailboxSettings(email);

    // The address is not logged — nothing an operator types into the wizard is,
    // and an email address is the one field here that identifies a person.
    log("info", "settings: autoconfig lookup", { found: suggestion !== null });
    sendJson(res, 200, { suggestion });
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
    const parsed = parseAccountForm(body, existing);
    if (parsed.errors) {
      sendHtml(
        res,
        400,
        renderMailboxForm({
          csrf: assertion.csrf,
          stamp: submittedStamp,
          account: existing,
          values: sanitize(body),
          errors: parsed.errors,
        })
      );
      return;
    }
    // The same gate the create route has, for the same reason: an edit that
    // replaces a working password with one the server refuses leaves exactly
    // the mailbox #147 is about, and this is the route an operator uses for
    // every mailbox they already have.
    const report = await probeBeforeWrite(parsed.account, readSaveAnyway(body));
    if (report !== null && probeRefusesSave(toWireReport(report))) {
      log("warn", "settings: a mailbox edit was refused by the connection test", {
        id: existing.id,
        imap: report.imap.ok,
        smtp: report.smtp.ok,
      });
      sendHtml(
        res,
        400,
        renderMailboxForm({
          csrf: assertion.csrf,
          stamp: submittedStamp,
          account: existing,
          values: sanitize(body),
          probe: toProbeView(report),
          notice: saveRefusedNotice(toWireReport(report)) ?? "",
        })
      );
      return;
    }

    try {
      await store.update(existing.id, parsed.account, submittedStamp);
    } catch (err) {
      if (err instanceof StaleStampError) {
        sendHtml(
          res,
          409,
          renderMailboxForm({
            csrf: assertion.csrf,
            stamp: await store.stamp(),
            account: existing,
            values: sanitize(body),
            errors: { id: err.message },
          })
        );
        return;
      }
      if (err instanceof NoSuchAccountError || err instanceof AccountsStoreError) {
        sendHtml(
          res,
          400,
          renderMailboxForm({
            csrf: assertion.csrf,
            stamp: submittedStamp,
            account: existing,
            values: sanitize(body),
            errors: { id: err.message },
          })
        );
        return;
      }
      throw err;
    }
    await sendSavedPage(res, assertion.csrf, report === null ? undefined : toWireReport(report));
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
      sendHtml(
        res,
        400,
        renderMailboxForm({
          csrf: assertion.csrf,
          stamp: submittedStamp,
          account: existing,
          values: sanitize(body),
          errors: parsed.errors,
        })
      );
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
        values: sanitize(body),
        probe: toProbeView(report),
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
    res.redirect(303, "/settings/mailboxes");
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
    res.redirect(303, "/settings/mailboxes");
  });

  return router;
}
