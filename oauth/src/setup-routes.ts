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
 *   POST /settings/mailboxes       → the write, which probes before it writes
 * ```
 *
 * The order in that last line used to be this file's to enforce: step 2 called
 * the probe route, read the result and only then called the write route. #147
 * moved the rule into the connector, where the thing being protected is. The
 * probe route is still called by *Test connection*, which writes nothing and
 * never was a gate; the save calls the write route and reads the refusal, and
 * `Save anyway` is the operator asking for the gate to be skipped — a
 * documented field in the shared wire contract rather than two paths quietly
 * disagreeing about what a save means.
 *
 * Those three answer JSON when asked to — `Accept: application/json`, and a
 * `{ _csrf, _stamp, mailbox }` body on the two that take one, where `mailbox`
 * is a `MailboxDraft` from settings-api.ts. Until #69 they answered only in
 * HTML, and this file picked the probe rows, the per-field rejections and the
 * stamp back out of the markup with three regular expressions that a cosmetic
 * edit to the connector's form could have broken silently. Those readers, and
 * the test helper that mirrored the connector's markup verbatim, are gone; the
 * field names come from `MAILBOX_FIELDS` rather than from a hand-kept list, so
 * one renamed field no longer goes quietly missing on the way over.
 *
 * The stamp is read twice when it has to be: once before the write, and again
 * when the write goes unanswered. An abort fires after the request has gone out,
 * so silence there is not evidence of anything — and the stamp is what turns
 * "unknown" back into a fact rather than a guess. See `handleMailbox`.
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
  ADDRESS_FIELD,
  carrying,
  CHECKBOX_ON,
  CONNECTOR_AUTOCONFIG_BUDGET_MS,
  CONNECTOR_PROBE_BUDGET_MS,
  domainOf,
  draftFromFields,
  emptyMailboxValues,
  flattenDraft,
  formValues,
  MAILBOX_FIELDS,
  MAILBOX_SECRET_FIELDS,
  parseAutoconfigAnswer,
  parseErrorAnswer,
  parseProbeAnswer,
  parseProvidersAnswer,
  parseStampAnswer,
  PROVIDER_FIELD,
  SAVE_ANYWAY_FIELD,
  saveRefusedNotice,
  SHARED_PASSWORD_FIELD,
  stepFromEdit,
  stepFromLookup,
  stepFromProvider,
  stringField,
  UNSUPPORTED_FIELD,
  withSharedPassword,
  type AutoconfigAnswer,
  type AutoconfigRequestBody,
  type MailboxDraft,
  type MailboxProbeOutcome,
  type MailboxProbeReport,
  type MailboxRequestBody,
  type MailboxSetupStep,
  type ProviderPreset,
  type ProvidersRequestBody,
} from "../../shared/settings-api.js";
import {
  MAILBOX_DEFAULTS,
  renderConnectStep,
  renderCredentialsStep,
  renderMailboxAddressStep,
  renderMailboxProviderStep,
  renderMailboxStep,
  renderMailboxSuggestionStep,
  renderSetupComplete,
  SAVE_ANYWAY_ACTION,
  type ConfiguredMailbox,
  type ConnectPageData,
  type MailboxAddressPageData,
  type MailboxPageData,
  type MailboxProbeLine,
  type MailboxProbeView,
  type MailboxProviderPageData,
  type MailboxSuggestionPageData,
  type MailboxView,
  type StepTwoLinks,
} from "./setup-pages.js";
import { sendPage as sendHtmlPage, sendRedirect } from "./settings-pages.js";
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
        sendPage(res, 200, await renderStep(step, base, viewOf(req)));
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
   * Step 2 — the first mailbox, over three screens and one form action each.
   *
   * `_action` tells them apart, and the first four are the cascade:
   *
   *   `lookup`    tier 1 — ask the connector what the address's domain says,
   *               and show it for confirmation, or fall through to tier 2
   *   `provider`  tier 2 — a chosen preset, filled into the full form
   *   `edit`      the confirmation screen's `Edit these`, likewise
   *   `skip`      configure nothing and go to step 3
   *
   * and the last two are the screen this step used to be, unchanged: `test`,
   * which reports the three services and stores nothing, and `save`, which does
   * both, in that order, and only writes when IMAP and SMTP have each answered.
   *
   * Nothing a tier produces is stored on its own. Every path that ends in an
   * account ends in `save`, which is the one place that probes and the one place
   * that writes — the tiers change how many boxes the operator fills in and
   * nothing whatever about what happens to what is in them.
   *
   * The order is the whole point of the screen. A probe that ran after the write
   * would leave an operator finishing setup over credentials that were already
   * known not to work.
   *
   * The two calls fail differently, and #82 is what happens when they are read
   * as if they did not. Nothing this screen says may claim an outcome it has not
   * established: the probe writes nothing, so silence from it is a fact; the
   * write does, so silence from it is a question, and the answer is one more
   * read of the stamp.
   */
  async function handleMailbox(req: Request, res: Response, base: string): Promise<void> {
    if (!isSameOrigin(req.headers, config.issuer)) {
      sendForbidden(res);
      return;
    }

    const links = stepTwoLinks(base);

    /**
     * The connector's warning about this address, as this submission carried it.
     *
     * Assigned once the body is parsed, and consulted by {@link page} so the
     * full form keeps saying it across a *Test connection* or a refused save —
     * every screen the address survives on, which is #186's whole point.
     *
     * A hidden field rather than a second lookup because the domain match is
     * the connector's (#180) and this package must not grow a copy of it, and
     * because the lookup that produced the sentence costs a DNS cascade. The
     * cost of carrying it is that it travels with the *form*, not with the
     * address: an operator who edits the address box on a later screen carries
     * the previous address's warning as far as the next lookup. It warns and
     * never blocks, so the price of that is one sentence too many rather than a
     * mailbox that cannot be saved.
     */
    let carried: string | null = null;

    const page = (status: number, data: Partial<MailboxPageData>): void => {
      sendPage(
        res,
        status,
        renderMailboxStep({
          action: links.action,
          backHref: links.backHref,
          addressHref: links.addressHref,
          providersHref: links.providersHref,
          values: {},
          errors: {},
          ...(carried === null ? {} : { warning: carried }),
          ...(mailboxes === null ? { unavailable: true } : {}),
          ...data,
        })
      );
    };
    const addressPage = (status: number, data: Partial<MailboxAddressPageData>): void => {
      sendPage(res, status, renderMailboxAddressStep({ ...links, email: "", errors: {}, ...data }));
    };
    const providerPage = (status: number, data: Partial<MailboxProviderPageData>): void => {
      sendPage(res, status, renderMailboxProviderStep(providerPageData(links, data)));
    };

    try {
      await parseForm(req, res);
    } catch {
      page(400, { notice: { kind: "error", message: "That form could not be read. Try again." } });
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const action = stringField(body._action);
    // The connector's own words, come back to us. Never recomputed here — see
    // `carried` above and #180's option B.
    carried = stringField(body[UNSUPPORTED_FIELD]) || null;

    if (action === "skip") {
      // Someone evaluating the thing should not need mail credentials to hand,
      // whichever of the three screens they are looking at when they decide
      // that. Nothing is written, nothing is contacted, and step 3 says plainly
      // that no mailbox is configured.
      log("info", "setup step 2 skipped: no mailbox was configured", {});
      await state.advanceTo("connect");
      redirect(res, `${base}/connect`, 303);
      return;
    }

    if (mailboxes === null) {
      // No settings signing key: the connector would refuse every request this
      // step makes — the lookup included — so it makes none and says so instead
      // of failing obscurely on whichever tier the operator happened to be on.
      page(200, {});
      return;
    }
    // Re-bound now that the null case is behind us: the closures below outlive
    // the narrowing above, and two of them call the connector.
    const client = mailboxes;

    /**
     * One step of the cascade, in this wizard's chrome.
     *
     * Which step it is was decided by `stepFrom*` in settings-api.ts, which the
     * connector's own *Add mailbox* page calls too (#141). What is decided here
     * is only how it is painted and what status it goes out under — and the
     * switch is total, so a screen added to the cascade stops this file
     * compiling rather than falling through to a blank page.
     */
    const sendStep = async (
      decided: MailboxSetupStep,
      opts: {
        /** Already fetched by the caller, when the caller needed them anyway. */
        presets?: readonly ProviderPreset[];
        notice?: MailboxPageData["notice"];
      } = {}
    ): Promise<void> => {
      // #186's two slots, on this side of the hop. `notice` is what this screen
      // has to say about this submission; the warning is what the connector
      // said about the address, and it is on the step because it stays true for
      // every screen the address survives on. Neither displaces the other.
      const warning = decided.unsupported === null ? {} : { warning: decided.unsupported };

      switch (decided.view) {
        case "address":
          // The only way back to tier 1 is an address that could not be read.
          // That *is* shown as an error, and it is not an autoconfig failure: it
          // is about what the operator typed, on a submission that never became
          // a lookup at all.
          addressPage(400, { email: decided.email, errors: decided.errors });
          return;

        case "suggestion":
          sendPage(
            res,
            200,
            renderMailboxSuggestionStep({
              ...links,
              domain: decided.domain,
              sourceLabel: decided.sourceLabel,
              values: decided.values,
              password: decided.password,
              errors: {},
              ...warning,
            })
          );
          return;

        case "providers": {
          const presets = opts.presets ?? (await client.providers(decided.email));
          if (presets === null) {
            // The connector could not say what its table holds. There is no list
            // to show, so this falls to the tier below rather than rendering an
            // empty one — the same shape of degradation a lookup that answers
            // nothing gets, and for the same reason: a screen offering nothing
            // is worse than the form the operator can always fill in.
            //
            // The warning comes with it. This is the one path where a
            // miss-that-still-warns could quietly become "found nothing, here
            // is the manual form" and lose the sentence on the way, which is
            // the shape #180 says to watch for.
            page(200, {
              values: carrying(emptyMailboxValues(decided.email), decided.password),
              ...warning,
            });
            return;
          }
          providerPage(Object.keys(decided.errors).length === 0 ? 200 : 400, {
            providers: presets,
            email: decided.email,
            domain: decided.domain,
            selected: decided.selected,
            password: decided.password,
            errors: decided.errors,
            ...warning,
          });
          return;
        }

        case "manual":
          page(200, {
            values: decided.values,
            ...warning,
            ...(opts.notice === undefined ? {} : { notice: opts.notice }),
          });
          return;
      }
    };

    if (action === "lookup") {
      const email = stringField(body[ADDRESS_FIELD]).trim();
      // The password the operator typed on the address screen. It is in this
      // request, it is going to be needed by whichever screen comes next, and
      // dropping it here is #120: the wizard asking for the same mailbox
      // password a second time, with a screen in between that never mentioned
      // the first. It travels on in the form and reaches no file: the wizard's
      // state is still `{version, furthest}` and nothing about a mailbox is
      // written anywhere until `save` has been through the connector's probe.
      const password = stringField(body[SHARED_PASSWORD_FIELD]);

      // Guarded here rather than left to `stepFromLookup`, which checks the
      // address again for its own reasons: an address with no domain in it has
      // nothing to look up, and this is the one call in step 2 that reaches out
      // to the internet on the strength of what somebody typed.
      const askable = domainOf(email) !== "";
      const answer: AutoconfigAnswer = askable ? await client.lookup(email) : { suggestion: null };
      const found = answer.suggestion;
      if (askable) {
        // A boolean and nothing else. Not the address, and not the hosts.
        log("info", "setup step 2 looked up an address", { found: found !== null });
      }

      // #180. The same call, the same address, the same moment — the lookup was
      // always here, and this is the field that was missing from its answer. A
      // brand-new operator adding their first mailbox now hears "no password
      // will connect" on the screen this leads to, instead of finding out three
      // screens later.
      carried = answer.unsupported ?? null;

      await sendStep(
        stepFromLookup({
          email,
          password,
          found,
          defaults: stepDefaults(),
          unsupported: carried,
        })
      );
      return;
    }

    if (action === "provider") {
      const email = stringField(body[ADDRESS_FIELD]).trim();
      const chosen = stringField(body[PROVIDER_FIELD]);
      // Empty when this screen was reached from its own link rather than from a
      // lookup, which is the only difference the two routes make here.
      const password = stringField(body[SHARED_PASSWORD_FIELD]);

      const presets = await client.providers(email);
      if (presets === null) {
        // Same fallback the provider screen itself has: with no table there is
        // nothing to resolve the chosen id against, and the form is where the
        // operator was heading anyway. `page` puts the carried warning back on
        // it, so this path drops nothing either.
        page(200, { values: carrying(emptyMailboxValues(email), password) });
        return;
      }

      const decided = stepFromProvider({
        email,
        password,
        chosen,
        presets,
        defaults: stepDefaults(),
        unsupported: carried,
      });
      if (decided.view === "manual" && decided.preset !== null) {
        log("info", "setup step 2: a provider preset was chosen", { provider: decided.preset.id });
      }
      await sendStep(decided, {
        presets,
        ...(decided.view === "manual" && decided.preset !== null
          ? { notice: presetNotice(decided.preset.label, password) }
          : {}),
      });
      return;
    }

    if (action === "edit") {
      // `Edit these` on the confirmation screen: the same values, in the form
      // that can change them. `formValues` inside `stepFromEdit` is what strips
      // the passwords, which is why this goes through a draft rather than
      // echoing the body back — and `carrying` then puts back the one the
      // operator typed, which came in on this submission rather than out of
      // anything the wizard stored.
      const password = stringField(body[SHARED_PASSWORD_FIELD]);
      await sendStep(
        stepFromEdit({ fields: body, password, defaults: stepDefaults(), unsupported: carried }),
        {
          // The press #186 is about. This sentence is about this submission and
          // the warning is about the address; they have a slot each now, and
          // the full form shows both.
          notice: {
            kind: "info",
            message: "Nothing has been saved. Change whatever is wrong and test the connection.",
          },
        }
      );
      return;
    }

    if (action !== "test" && action !== "save" && action !== SAVE_ANYWAY_ACTION) {
      page(400, {
        notice: { kind: "error", message: "That form could not be read. Try again." },
      });
      return;
    }

    const draft = draftFromFields(withSharedPassword(body));
    // Not `formValues(draft)`: this form's password boxes are `required`, and a
    // re-render that strips them is a page whose buttons cannot be pressed.
    // See {@link withCarriedPasswords}.
    const values = withCarriedPasswords(draft);

    // `Test connection`: probe, report, store nothing. Still the wizard's own
    // call, because that is all this button is — a question with no write
    // behind it, which is exactly why it never needed to be a gate.
    if (action === "test") {
      const tested = await mailboxes.test(draft);
      if (tested.kind === "unreachable") {
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

      if (tested.kind === "rejected") {
        log("info", "setup step 2: the connector rejected the mailbox details", {
          fields: Object.keys(tested.errors).length,
        });
        page(400, {
          values,
          errors: tested.errors,
          notice: {
            kind: "error",
            message:
              "These details were not accepted, so nothing was tested and nothing was saved.",
          },
        });
        return;
      }

      if (tested.kind === "refused") {
        log("error", "setup step 2: the connector refused the connection test", {
          status: tested.status,
        });
        page(502, { values, notice: refusedNotice(tested.status) });
        return;
      }

      if (tested.kind === "unreadable") {
        // Fail closed. An answer this build cannot read is not evidence that
        // the mailbox works, and nothing on this screen may claim an outcome it
        // has not established.
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

      const probe = probeView(tested.value);
      // Booleans only. Nothing the operator typed is logged here, on any path.
      log("info", "setup step 2 tested a mailbox", {
        action,
        imap: probe.imap.ok,
        smtp: probe.smtp.ok,
        caldav: probe.caldav.tested ? probe.caldav.ok : null,
      });
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

    // Save, and `Save anyway`. Neither probes here: the write route does that
    // itself since #147, refuses on a rejected IMAP or SMTP, and sends the
    // report back with the refusal. What this used to do — call the probe
    // route, read the result and only then call the write route — put the rule
    // in the caller rather than in the thing being protected, so the settings
    // UI, which never had that caller, had no rule at all. The operator sees
    // the same screens either way; there is simply one fewer round trip and one
    // fewer place for the two paths to disagree about what a save means.
    const saveAnyway = action === SAVE_ANYWAY_ACTION;

    const stamp = await mailboxes.stamp();
    if (stamp === null) {
      log("error", "setup step 2: the connector would not say what accounts.json looks like", {});
      page(502, {
        values,
        notice: {
          kind: "error",
          message:
            "The connector did not answer when asked what its account file looks like, so " +
            "nothing was stored. Try again.",
        },
      });
      return;
    }

    const created = await mailboxes.create(draft, stamp, saveAnyway);
    if (created.kind === "unreachable") {
      // The one call in this step whose outcome no answer settles. `Test
      // connection` can say "nothing was tested and nothing was saved" because
      // it writes nothing whatever happens to it; this request does, and by the
      // time the signal fires it has already gone out. The connector may have
      // stored the mailbox and merely lost the answer on the way back.
      //
      // So this asks instead of asserting. `accounts.json` is the thing the
      // write moves, its stamp is the fact the connector will state about it,
      // and nothing else is writing to that file while the settings UI is
      // unmounted — a stamp that has moved is the write, landed. That also
      // covers the refusals that reach this branch without a request ever being
      // delivered (a reset, a connector that is not listening): those leave the
      // stamp exactly where it was, which is the answer they deserve.
      log("warn", "setup step 2 got no answer to the save", { error: created.error });
      const after = await mailboxes.stamp();

      if (after !== null && after !== stamp) {
        log("info", "setup step 2 completed: the save went unanswered, but the mailbox is there", {
          error: created.error,
        });
        await state.advanceTo("connect");
        redirect(res, `${base}/connect`, 303);
        return;
      }

      if (after === null) {
        // Unreachable twice over. There is no fact to report, so the screen
        // says that rather than picking the reassuring half of it — and points
        // at the retry, which the connector answers safely either way: an
        // account whose id is taken is refused, not stored a second time.
        log("error", "setup step 2 cannot say whether the mailbox was stored", {});
        page(502, {
          values,
          notice: {
            kind: "error",
            message:
              "The connector did not answer when asked to save, and could not be asked " +
              "afterwards what it did — so this may or may not have been saved. Get the " +
              "connector answering again, then press Save and continue once more: a mailbox " +
              "that is already stored is refused by its ID rather than stored twice.",
          },
        });
        return;
      }

      log("warn", "setup step 2: the save went unanswered and accounts.json did not move", {});
      page(502, {
        values,
        notice: {
          kind: "error",
          message:
            "The connector did not answer when asked to save, and its account file is " +
            "unchanged. Nothing was stored. Try again.",
        },
      });
      return;
    }

    if (created.kind === "rejected") {
      // Two different refusals arrive here, and the operator's next move is not
      // the same for them. A refusal carrying a probe report is the connector's
      // save-path gate: the credentials themselves did not work, and the report
      // is what says which service and why. Anything else is the connector
      // objecting to a *field* — an id already taken, a port that is not a
      // port — with nothing wrong with the servers at all.
      const refusedByProbe = created.probe;
      log("error", "setup step 2: the connector refused to save the mailbox", {
        status: created.status,
        fields: Object.keys(created.errors).length,
        probed: refusedByProbe !== undefined,
      });
      page(400, {
        values,
        errors: created.errors,
        probe: refusedByProbe === undefined ? undefined : probeView(refusedByProbe),
        notice: {
          kind: "error",
          message:
            refusedByProbe === undefined
              ? "The connector refused to store these details, so this attempt added " +
                "nothing. What it objected to is marked below; fix that and try again."
              : // The connector's own sentence, so this screen and the
                // connector's settings form say the same thing about the same
                // refusal. Taken from the answer when it carried one — that is
                // the sentence the connector actually wrote, and on a credential
                // rejection it names what the operator's own provider requires
                // (#148), which this package has no table to work out. Falling
                // back to computing it from the report keeps a connector that
                // sent no message saying what it said before.
                (created.message ??
                saveRefusedNotice(refusedByProbe) ??
                "Nothing was saved. Fix what failed above and try again."),
        },
      });
      return;
    }

    if (created.kind === "refused") {
      log("error", "setup step 2: the connector refused to save the mailbox", {
        status: created.status,
        fields: 0,
      });
      page(502, { values, notice: refusedNotice(created.status) });
      return;
    }

    // "ok", or a 201 whose body this build could not read — and the status is
    // what says the account is there. Reading an unreadable 201 as a failure is
    // the other half of #82: it would send the operator into a retry the
    // connector answers with "an account with id … already exists".
    log("info", "setup step 2 completed: a mailbox was saved", { probed: !saveAnyway });
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

  async function renderStep(step: SetupStep, base: string, view: MailboxView): Promise<string> {
    if (step === "credentials") {
      return renderCredentialsStep({
        action: `${base}/credentials`,
        username: "",
        problems: [],
      });
    }
    if (step === "mailbox") {
      const links = stepTwoLinks(base);
      // The three tiers on GET, chosen by `?view=`. A bare URL is tier 1 — the
      // address screen — which is what makes it the default the operator meets
      // and the full form the fallback rather than the front door. `?view=` is
      // how the `Choose provider manually` link and its sibling reach the other
      // two at any time, including after a Back from step 3.
      if (mailboxes === null) {
        return renderMailboxStep({ ...links, values: {}, errors: {}, unavailable: true });
      }
      if (view === "manual") {
        return renderMailboxStep({ ...links, values: {}, errors: {} });
      }
      if (view === "providers") {
        // The table is the connector's (#126 / #141), so tier 2 is one more
        // question over the same hop the probe and the lookup already go over.
        // A connector that cannot answer it leaves nothing to list, and the
        // answer to that is the tier below rather than an empty fieldset.
        const presets = await mailboxes.providers("");
        if (presets === null) {
          return renderMailboxStep({ ...links, values: {}, errors: {} });
        }
        return renderMailboxProviderStep(providerPageData(links, { providers: presets }));
      }
      return renderMailboxAddressStep({ ...links, email: "", errors: {} });
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

/**
 * The submitted mailbox as the form's own values, with the passwords kept.
 *
 * The wizard's mirror of `withCarriedPasswords` in the connector's
 * settings-routes.ts, and for the same reason (#183, the sibling of #130).
 * {@link formValues} strips every {@link MAILBOX_SECRET_FIELDS} name out of a
 * draft, and `renderMailboxStep` marks the IMAP and SMTP boxes `required` —
 * rightly, because step 2's form only ever creates a mailbox and a blank
 * password on create is an error rather than "keep the stored one". Together
 * they handed the operator two empty, mandatory password boxes on the refusal
 * page, under a sentence ending "…or press Save anyway to store it without
 * testing it": that button, and Save and continue beside it, did nothing but
 * pop the browser's "Please fill out this field" bubble on a box the answer had
 * just cleared. The advertised escape hatch was a dead end on the first screen
 * a new operator meets.
 *
 * The stripping rule is about a password read back out of *storage* — that one
 * is never written into a page, on either side of the hop, and nothing here
 * changes it. What is carried is the operator's own submission, still in
 * flight, on its way back to the form that is about to send it again: it came
 * in on this request, it is already in memory, it reaches no file and no log,
 * and the page says on its face that the boxes are filled rather than empty
 * (see `passwordNote`). It is the rule the cascade has followed since #120.
 *
 * Blank stays blank, so a service the operator gave no password for is not
 * described as carrying one.
 */
function withCarriedPasswords(draft: MailboxDraft): Record<string, string> {
  const values = formValues(draft);
  const submitted = flattenDraft(draft);
  for (const name of MAILBOX_SECRET_FIELDS) {
    const typed = submitted[name] ?? "";
    if (typed !== "") values[name] = typed;
  }
  return values;
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

// ---- Step 2's three screens ------------------------------------------------

/** Every URL step 2's screens link to, built once from the token'd base. */
function stepTwoLinks(base: string): StepTwoLinks {
  return {
    action: `${base}/mailbox`,
    backHref: `${base}/credentials`,
    addressHref: `${base}/mailbox`,
    providersHref: `${base}/mailbox?view=providers`,
    manualHref: `${base}/mailbox?view=manual`,
  };
}

/**
 * Which tier a GET is asking for. Anything unrecognised is tier 1, because a
 * mistyped query is not a reason to show someone eighteen boxes.
 */
function viewOf(req: Request): MailboxView {
  const view = req.query?.view;
  if (view === "providers" || view === "manual") return view;
  return "address";
}

/** The provider screen's data, with the wizard's own blanks filled in. */
function providerPageData(
  links: StepTwoLinks,
  data: Partial<MailboxProviderPageData>
): MailboxProviderPageData {
  return {
    ...links,
    providers: [],
    domain: "",
    email: "",
    selected: "",
    password: "",
    errors: {},
    ...data,
  };
}

/**
 * What step 2's mailbox starts out as, before a lookup or a preset fills it in.
 *
 * This is the wizard's half of the one thing the two entry points genuinely
 * disagree about. Its mailbox is the *first* one — `main`, and the account the
 * mail tools reach for when none is named — where the connector's *Add mailbox*
 * page derives an id from the address and makes it the default only on an empty
 * instance. Everything else about the cascade is the same code (#141).
 */
function stepDefaults(): Record<string, string> {
  return { ...MAILBOX_DEFAULTS, [MAILBOX_FIELDS.isDefault]: CHECKBOX_ON };
}

/** What the full form says when a provider preset has just filled it in. */
function presetNotice(label: string, password: string): { kind: "info"; message: string } {
  return {
    kind: "info",
    message:
      `${label} settings have been filled in. Check them` +
      (password === "" ? ", add the passwords" : "") +
      ", and test the connection before saving.",
  };
}

// The wizard's three send sites, each one line of delegation to the shared
// helpers in settings-pages.ts. The argument orders below are the ones this
// file's call sites already use; the header set is no longer named here, and
// `SETUP_HEADERS` — a bare alias of `SETTINGS_HEADERS`, two names for one
// object in one package — is gone with it (#80).

function redirect(res: Response, location: string, status = 302): void {
  sendRedirect(res, status, location);
}

function sendPage(res: Response, status: number, html: string): void {
  sendHtmlPage(res, status, html);
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
  sendHtmlPage(res, status, renderErrorPage(title, message));
}

// ---- The connector's mailbox routes, as step 2 uses them -------------------

/** The connector's routes. Their paths are also what the assertion is bound to. */
const UPSTREAM_NEW = "/settings/mailboxes/new";
const UPSTREAM_TEST = "/settings/mailboxes/test";
const UPSTREAM_CREATE = "/settings/mailboxes";
const UPSTREAM_AUTOCONFIG = "/settings/autoconfig";
const UPSTREAM_PROVIDERS = "/settings/providers";

/**
 * Who the assertion says is asking.
 *
 * Not an operator's session, because there is not one yet — the settings UI is
 * unmounted until the instance is claimed. The connector uses `sub` for nothing
 * but its own audit trail, and a name that says where the request came from is
 * more use there than a borrowed username would be.
 */
const SETUP_SUBJECT = "setup-wizard";

/**
 * The two budgets below are the connector's own plus this, and that addition is
 * the whole of #134.
 *
 * A wizard budget under the connector's abandons a call that is still running
 * and shows the operator *"the connector did not answer"* about work that was
 * going to succeed — #82's failure, reached from the other end. The rule used to
 * be three comments in this file naming numbers that lived in the other package,
 * where no compiler and no single suite could see both. Now the connector's
 * budgets are imported and the wizard's are arithmetic on them, so raising one
 * over there raises this one with it. What is left to get wrong is the slack
 * itself, and `oauth/test/unit/setup-wizard.test.ts` pins that it is positive.
 *
 * The derivation holds for the connector's *default* budget, which is what the
 * routes this wizard calls actually run under. `probeAccount` and
 * `lookupMailboxSettings` both accept a `totalMs` override, and nothing but a
 * test passes one today; a future caller that does owns this invariant itself,
 * because no arithmetic here can see its argument.
 *
 * Both are exported for that test and for nothing else.
 */
export const PROBE_SLACK_MS = 5_000;

/**
 * Less slack than the probe gets, because the cascade is likelier to use all of
 * its budget: a lookup that runs to the end of it still has an answer to send —
 * `null`, and the screen after that is the provider list. Aborting at exactly
 * the connector's number would turn that into no answer, which is the same
 * screen for the operator but a warning in the log about a connector that did
 * precisely what it promised.
 */
export const LOOKUP_SLACK_MS = 3_000;

/** Longer than the connector's own probe budget, and not much longer. */
export const PROBE_TIMEOUT_MS = CONNECTOR_PROBE_BUDGET_MS + PROBE_SLACK_MS;

/** The autoconfig cascade's own budget plus the slack to hear about it. */
export const LOOKUP_TIMEOUT_MS = CONNECTOR_AUTOCONFIG_BUDGET_MS + LOOKUP_SLACK_MS;

/**
 * Everything else upstream is a file read and a render.
 *
 * The write used to be in that list. It is not since #147: `POST
 * /settings/mailboxes` probes before it writes, so it is a probe-then-write and
 * takes {@link PROBE_TIMEOUT_MS} — the same budget the separate
 * `/settings/mailboxes/test` call gets, and for the same reason. What still
 * belongs here is the stamp read, the lookup's siblings, and the one save that
 * genuinely is only a file write: *Save anyway*, which asks the connector not
 * to probe at all.
 *
 * Not derived from anything, unlike the two above, and that is the honest shape
 * of it: there is no connector-side deadline on the other end of these calls to
 * be above. The number was weighed under #82 and stands — raising it would only
 * hold an operator in front of a blank screen when the connector is genuinely
 * wedged, and what hurt there was never the length of the wait but what the
 * screen claimed at the end of it.
 */
export const QUICK_TIMEOUT_MS = 5_000;

/**
 * Which of the two `POST /settings/mailboxes` is, since #147 made that one route
 * two different calls.
 *
 * *Save anyway* asks the connector to write without probing, and a write does
 * not need the long budget. That reasoning is sound and this keeps it — but it
 * made the route a third site where a probe budget is chosen, coupled to the
 * connector's by nothing but the comment above, in a line younger than the issue
 * that exists to remove exactly that. Choosing here, once, is what lets the test
 * assert the invariant over the branch that probes instead of over a constant
 * that some call sites use and one does not.
 */
export function saveTimeoutMs(saveAnyway: boolean): number {
  return saveAnyway ? QUICK_TIMEOUT_MS : PROBE_TIMEOUT_MS;
}

/**
 * What one call to the connector came back as.
 *
 * Five outcomes rather than a status code and a body, because step 2 acts
 * differently on every one of them and the difference is the whole of #82:
 * `rejected` is the connector saying no about a field, `refused` is it saying no
 * about the request, `unreadable` is an answer this build cannot act on, and
 * `unreachable` is no answer at all — which for a write is a question rather
 * than a verdict.
 */
type ConnectorAnswer<T> =
  | { kind: "ok"; value: T }
  /**
   * 400 or 409, with whatever it said about which field — and, when the refusal
   * was the connector's save-path probe, the report that explains it (#147).
   * `probe` present means "the credentials are why nothing was stored"; absent
   * means the connector objected to the request itself.
   */
  | {
      kind: "rejected";
      status: number;
      errors: Record<string, string>;
      probe?: MailboxProbeReport;
      /**
       * The connector's own sentence about this refusal, when it sent one.
       *
       * Carried rather than recomputed because the connector can say more than
       * this package can work out: it holds the provider table, so on a
       * credential rejection its sentence names what *that provider* wants
       * instead of the generic app-password advice (#148). Absent from a
       * connector that predates it, which is what the fallback below is for.
       */
      message?: string;
    }
  /** Any other status: not about the mailbox, about the request. */
  | { kind: "refused"; status: number }
  /** The expected status, in a shape this build does not understand. */
  | { kind: "unreadable" }
  | { kind: "unreachable"; error: string };

/** The 201 body is a courtesy; the status is the fact. See {@link handleMailbox}. */
const STORED = "stored";

interface MailboxClient {
  /** Probe without saving: the connector's own "Test connection" action. */
  test(draft: MailboxDraft): Promise<ConnectorAnswer<MailboxProbeReport>>;
  /**
   * What the connector knows about the address: what its domain publishes, if
   * anything, and whether no password will ever be accepted there (#180).
   *
   * The whole answer rather than just its `suggestion`, because the two halves
   * are independent and both are needed at the same moment. `suggestion: null`
   * still covers "nothing published" and every failure alike, by design, and a
   * failure answers `{ suggestion: null }` with no warning on it. Never throws.
   */
  lookup(email: string): Promise<AutoconfigAnswer>;
  /**
   * Tier 2's table, with every entry already filled in for `email`, or null when
   * the connector could not be asked or answered in a shape this build cannot
   * read. The values live in the connector (`src/providers.ts`) rather than
   * here, and #126 in settings-api.ts is the argument for that.
   */
  providers(email: string): Promise<readonly ProviderPreset[] | null>;
  /**
   * The current `accounts.json` stamp, as the connector states it. Also what an
   * unanswered {@link MailboxClient.create} is settled by: asked a second time,
   * a stamp that has moved is the write, landed.
   */
  stamp(): Promise<string | null>;
  /**
   * Write the account. 201 means it is stored; anything else means it is not.
   * No answer at all means neither — see `handleMailbox`.
   *
   * `saveAnyway` is the operator having pressed the second button: it travels
   * as {@link SAVE_ANYWAY_FIELD} and tells the connector to write without
   * probing. Left false, the connector probes first and a rejected IMAP or SMTP
   * comes back as a `rejected` answer carrying the report.
   */
  create(
    draft: MailboxDraft,
    stamp: string,
    saveAnyway: boolean
  ): Promise<ConnectorAnswer<typeof STORED>>;
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

  async function call<T>(opts: {
    method: "GET" | "POST";
    path: string;
    /**
     * The request document, built around the CSRF value minted for this call —
     * or null for the read-only one, which sends no body at all. A function
     * rather than a value because `_csrf` does not exist until we are inside.
     */
    payload:
      | ((csrf: string) => MailboxRequestBody | AutoconfigRequestBody | ProvidersRequestBody)
      | null;
    timeoutMs: number;
    /** The status that means the operation happened. */
    okStatus: number;
    /** Read the body of that status, or null if it is not in a shape we know. */
    read: (payload: unknown) => T | null;
  }): Promise<ConnectorAnswer<T>> {
    // Minted per request and thrown away with it, the way the settings proxy
    // mints one per proxied request. The `csrf` claim and the `_csrf` field are
    // the same value because the connector compares them — that check binds a
    // browser form to a session, and there is no browser on this hop.
    const csrf = randomBytes(24).toString("base64url");
    const assertion = signAssertion(
      { sub: SETUP_SUBJECT, sid: randomUUID(), csrf, method: opts.method, path: opts.path },
      key,
      config.issuer
    );
    const body = opts.payload === null ? null : opts.payload(csrf);

    try {
      const res = await fetch(`${config.upstreamMcpUrl}${opts.path}`, {
        method: opts.method,
        redirect: "manual",
        headers: {
          authorization: `Bearer ${config.upstreamAuthToken}`,
          [ASSERTION_HEADER]: assertion,
          // The whole of the negotiation. Without this the connector answers
          // the same routes with the page a browser would get.
          accept: "application/json",
          ...(body === null ? {} : { "content-type": "application/json" }),
        },
        ...(body === null ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(opts.timeoutMs),
      });

      const payload = await readJson(res);
      if (res.status === opts.okStatus) {
        const value = opts.read(payload);
        return value === null ? { kind: "unreadable" } : { kind: "ok", value };
      }
      if (res.status === 400 || res.status === 409) {
        const answer = parseErrorAnswer(payload);
        return {
          kind: "rejected",
          status: res.status,
          errors: answer.errors,
          ...(answer.probe === undefined ? {} : { probe: answer.probe }),
          // An empty string is not a sentence, and reading one as though it
          // were would replace the fallback below with a blank notice.
          ...(answer.message === undefined || answer.message === ""
            ? {}
            : { message: answer.message }),
        };
      }
      return { kind: "refused", status: res.status };
    } catch (err) {
      // The message only, and only from an Error: the request body on this hop
      // is a mailbox password, and a thrown object is not always as tidy.
      return { kind: "unreachable", error: err instanceof Error ? err.message : "failed" };
    }
  }

  return {
    test: (draft) =>
      call({
        method: "POST",
        path: UPSTREAM_TEST,
        payload: (csrf) => ({ _csrf: csrf, _stamp: "", mailbox: draft }),
        timeoutMs: PROBE_TIMEOUT_MS,
        okStatus: 200,
        read: parseProbeAnswer,
      }),
    create: (draft, stamp, saveAnyway) =>
      call({
        method: "POST",
        path: UPSTREAM_CREATE,
        payload: (csrf) => ({
          _csrf: csrf,
          _stamp: stamp,
          mailbox: draft,
          // Sent only when it is true. An absent field and a `false` one mean
          // the same thing to the connector, and the absent one cannot be read
          // as an override by anything in between.
          ...(saveAnyway ? { [SAVE_ANYWAY_FIELD]: true } : {}),
        }),
        // The write probes now (#147), so it is a probe-then-write after all
        // and gets the probe's budget — unless the operator asked for it not to
        // be, which is the one case that really is just a file write.
        timeoutMs: saveTimeoutMs(saveAnyway),
        okStatus: 201,
        // Not `parseCreatedAnswer`. The 201 is what says the account is there,
        // and nothing on this screen depends on the id or the stamp it echoes.
        read: () => STORED,
      }),

    /**
     * Tier 1, and the one call here whose failures all collapse into one shape.
     *
     * Every outcome that is not a readable suggestion returns `null`, because
     * §7 of the design says no autoconfig failure is ever shown to the operator
     * as an error and the screen's answer to all of them is the same: the
     * provider list. A connector that is down, one on a release whose answer
     * this build cannot read, and a domain that simply publishes nothing are
     * indistinguishable here on purpose.
     *
     * They are distinguishable in the log, though, which is where an operator
     * looking for why their domain was not detected can actually act on the
     * difference. The address is not logged: it is the one field in this wizard
     * that identifies a person.
     */
    async lookup(email) {
      const answer = await call({
        method: "POST",
        path: UPSTREAM_AUTOCONFIG,
        payload: (csrf) => ({ _csrf: csrf, email }),
        timeoutMs: LOOKUP_TIMEOUT_MS,
        okStatus: 200,
        read: parseAutoconfigAnswer,
      });
      if (answer.kind === "ok") return answer.value;
      log("warn", "setup step 2: the autoconfig lookup did not answer usefully", {
        kind: answer.kind,
        status: answer.kind === "rejected" || answer.kind === "refused" ? answer.status : 0,
      });
      // A connector that could not be asked has said nothing about this
      // address either — including that it cannot be served. Silence is the
      // one honest answer here; inventing a warning out of an unreachable
      // connector would be this package doing the domain match itself.
      return { suggestion: null };
    },

    /**
     * Tier 2's table, asked for rather than kept.
     *
     * Unlike the lookup above, a failure here is *not* folded into the tier
     * below silently by this function — `null` is distinguishable from an empty
     * list, and the caller does something different with each: an empty list is
     * a table with nothing in it, which cannot happen, and `null` is "we could
     * not ask", which sends the operator to the full form. Both end up somewhere
     * usable and neither is reported as an autoconfig failure, because neither
     * is one.
     */
    async providers(email) {
      const answer = await call({
        method: "POST",
        path: UPSTREAM_PROVIDERS,
        payload: (csrf) => ({ _csrf: csrf, email }),
        timeoutMs: QUICK_TIMEOUT_MS,
        okStatus: 200,
        read: parseProvidersAnswer,
      });
      if (answer.kind !== "ok") {
        log("warn", "setup step 2 could not read the provider list", {
          kind: answer.kind,
          status: answer.kind === "rejected" || answer.kind === "refused" ? answer.status : 0,
        });
        return null;
      }
      return answer.value.providers;
    },

    async stamp() {
      // Read immediately before the write rather than embedded in the wizard's
      // own form, so the connector's optimistic-concurrency check cannot fail
      // over the minutes an operator spends typing a mailbox in.
      const answer = await call({
        method: "GET",
        path: UPSTREAM_NEW,
        payload: null,
        timeoutMs: QUICK_TIMEOUT_MS,
        okStatus: 200,
        read: parseStampAnswer,
      });
      if (answer.kind !== "ok") {
        log("warn", "setup step 2 could not read the accounts stamp", {
          status: answer.kind === "rejected" || answer.kind === "refused" ? answer.status : 0,
        });
        return null;
      }
      return answer.value;
    },
  };
}

/** The body, or undefined when there was not one this build could decode. */
async function readJson(res: { json(): Promise<unknown> }): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

/**
 * The connector's report, in this screen's own terms.
 *
 * The only difference is CalDAV: the connector says `null` for a block it was
 * never given, and this screen has a third state for that — "not tested", which
 * is neither a pass nor a failure and is what an operator who set up mail only
 * should read.
 */
function probeView(report: MailboxProbeReport): MailboxProbeView {
  const line = (outcome: MailboxProbeOutcome | null): MailboxProbeLine => {
    if (outcome === null) return { tested: false, ok: false, message: "" };
    return outcome.ok
      ? { tested: true, ok: true, message: "" }
      : { tested: true, ok: false, message: outcome.message };
  };
  return { imap: line(report.imap), smtp: line(report.smtp), caldav: line(report.caldav) };
}
