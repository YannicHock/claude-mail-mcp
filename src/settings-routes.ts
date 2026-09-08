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
 * Route path collisions: "new" and "test" are reserved path segments — GET
 * /settings/mailboxes/new and POST /settings/mailboxes/test are registered ahead of
 * the `:id` routes they would otherwise be ambiguous with. An operator who names an
 * account "new" or "test" cannot reach it through the single-segment GET/POST
 * routes (they will hit the reserved handler instead); the two-segment routes
 * (`/:id/test`, `/:id/default`, `/:id/delete`) are unaffected since no reserved
 * literal exists at that depth. This mirrors a limitation already present in how
 * settings-pages.ts builds these URLs, not something introduced here.
 */

import { timingSafeEqual } from "node:crypto";
import express, { type RequestHandler, type Response, type Router } from "express";

import type { Logger } from "./app.js";
import {
  AccountsStore,
  AccountsStoreError,
  NoSuchAccountError,
  RESERVED_IDS,
  type Account,
  type CalDavCreds,
} from "./accounts.js";
import { StaleStampError } from "./accounts-writer.js";
import { probeAccount, type ProbeReport } from "./probe.js";
import {
  renderMailboxForm,
  renderMailboxList,
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

const PASSWORD_FIELDS = new Set(["imap.pass", "smtp.pass", "caldav.pass"]);
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
    id = requireStr("id");
    if (id !== "" && !ID_PATTERN.test(id)) {
      errors.id = "Use lowercase letters, digits, _ or -, up to 32 characters, starting alphanumeric.";
    } else if (RESERVED_IDS.has(id)) {
      // Same rule AccountsStore.create() enforces (see RESERVED_IDS in
      // accounts.ts) — caught here too so the operator sees a clean field
      // error instead of the generic AccountsStoreError re-render below.
      errors.id = `"${id}" is reserved and can't be used as a mailbox id. Choose another id.`;
    }
  }

  const label = requireStr("label");
  const isDefault = checkbox(body, "default");

  const imapHost = requireStr("imap.host");
  const imapPort = requirePort("imap.port");
  const imapUser = requireStr("imap.user");
  const imapPass = password("imap.pass", existing?.imap.pass);
  const imapTls = checkbox(body, "imap.tls");

  const smtpHost = requireStr("smtp.host");
  const smtpPort = requirePort("smtp.port");
  const smtpUser = requireStr("smtp.user");
  const smtpPass = password("smtp.pass", existing?.smtp.pass);
  const smtpTls = checkbox(body, "smtp.tls");

  const defaultFrom = requireStr("mail.defaultFrom");
  const defaultFromNameRaw = raw(body, "mail.defaultFromName");
  const draftsFolderRaw = raw(body, "mail.draftsFolder");
  const draftsFolder = draftsFolderRaw.trim() === "" ? "Drafts" : draftsFolderRaw;
  const sentFolderRaw = raw(body, "mail.sentFolder");
  const sentFolder = sentFolderRaw.trim() === "" ? null : sentFolderRaw;

  const removeCaldav = checkbox(body, "remove_caldav");
  const caldavUrl = raw(body, "caldav.url");
  const caldavUser = raw(body, "caldav.user");

  let caldav: CalDavCreds | undefined;
  if (removeCaldav) {
    // Explicit removal — caldav stays undefined below.
  } else if (caldavUrl.trim() === "") {
    if (existing?.caldav) {
      // Clearing the URL field is not how a CalDAV block is removed — that is
      // the "Remove CalDAV" checkbox above. Falling through to `undefined`
      // here would silently drop the stored CalDAV username and password
      // from accounts.json the moment the operator saves.
      errors["caldav.url"] = 'Required — tick "Remove CalDAV" to remove it.';
    }
    // No existing CalDAV block and a blank URL: there was never a CalDAV
    // block to begin with, which is not an error.
  } else {
    if (caldavUser.trim() === "") {
      errors["caldav.user"] = "Required.";
    }
    const caldavPass = password("caldav.pass", existing?.caldav?.pass);
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
  const guardAssertion = requireSettingsAssertion({ key: settingsKey, issuer, log });
  const guardCsrf = requireFormCsrf();

  router.get("/settings/mailboxes", guardAssertion, async (_req, res) => {
    const assertion = assertionOf(res);
    const stamp = await store.stamp();
    sendHtml(
      res,
      200,
      renderMailboxList({ csrf: assertion.csrf, stamp, accounts: store.list() })
    );
  });

  router.get("/settings/mailboxes/new", guardAssertion, async (_req, res) => {
    const assertion = assertionOf(res);
    const stamp = await store.stamp();
    sendHtml(res, 200, renderMailboxForm({ csrf: assertion.csrf, stamp, account: null }));
  });

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

  router.post("/settings/mailboxes", guardAssertion, formBody, guardCsrf, async (req, res) => {
    const body = req.body as FormBody;
    const assertion = assertionOf(res);
    const submittedStamp = raw(body, "_stamp");
    const parsed = parseAccountForm(body, null);
    if (parsed.errors) {
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
    try {
      await store.create(parsed.account, submittedStamp);
    } catch (err) {
      if (err instanceof StaleStampError) {
        sendHtml(
          res,
          409,
          renderMailboxForm({
            csrf: assertion.csrf,
            stamp: await store.stamp(),
            account: null,
            values: sanitize(body),
            errors: { id: err.message },
          })
        );
        return;
      }
      if (err instanceof AccountsStoreError) {
        sendHtml(
          res,
          400,
          renderMailboxForm({
            csrf: assertion.csrf,
            stamp: submittedStamp,
            account: null,
            values: sanitize(body),
            errors: { id: err.message },
          })
        );
        return;
      }
      throw err;
    }
    res.redirect(303, "/settings/mailboxes");
  });

  router.post("/settings/mailboxes/test", guardAssertion, formBody, guardCsrf, async (req, res) => {
    const body = req.body as FormBody;
    const assertion = assertionOf(res);
    const submittedStamp = raw(body, "_stamp");
    const parsed = parseAccountForm(body, null);
    if (parsed.errors) {
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
    res.redirect(303, "/settings/mailboxes");
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
