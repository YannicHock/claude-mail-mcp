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
 *   GET  /setup/<token>/mailbox       → step 2  (issue #23)
 *   GET  /setup/<token>/connect       → step 3  (issue #24)
 *   anything else                     → the gate's own 404, byte for byte
 * ```
 *
 * A screen the operator has not reached yet redirects to the one they have, so a
 * guessed URL cannot skip a step; a screen already behind them renders, which is
 * what Back is.
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
 * ## The seam to the rest of the wizard
 *
 * Step 3's Finish is where `Bootstrap.complete()` is called — the operator record
 * exists by then, written here in step 1, so completing means deleting the claim
 * token and nothing else. Issue #24 owns that call; this module deliberately does
 * not make it, because an instance whose token was consumed at step 1 would have
 * no way back to steps 2 and 3.
 */

import express, { type Request, type Response } from "express";

import { SETUP_PREFIX, type SetupRequest } from "./bootstrap.js";
import type { OAuthConfig } from "./config.js";
import type { Logger } from "./logger.js";
import { isSameOrigin, renderErrorPage } from "./login.js";
import { OperatorRecord, validateNewCredentials, type CredentialProblem } from "./operator.js";
import { renderCredentialsStep, renderStepPlaceholder, SETUP_HEADERS } from "./setup-pages.js";
import { isSetupStep, SetupState, type SetupStep } from "./setup-state.js";

export interface SetupWizardDeps {
  config: OAuthConfig;
  log: Logger;
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
  const { config, log, notFound } = deps;
  const operatorFile = requireOperatorFile(config);
  const state = SetupState.open(config.wizardStateFile, log);

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

      if (req.method === "GET" || req.method === "HEAD") {
        if (!state.reached(step)) {
          // No skipping ahead by typing a URL: the screens depend on each other,
          // and step 2 with no operator account behind it saves a mailbox to an
          // instance nobody can sign in to.
          redirect(res, `${base}/${state.furthest}`);
          return;
        }
        sendPage(res, 200, renderStep(step, base, { username: "", problems: [] }));
        return;
      }

      if (req.method !== "POST" || step !== "credentials") {
        // Steps 2 and 3 have no POST handler until #23 and #24 write one, and
        // an unexpected method gets the same answer an unexpected path does.
        notFound(req, res);
        return;
      }

      await handleCredentials(req, res, base);
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

  function renderStep(
    step: SetupStep,
    base: string,
    credentials: { username: string; problems: CredentialProblem[] }
  ): string {
    if (step === "credentials") {
      return renderCredentialsStep({ action: `${base}/credentials`, ...credentials });
    }
    return renderStepPlaceholder({ step, backHref: `${base}/credentials` });
  }
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
