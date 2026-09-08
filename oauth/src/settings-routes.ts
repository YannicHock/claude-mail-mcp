/**
 * The operator-facing routes.
 *
 * Mounted only when a settings signing key is configured. Without one there is
 * nothing the connector would accept for /settings/mailboxes, and a half-mounted UI
 * that can list mailboxes but not reach them is worse than no UI.
 *
 * The settings sign-in shares the OAuth consent screen's LoginThrottle instance
 * (see app.ts): both guard the same operator secret, and a separate budget here
 * would mean ten attempts instead of five before a lockout. The accepted
 * consequence is that five failures on /settings also lock /authorize for the
 * same window.
 */

import express, { type Response } from "express";

import type { OAuthConfig } from "./config.js";
import { LOGIN_FAILURE_EVENT, type Logger } from "./logger.js";
import { isSameOrigin, renderErrorPage } from "./login.js";
import type { OperatorRecord } from "./operator.js";
import { renderOverview, renderSettingsSignIn, SETTINGS_HEADERS } from "./settings-pages.js";
import {
  CSRF_FIELD,
  clearedSessionCookie,
  csrfMatches,
  newSession,
  readSessionCookie,
  sessionCookie,
  signSession,
  verifySession,
  type SessionClaims,
} from "./session.js";
import type { Store } from "./store.js";
import type { LoginThrottle } from "./throttle.js";

/** Mailbox summary as reported by the connector's /health endpoint. */
export interface MailboxSummary {
  id: string;
  label: string;
  isDefault: boolean;
}

export interface SettingsDeps {
  config: OAuthConfig;
  store: Store;
  operator: OperatorRecord;
  throttle: LoginThrottle;
  log: Logger;
  upstreamHealth: () => Promise<{
    reachable: boolean;
    version: string | null;
    mailboxes: MailboxSummary[];
  }>;
}

function sendSignIn(res: Response, status: number, error?: string): void {
  res
    .status(status)
    .type("html")
    .set(SETTINGS_HEADERS)
    .send(renderSettingsSignIn(error !== undefined ? { error } : {}));
}

function sendForbidden(res: Response): void {
  res
    .status(403)
    .type("html")
    .set(SETTINGS_HEADERS)
    .send(
      renderErrorPage(
        "Request blocked",
        "This form submission did not come from this site, or its session is no longer valid. " +
          "Start again from the beginning."
      )
    );
}

/**
 * Authenticate every /settings request.
 *
 * A failure renders the sign-in page with status 200 rather than redirecting —
 * a redirect to a page that renders a form is a round trip for nothing. On
 * success it attaches the claims to `res.locals.session` and, for GET only,
 * re-signs the same claims with a fresh expiry, so the absolute lifetime in
 * session.ts behaves as an idle timeout for as long as the operator keeps
 * browsing.
 */
export function requireSession(deps: SettingsDeps): express.RequestHandler {
  const { config, operator } = deps;
  const key = config.settingsSigningKey;
  if (key === null) {
    throw new Error("requireSession requires config.settingsSigningKey to be configured");
  }
  return async (req, res, next) => {
    const token = readSessionCookie(req.headers.cookie);
    const claims =
      token !== null ? await verifySession(token, key, config.issuer, operator.sessionEpoch) : null;
    if (claims === null) {
      sendSignIn(res, 200);
      return;
    }
    res.locals.session = claims;
    if (req.method === "GET") {
      const refreshed = await signSession(claims, key, config.issuer);
      res.set("Set-Cookie", sessionCookie(refreshed));
    }
    next();
  };
}

/**
 * Guard every state-changing /settings route. Requires both an origin that
 * matches this service and a CSRF field that matches the current session —
 * either alone is not enough.
 */
export function requireCsrf(deps: SettingsDeps): express.RequestHandler {
  const { config } = deps;
  return (req, res, next) => {
    const session = res.locals.session as SessionClaims | undefined;
    const sameOrigin = isSameOrigin(
      { origin: req.get("origin"), referer: req.get("referer") },
      config.issuer
    );
    const submitted = (req.body as Record<string, unknown> | undefined)?.[CSRF_FIELD];
    const csrfOk = session !== undefined && csrfMatches(session, submitted);
    if (!sameOrigin || !csrfOk) {
      sendForbidden(res);
      return;
    }
    next();
  };
}

export function createSettingsRouter(deps: SettingsDeps): express.Router {
  const { config, store, operator, throttle, log, upstreamHealth } = deps;
  const key = config.settingsSigningKey;
  if (key === null) {
    throw new Error("createSettingsRouter requires config.settingsSigningKey to be configured");
  }

  const router = express.Router();
  const formBody = express.urlencoded({ extended: false, limit: "64kb" });
  const guardSession = requireSession(deps);
  const guardCsrf = requireCsrf(deps);

  router.get("/", guardSession, async (_req, res) => {
    const session = res.locals.session as SessionClaims;
    const health = await upstreamHealth();
    res
      .status(200)
      .type("html")
      .set(SETTINGS_HEADERS)
      .send(
        renderOverview({
          csrf: session.csrf,
          username: session.sub,
          connectorReachable: health.reachable,
          connectorVersion: health.version,
          mailboxes: health.mailboxes,
          clientCount: Object.keys(store.clients).length,
          sessionCount: Object.keys(store.sessions).length,
          canChangePassword: operator.canChangePassword,
        })
      );
  });

  router.post("/login", formBody, async (req, res) => {
    const ip = req.ip ?? "unknown";

    if (throttle.isBlocked(ip)) {
      const retryAfter = throttle.retryAfter(ip);
      log("warn", "login throttled", { ip, retry_after_s: retryAfter, endpoint: "settings" });
      res.set("Retry-After", String(retryAfter));
      sendSignIn(
        res,
        429,
        `Too many failed attempts. Try again in ${Math.ceil(retryAfter / 60)} minute(s).`
      );
      return;
    }

    if (
      !isSameOrigin({ origin: req.get("origin"), referer: req.get("referer") }, config.issuer)
    ) {
      log("warn", "settings login rejected by origin check", { ip });
      sendForbidden(res);
      return;
    }

    const body = req.body as Record<string, unknown>;
    const username = typeof body.username === "string" ? body.username : "";
    const password = typeof body.password === "string" ? body.password : "";

    // Generic on failure: the error never says which field was wrong.
    const ok = await operator.verify(username, password);
    if (!ok) {
      throttle.recordFailure(ip);
      // Fixed shape: the fail2ban filter in docs/HARDENING.md matches this line.
      log("warn", LOGIN_FAILURE_EVENT, { ip, endpoint: "settings" });
      sendSignIn(res, 401, "Incorrect username or password.");
      return;
    }

    throttle.recordSuccess(ip);
    log("info", "settings login succeeded", { ip });

    // A fresh sid and csrf on every successful sign-in — session fixation
    // defence. No cookie exists before this point in the flow.
    const claims = newSession(operator.username, operator.sessionEpoch);
    const token = await signSession(claims, key, config.issuer);
    res
      .status(303)
      .set(SETTINGS_HEADERS)
      .set("Set-Cookie", sessionCookie(token))
      .set("Location", "/settings")
      .end();
  });

  router.post("/logout", formBody, guardSession, guardCsrf, async (req, res) => {
    const body = req.body as Record<string, unknown>;
    if (body.all === "1") {
      await operator.bumpSessionEpoch();
    }
    res
      .status(303)
      .set(SETTINGS_HEADERS)
      .set("Set-Cookie", clearedSessionCookie())
      .set("Location", "/settings")
      .end();
  });

  return router;
}
