/**
 * The setup wizard's routes, behind the claim token.
 *
 * Not an Express router, and deliberately so: every path here lives under
 * `/setup/<token>/…`, the token is dynamic, and it has already been compared in
 * constant time by the gate in app.ts before this module is reached. A router
 * mounted at a wildcard prefix would either repeat that comparison or invite a
 * future edit that forgets it. So the gate hands over a request it has already
 * authenticated, and this module routes on the remainder.
 *
 * ## The route table
 *
 * ```
 *   GET  /setup/<token>               → the furthest screen reached so far
 *   GET  /setup/<token>/credentials   → step 1
 *   POST /setup/<token>/credentials   → writes the operator record, on to step 2
 *   GET  /setup/<token>/mailbox       → step 2
 *   POST /setup/<token>/mailbox       → tests a mailbox, stores it, or skips it
 *   GET  /setup/<token>/connect       → step 3
 *   POST /setup/<token>/connect       → Finish: completes the claim, or explains
 *                                       PUBLIC_URL and stays put
 *   anything else                     → the gate's own 404, byte for byte
 * ```
 *
 * A screen the operator has not reached yet redirects to the one they have, so a
 * guessed URL cannot skip a step; a screen already behind them renders, which is
 * what Back is.
 *
 * ## How step 2 reaches a mailbox
 *
 * Nothing about a mailbox is implemented here. `probe.ts`, `parseAccountForm`
 * and the accounts store all live in the connector, this package depends on no
 * mail library at all — no `imapflow`, no `nodemailer`, no `tsdav` — and it must
 * stay that way: a second probe or a second account writer is exactly what issue
 * #23 says not to build. So step 2 asks the connector, over HTTP, using the
 * settings routes the settings UI already posts to:
 *
 * ```
 *   POST /settings/mailboxes/test  → the probe, one result per service
 *   GET  /settings/mailboxes/new   → the current accounts.json stamp
 *   POST /settings/mailboxes       → the write, only once the probe has held
 * ```
 *
 * Not through `createProxy`. That module streams the upstream response straight
 * back to the browser, which is precisely what this step cannot do: the whole
 * requirement is a *decision* taken on the connector's answer — save, or refuse
 * to save — and a pipe has nowhere to take one. The credentials the proxy would
 * have carried are carried here instead, and are the same two: the connector's
 * static `AUTH_TOKEN` as the bearer, plus a settings assertion signed per
 * request with the same key and the same `signAssertion` (see assertion.ts).
 *
 * The connector authenticates and checks CSRF on those routes exactly as it does
 * for the settings UI; the caller here is this service rather than a browser, so
 * the `_csrf` field it submits is the one it just signed into the assertion.
 * This wizard's own protection against a forged submission is unchanged: the
 * unguessable token in the URL, and the same-origin check below.
 *
 * ## Why there is no CSRF token
 *
 * The settings pages carry one because their authority is a cookie, which a
 * cross-site form can make the browser send. This wizard's authority is the
 * unguessable token in the URL, which a cross-site form cannot know — an
 * attacker who has it does not need a forged POST. What is checked instead is
 * that the submission came from this origin, via the same `isSameOrigin` the
 * settings forms use, which reads `Origin` and falls back to `Referer` because
 * Chrome sends no `Origin` on a same-origin form POST.
 *
 * ## Where the wizard ends
 *
 * Step 3's Finish is the **only** call to `Bootstrap.complete()` in this service,
 * and it is the last thing the wizard does. The operator record exists by then,
 * written here in step 1, so completing means deleting the claim token and
 * nothing else. It is deliberately not called any earlier: an instance whose
 * token was consumed at step 1 would have no way back to steps 2 and 3, and a
 * restart between them would find nothing to resume.
 *
 * The step is checked twice on the way there. `state.reached("connect")` is what
 * stops a POST to `/connect` from an operator who has not been through step 1,
 * and `complete()` itself refuses to delete the token before the operator record
 * exists — so a claim needs both the wizard's own account of where the operator
 * got to and the file that account implies.
 */

import { randomBytes, randomUUID } from "node:crypto";
import express, { type Request, type Response } from "express";

import { ASSERTION_HEADER, signAssertion } from "./assertion.js";
import { BootstrapError, SETUP_PREFIX, type Bootstrap, type SetupRequest } from "./bootstrap.js";
import type { OAuthConfig } from "./config.js";
import type { Logger } from "./logger.js";
import { isSameOrigin, renderErrorPage } from "./login.js";
import { OperatorRecord, validateNewCredentials } from "./operator.js";
import {
  renderConnectStep,
  renderCredentialsStep,
  renderMailboxStep,
  renderSetupComplete,
  SETUP_HEADERS,
  type ConfiguredMailbox,
  type ConnectPageData,
  type MailboxPageData,
  type MailboxProbeView,
} from "./setup-pages.js";
import { isSetupStep, SetupState, type SetupStep } from "./setup-state.js";

export interface SetupWizardDeps {
  config: OAuthConfig;
  log: Logger;
  /**
   * The live bootstrap state this wizard is running behind.
   *
   * Step 3's Finish is the only caller of {@link Bootstrap.complete} in the
   * service, and it has to be *this* object rather than a fresh one: the gate in
   * app.ts reads `bootstrapped` off it on every request, so completing here is
   * what opens `/mcp` and closes `/setup` in the same breath, without a restart.
   */
  bootstrap: Bootstrap;
  /**
   * The gate's 404 responder, passed in rather than reimplemented. An unknown
   * sub-path under a *valid* token has to be indistinguishable from a wrong
   * token, which means the same status, headers and body from the same code.
   */
  notFound: (req: Request, res: Response) => void;
}

export interface SetupWizard {
  /** Serve a request the gate has already checked the claim token of. */
  handle(req: Request, res: Response, setup: SetupRequest): Promise<void>;
}

/** 64 KiB, the limit every other form in this service parses under. */
const formBody = express.urlencoded({ extended: false, limit: "64kb" });

export function createSetupWizard(deps: SetupWizardDeps): SetupWizard {
  const { bootstrap, config, log, notFound } = deps;
  const operatorFile = requireOperatorFile(config);
  const state = SetupState.open(config.wizardStateFile, log);
  const mailboxes = createMailboxClient(config, log);

  return {
    async handle(req, res, setup) {
      const base = `${SETUP_PREFIX}/${setup.token}`;

      if (setup.rest === "") {
        redirect(res, `${base}/${state.furthest}`);
        return;
      }

      const step = setup.rest.slice(1);
      if (!isSetupStep(step)) {
        notFound(req, res);
        return;
      }

      if (!state.reached(step)) {
        // No skipping ahead by typing a URL, or by posting to one: the screens
        // depend on each other, and step 2 with no operator account behind it
        // stores a mailbox on an instance nobody can sign in to. 303 on a POST
        // so the browser follows it with a GET rather than re-submitting.
        redirect(res, `${base}/${state.furthest}`, req.method === "POST" ? 303 : 302);
        return;
      }

      if (req.method === "GET" || req.method === "HEAD") {
        sendPage(res, 200, await renderStep(step, base));
        return;
      }

      if (req.method === "POST" && step === "credentials") {
        await handleCredentials(req, res, base);
        return;
      }

      if (req.method === "POST" && step === "mailbox") {
        await handleMailbox(req, res, base);
        return;
      }

      if (req.method === "POST" && step === "connect") {
        await handleConnect(req, res, base);
        return;
      }

      // An unexpected method gets the same answer an unexpected path does.
      notFound(req, res);
    },
  };

  async function handleCredentials(req: Request, res: Response, base: string): Promise<void> {
    if (!isSameOrigin(req.headers, config.issuer)) {
      sendForbidden(res);
      return;
    }

    try {
      await parseForm(req, res);
    } catch {
      sendPage(
        res,
        400,
        renderCredentialsStep({
          action: `${base}/credentials`,
          username: "",
          problems: [{ field: "username", message: "That form could not be read. Try again." }],
        })
      );
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const username = stringField(body.username);
    const problems = validateNewCredentials({
      username,
      password: stringField(body.password),
      confirmation: stringField(body.confirmation),
    });

    if (problems.length > 0) {
      // Nothing entered in the wizard is logged, on any path — least of all the
      // one that has just handled a password. The operator sees the reason; the
      // log gets the fact that a submission was rejected and no field of it.
      log("info", "setup step 1 rejected a submission", { problems: problems.length });
      sendPage(
        res,
        400,
        renderCredentialsStep({ action: `${base}/credentials`, username, problems })
      );
      return;
    }

    try {
      await OperatorRecord.create(
        operatorFile,
        { username, password: stringField(body.password) },
        log
      );
    } catch (err) {
      log("error", "setup step 1 could not write the operator record", {
        path: operatorFile,
        error: err instanceof Error ? err.message : String(err),
      });
      sendErrorPage(
        res,
        "The account could not be saved",
        "Writing the operator record to the data volume failed, so nothing was saved. " +
          "Check that the volume is present and writable, then submit the form again."
      );
      return;
    }

    log("info", "setup step 1 completed: the operator account was created", {});
    await state.advanceTo("mailbox");
    // 303, not 302: the browser must follow this with a GET, so a reload of the
    // next screen does not re-submit a password.
    redirect(res, `${base}/mailbox`, 303);
  }

  /**
   * Step 2 — the first mailbox.
   *
   * Three submissions arrive here, told apart by `_action`: `skip`, which
   * configures nothing and moves on; `test`, which reports the three services
   * and stores nothing; and `save`, which does both, in that order, and only
   * writes when IMAP and SMTP have each answered.
   *
   * The order is the whole point of the screen. A probe that ran after the write
   * would leave an operator finishing setup over credentials that were already
   * known not to work.
   */
  async function handleMailbox(req: Request, res: Response, base: string): Promise<void> {
    if (!isSameOrigin(req.headers, config.issuer)) {
      sendForbidden(res);
      return;
    }

    const page = (status: number, data: Partial<MailboxPageData>): void => {
      sendPage(
        res,
        status,
        renderMailboxStep({
          action: `${base}/mailbox`,
          backHref: `${base}/credentials`,
          values: {},
          errors: {},
          ...(mailboxes === null ? { unavailable: true } : {}),
          ...data,
        })
      );
    };

    try {
      await parseForm(req, res);
    } catch {
      page(400, { notice: { kind: "error", message: "That form could not be read. Try again." } });
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const action = stringField(body._action);

    if (action === "skip") {
      // Someone evaluating the thing should not need mail credentials to hand.
      // Nothing is written, nothing is contacted, and step 3 says plainly that
      // no mailbox is configured.
      log("info", "setup step 2 skipped: no mailbox was configured", {});
      await state.advanceTo("connect");
      redirect(res, `${base}/connect`, 303);
      return;
    }

    if (action !== "test" && action !== "save") {
      page(400, {
        notice: { kind: "error", message: "That form could not be read. Try again." },
      });
      return;
    }

    if (mailboxes === null) {
      // No settings signing key: the connector would refuse every request this
      // step makes, so it makes none and says so instead of failing obscurely.
      page(200, {});
      return;
    }

    const fields = collectMailboxFields(body);
    const values = withoutSecrets(fields);

    const tested = await mailboxes.test(fields);
    if (tested.kind !== "answer") {
      log("warn", "setup step 2 could not reach the connector", { error: tested.error });
      page(502, {
        values,
        notice: {
          kind: "error",
          message:
            "The connector did not answer, so nothing was tested and nothing was saved. " +
            "Check that it is running, then try again.",
        },
      });
      return;
    }

    if (tested.status === 400) {
      const errors = readFieldErrors(tested.body);
      log("info", "setup step 2: the connector rejected the mailbox details", {
        fields: Object.keys(errors).length,
      });
      page(400, {
        values,
        errors,
        notice: {
          kind: "error",
          message:
            "These details were not accepted, so nothing was tested and nothing was saved.",
        },
      });
      return;
    }

    if (tested.status !== 200) {
      log("error", "setup step 2: the connector refused the connection test", {
        status: tested.status,
      });
      page(502, { values, notice: refusedNotice(tested.status) });
      return;
    }

    const probe = readProbeReport(tested.body);
    if (probe === null) {
      // Fail closed. An answer this build cannot read is not evidence that the
      // mailbox works, and the one thing this step must never do is store
      // credentials it has no report for.
      log("error", "setup step 2: the connection test result could not be read", {});
      page(502, {
        values,
        notice: {
          kind: "error",
          message:
            "The connector answered the connection test in a form this version does not " +
            "understand, so nothing was saved. Check that both containers are on the same release.",
        },
      });
      return;
    }

    // Booleans only. Nothing the operator typed is logged here, on any path.
    log("info", "setup step 2 tested a mailbox", {
      action,
      imap: probe.imap.ok,
      smtp: probe.smtp.ok,
      caldav: probe.caldav.tested ? probe.caldav.ok : null,
    });

    if (action === "test") {
      page(200, {
        values,
        probe,
        notice: {
          kind: "info",
          message: "Nothing has been saved yet. Press Save and continue when this looks right.",
        },
      });
      return;
    }

    if (!probe.imap.ok || !probe.smtp.ok) {
      // A mailbox that cannot read or send is not a mailbox. CalDAV is not in
      // this condition on purpose: it is optional in the account model, and
      // treating it as fatal would lock out every IMAP-only provider.
      page(400, {
        values,
        probe,
        notice: {
          kind: "error",
          message:
            "IMAP and SMTP must both answer before a mailbox is saved, so nothing was stored. " +
            "Fix what failed above, retype the passwords and try again.",
        },
      });
      return;
    }

    const stamp = await mailboxes.stamp();
    if (stamp === null) {
      log("error", "setup step 2: the connector would not say what accounts.json looks like", {});
      page(502, {
        values,
        probe,
        notice: {
          kind: "error",
          message:
            "The connection test passed, but the connector did not answer when asked to save. " +
            "Nothing was stored. Try again.",
        },
      });
      return;
    }

    const created = await mailboxes.create(fields, stamp);
    if (created.kind !== "answer") {
      log("warn", "setup step 2 could not reach the connector to save", { error: created.error });
      page(502, {
        values,
        probe,
        notice: {
          kind: "error",
          message:
            "The connection test passed, but the connector did not answer when asked to save. " +
            "Nothing was stored. Try again.",
        },
      });
      return;
    }

    if (created.status !== 303) {
      const errors = readFieldErrors(created.body);
      log("error", "setup step 2: the connector refused to save the mailbox", {
        status: created.status,
        fields: Object.keys(errors).length,
      });
      page(created.status === 400 || created.status === 409 ? 400 : 502, {
        values,
        errors,
        probe,
        notice:
          created.status === 400 || created.status === 409
            ? {
                kind: "error",
                message:
                  "The connection test passed, but these details were refused, so nothing " +
                  "was saved. Retype the passwords and try again.",
              }
            : refusedNotice(created.status),
      });
      return;
    }

    log("info", "setup step 2 completed: a verified mailbox was saved", {});
    await state.advanceTo("connect");
    redirect(res, `${base}/connect`, 303);
  }

  /**
   * Step 3 — the MCP URL, `PUBLIC_URL`, and the only Finish this service has.
   *
   * Two submissions arrive here, told apart by the confirmation radio. `no` is
   * not a failure and not a refusal to continue: it renders the same screen with
   * the guidance for changing an environment variable, and leaves the wizard
   * exactly where it was, because a `PUBLIC_URL` fixed by editing `.env` and
   * restarting must find this link still working.
   *
   * `yes` calls {@link Bootstrap.complete}, which deletes the claim token — and
   * that is the whole transition. The operator record was written in step 1, so
   * completing has nothing else left to do; `complete()` refuses to run before
   * that record exists, which is the ordering guarantee this depends on rather
   * than re-checks.
   *
   * The answer is the completion screen itself, not a redirect. See
   * {@link renderSetupComplete} for why there is nowhere left to redirect to.
   */
  async function handleConnect(req: Request, res: Response, base: string): Promise<void> {
    if (!isSameOrigin(req.headers, config.issuer)) {
      sendForbidden(res);
      return;
    }

    const page = async (status: number, data: Partial<ConnectPageData>): Promise<void> => {
      sendPage(res, status, renderConnectStep({ ...(await connectPageData(base)), ...data }));
    };

    try {
      await parseForm(req, res);
    } catch {
      await page(400, {
        notice: { kind: "error", message: "That form could not be read. Try again." },
      });
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const answer = stringField(body.public_url_ok);

    if (answer === "no") {
      log("info", "setup step 3: the operator says PUBLIC_URL is wrong", {});
      await page(200, {
        showPublicUrlHelp: true,
        notice: {
          kind: "info",
          message:
            "Nothing has been finished. Change PUBLIC_URL, bring the stack back up, " +
            "and open this same link again.",
        },
      });
      return;
    }

    if (answer !== "yes") {
      // The radio is `required`, so this is a browser that skipped it or a
      // hand-made submission. Neither is an answer, and an instance is not
      // claimed on one.
      await page(400, {
        notice: {
          kind: "error",
          message: "Confirm the address above before finishing.",
        },
      });
      return;
    }

    try {
      await bootstrap.complete();
    } catch (err) {
      // The partial failure: the operator record is written and the token is
      // still there. `complete()` leaves the state unflipped in that case, so
      // the instance is exactly as it was — still unclaimed, this link still
      // live — and the operator can fix what the message names and press Finish
      // again. Its own message is the actionable half: it names the file and
      // what the filesystem said about it.
      const detail = err instanceof BootstrapError ? err.message : "Setup could not be completed.";
      log("error", "setup step 3 could not complete the claim", { error: detail });
      await page(500, {
        notice: {
          kind: "error",
          message:
            `${detail} This instance is still unclaimed and nothing you entered has been ` +
            "lost, so this link still works: fix what is named above and press Finish again.",
        },
      });
      return;
    }

    // Booleans and nothing else, as everywhere else in this wizard.
    log("info", "setup completed: the instance is claimed and the claim token is gone", {});
    const configured = await configuredMailboxes();
    sendPage(
      res,
      200,
      renderSetupComplete({
        mcpUrl: config.resource,
        settingsUrl: `${config.issuer}/settings`,
        mailboxes: configured.mailboxes,
        connectorReachable: configured.reachable,
      })
    );
  }

  async function renderStep(step: SetupStep, base: string): Promise<string> {
    if (step === "credentials") {
      return renderCredentialsStep({
        action: `${base}/credentials`,
        username: "",
        problems: [],
      });
    }
    if (step === "mailbox") {
      return renderMailboxStep({
        action: `${base}/mailbox`,
        backHref: `${base}/credentials`,
        values: {},
        errors: {},
        ...(mailboxes === null ? { unavailable: true } : {}),
      });
    }
    return renderConnectStep(await connectPageData(base));
  }

  /** Everything step 3 shows before a submission adds anything to it. */
  async function connectPageData(base: string): Promise<ConnectPageData> {
    const configured = await configuredMailboxes();
    return {
      action: `${base}/connect`,
      backHref: `${base}/mailbox`,
      // The canonical resource identifier is exactly the address a client is
      // meant to name, so the URL on the screen and the `resource` the token
      // endpoint validates against cannot drift apart.
      mcpUrl: config.resource,
      publicUrl: config.issuer,
      mailboxes: configured.mailboxes,
      connectorReachable: configured.reachable,
    };
  }

  function configuredMailboxes(): Promise<{
    reachable: boolean;
    mailboxes: ConfiguredMailbox[];
  }> {
    return fetchConfiguredMailboxes(config.upstreamMcpUrl, log);
  }
}

/**
 * Which mailboxes the connector has, for step 3's summary line.
 *
 * Step 2 leaves the wizard in the same state whether it saved a mailbox or was
 * skipped — the same 303, the same recorded progress — so step 3 asks rather
 * than infers. The connector's own `/health` is the cheapest place to ask and
 * the only route on it that needs no credentials at all, which is why this does
 * not go through the signed client above.
 *
 * Reachability is reported rather than swallowed: an unreachable connector must
 * not render as "no mailbox is configured", which would be a confident wrong
 * answer to the one question this line exists to answer. It never throws, and
 * never blocks Finish — the connector being down has nothing to do with whether
 * this instance has been claimed.
 */
async function fetchConfiguredMailboxes(
  upstreamMcpUrl: string,
  log: Logger
): Promise<{ reachable: boolean; mailboxes: ConfiguredMailbox[] }> {
  try {
    const res = await fetch(`${upstreamMcpUrl}/health`, {
      signal: AbortSignal.timeout(QUICK_TIMEOUT_MS),
    });
    if (!res.ok) return { reachable: false, mailboxes: [] };

    // `accounts: [{ id, label, ... }]`, the same shape app.ts reads off this
    // route for the settings page.
    const body = (await res.json()) as { accounts?: unknown };
    const accounts = Array.isArray(body.accounts) ? body.accounts : [];
    return {
      reachable: true,
      mailboxes: accounts
        .filter(
          (account): account is ConfiguredMailbox =>
            typeof account === "object" &&
            account !== null &&
            typeof (account as ConfiguredMailbox).id === "string" &&
            typeof (account as ConfiguredMailbox).label === "string"
        )
        .map((account) => ({ id: account.id, label: account.label })),
    };
  } catch (err) {
    log("warn", "setup step 3 could not ask the connector which mailboxes exist", {
      error: err instanceof Error ? err.message : "failed",
    });
    return { reachable: false, mailboxes: [] };
  }
}

function refusedNotice(status: number): { kind: "error"; message: string } {
  return {
    kind: "error",
    message:
      `The connector refused the request (HTTP ${status}), so nothing was saved. ` +
      "Check that both services share the same settings signing key and auth token.",
  };
}

/**
 * Where step 1 writes the credential.
 *
 * Unreachable in practice: `OPERATOR_FILE=none` reports bootstrapped, so the gate
 * never builds a wizard for one. Said out loud rather than left to a `!`.
 */
function requireOperatorFile(config: OAuthConfig): string {
  if (config.operatorFile === null) {
    throw new Error("The setup wizard needs an OPERATOR_FILE to write the credential to");
  }
  return config.operatorFile;
}

function parseForm(req: Request, res: Response): Promise<void> {
  return new Promise((resolve, reject) => {
    formBody(req, res, (err?: unknown) => {
      if (err) reject(err instanceof Error ? err : new Error(String(err)));
      else resolve();
    });
  });
}

/** A submitted field, or "" for a missing one or a repeated one. */
function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function redirect(res: Response, location: string, status = 302): void {
  res.status(status).set(SETUP_HEADERS).set("Location", location).end();
}

function sendPage(res: Response, status: number, html: string): void {
  res.status(status).type("html").set(SETUP_HEADERS).send(html);
}

function sendForbidden(res: Response): void {
  sendErrorPage(
    res,
    "Request blocked",
    "This form submission did not come from this site. Open the setup link again and retry.",
    403
  );
}

function sendErrorPage(res: Response, title: string, message: string, status = 500): void {
  res.status(status).type("html").set(SETUP_HEADERS).send(renderErrorPage(title, message));
}

// ---- The connector's mailbox routes, as step 2 uses them -------------------

/** The connector's routes. Their paths are also what the assertion is bound to. */
const UPSTREAM_NEW = "/settings/mailboxes/new";
const UPSTREAM_TEST = "/settings/mailboxes/test";
const UPSTREAM_CREATE = "/settings/mailboxes";

/**
 * The form fields forwarded upstream, under the connector's own names.
 *
 * A fixed list rather than "whatever was submitted": the body arrives from a
 * browser, and the bookkeeping fields the connector reads — `_csrf` and
 * `_stamp` — are minted here and must not be forgeable from the outside.
 */
const MAILBOX_FIELDS = [
  "id",
  "label",
  "default",
  "mail.defaultFrom",
  "imap.host",
  "imap.port",
  "imap.tls",
  "imap.user",
  "imap.pass",
  "smtp.host",
  "smtp.port",
  "smtp.tls",
  "smtp.user",
  "smtp.pass",
  "caldav.url",
  "caldav.user",
  "caldav.pass",
] as const;

/** Never echoed back into a page, never logged. */
const SECRET_FIELDS = new Set(["imap.pass", "smtp.pass", "caldav.pass"]);

/**
 * Who the assertion says is asking.
 *
 * Not an operator's session, because there is not one yet — the settings UI is
 * unmounted until the instance is claimed. The connector uses `sub` for nothing
 * but its own audit trail, and a name that says where the request came from is
 * more use there than a borrowed username would be.
 */
const SETUP_SUBJECT = "setup-wizard";

/** Longer than the connector's own 25-second probe budget, and not much longer. */
const PROBE_TIMEOUT_MS = 30_000;
/** Everything else upstream is a file read and a render. */
const QUICK_TIMEOUT_MS = 5_000;

type UpstreamAnswer =
  | { kind: "answer"; status: number; body: string }
  | { kind: "unreachable"; error: string };

interface MailboxClient {
  /** Probe without saving: the connector's own "Test connection" action. */
  test(fields: URLSearchParams): Promise<UpstreamAnswer>;
  /** The current `accounts.json` stamp, read off the connector's own new-mailbox form. */
  stamp(): Promise<string | null>;
  /** Write the account. 303 means it is stored. */
  create(fields: URLSearchParams, stamp: string): Promise<UpstreamAnswer>;
}

/**
 * A client for the connector's settings routes, or null when this instance has
 * no settings signing key and therefore nothing the connector would accept.
 */
function createMailboxClient(config: OAuthConfig, log: Logger): MailboxClient | null {
  if (config.settingsSigningKey === null) return null;
  // Re-declared with a non-nullable type rather than relying on the narrowing
  // above: the closures below outlive it, and one of them signs with this key.
  const key: Uint8Array = config.settingsSigningKey;

  async function call(
    method: "GET" | "POST",
    path: string,
    form: URLSearchParams | null,
    timeoutMs: number
  ): Promise<UpstreamAnswer> {
    // Minted per request and thrown away with it, the way the settings proxy
    // mints one per proxied request. The `csrf` claim and the `_csrf` field are
    // the same value because the connector compares them — that check binds a
    // browser form to a session, and there is no browser on this hop.
    const csrf = randomBytes(24).toString("base64url");
    const assertion = signAssertion(
      { sub: SETUP_SUBJECT, sid: randomUUID(), csrf, method, path },
      key,
      config.issuer
    );
    if (form !== null) form.set("_csrf", csrf);

    try {
      const res = await fetch(`${config.upstreamMcpUrl}${path}`, {
        method,
        redirect: "manual",
        headers: {
          authorization: `Bearer ${config.upstreamAuthToken}`,
          [ASSERTION_HEADER]: assertion,
          ...(form === null
            ? {}
            : { "content-type": "application/x-www-form-urlencoded" }),
        },
        ...(form === null ? {} : { body: form.toString() }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      return { kind: "answer", status: res.status, body: await res.text() };
    } catch (err) {
      // The message only, and only from an Error: the request body on this hop
      // is a mailbox password, and a thrown object is not always as tidy.
      return { kind: "unreachable", error: err instanceof Error ? err.message : "failed" };
    }
  }

  return {
    test: (fields) => call("POST", UPSTREAM_TEST, fields, PROBE_TIMEOUT_MS),
    create: (fields, stamp) => {
      const form = new URLSearchParams(fields);
      form.set("_stamp", stamp);
      return call("POST", UPSTREAM_CREATE, form, QUICK_TIMEOUT_MS);
    },
    async stamp() {
      // Read immediately before the write rather than embedded in the wizard's
      // own form, so the connector's optimistic-concurrency check cannot fail
      // over the minutes an operator spends typing a mailbox in.
      const answer = await call("GET", UPSTREAM_NEW, null, QUICK_TIMEOUT_MS);
      if (answer.kind !== "answer" || answer.status !== 200) {
        log("warn", "setup step 2 could not read the accounts stamp", {
          status: answer.kind === "answer" ? answer.status : 0,
        });
        return null;
      }
      return readStamp(answer.body);
    },
  };
}

/** The submitted fields the connector knows about, and nothing else. */
function collectMailboxFields(body: Record<string, unknown>): URLSearchParams {
  const form = new URLSearchParams();
  for (const name of MAILBOX_FIELDS) {
    const value = body[name];
    if (typeof value === "string") form.set(name, value);
  }
  return form;
}

/** What may be put back into the page: everything except the passwords. */
function withoutSecrets(fields: URLSearchParams): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [name, value] of fields) {
    if (SECRET_FIELDS.has(name)) continue;
    values[name] = value;
  }
  return values;
}

// ---- Reading the connector's answers --------------------------------------
//
// The connector renders HTML for a browser; it has no JSON form of these
// routes, and adding one would be a change in a package this service cannot
// import from and does not own. So these three readers pick out the three
// facts step 2 needs, from markup that is mirrored below verbatim.
//
// **These patterns mirror `renderMailboxForm` in src/settings-pages.ts. If the
// markup there changes, change them here in the same commit** — the same rule
// assertion.ts already carries for the format it mirrors. Every one of them
// fails closed: no match is read as "no result", which refuses the save, never
// as "it passed".

/** `probeRowHtml()` in src/settings-pages.ts. */
const PROBE_ROW =
  /<div class="probe-row (ok|fail)"><strong>([^<]*)<\/strong><span>([^<]*)<\/span><\/div>/g;

/** `textField()` in src/settings-pages.ts: the input, then its own error line. */
const FIELD_ERROR = /<input\b[^>]*\bname="([^"]+)"[^>]*>\s*<p class="field-error">([^<]*)<\/p>/g;

/** The hidden field `renderMailboxForm()` puts the accounts.json stamp in. */
const STAMP_FIELD = /name="_stamp" value="([^"]*)"/;

/** The inverse of the `escapeHtml` both packages define identically. */
function unescapeHtml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * The three services, read out of the connector's probe panel.
 *
 * Null when IMAP or SMTP is missing from it — an answer without both is not a
 * report this step can act on, and the caller treats that as a refusal to save.
 */
export function readProbeReport(html: string): MailboxProbeView | null {
  const lines = new Map<string, { tested: boolean; ok: boolean; message: string }>();
  for (const match of html.matchAll(PROBE_ROW)) {
    const ok = match[1] === "ok";
    const status = unescapeHtml(match[3]);
    lines.set(unescapeHtml(match[2]), {
      tested: true,
      ok,
      message: ok ? "" : status.replace(/^failed:\s*/, ""),
    });
  }

  const imap = lines.get("IMAP");
  const smtp = lines.get("SMTP");
  if (imap === undefined || smtp === undefined) return null;
  // The connector omits the CalDAV row entirely when no CalDAV URL was given.
  // That is "not tested", which this screen reports as its own third line
  // rather than folding into either of the other two.
  const caldav = lines.get("CalDAV") ?? { tested: false, ok: false, message: "" };
  return { imap, smtp, caldav };
}

/** The connector's per-field rejections, keyed by the field name it rejected. */
export function readFieldErrors(html: string): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const match of html.matchAll(FIELD_ERROR)) {
    errors[unescapeHtml(match[1])] = unescapeHtml(match[2]);
  }
  return errors;
}

export function readStamp(html: string): string | null {
  const match = STAMP_FIELD.exec(html);
  return match === null ? null : unescapeHtml(match[1]);
}
