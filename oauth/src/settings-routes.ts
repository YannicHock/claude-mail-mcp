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

import express, { type Request, type Response } from "express";

import type { OAuthConfig } from "./config.js";
import { LOGIN_FAILURE_EVENT, type Logger } from "./logger.js";
import { isSameOrigin, renderErrorPage } from "./login.js";
import type { OperatorRecord } from "./operator.js";
import {
  renderClients,
  renderOverview,
  renderPasswordChange,
  renderSettingsSignIn,
  SETTINGS_HEADERS,
} from "./settings-pages.js";
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

/**
 * Read the session claims {@link requireSession} attached to this request.
 *
 * Only meaningful once that guard has run, which is always true where this is
 * called: the settings proxy in app.ts mounts its own {@link requireSession}
 * ahead of the proxy handler, and every route in this file's own router goes
 * through `guardSession` first too. `req.res` is always the same response object
 * Express is building for this request, so this is the same claims object
 * `guardSession` put on `res.locals.session` — just read from the side that
 * doesn't require passing `res` around everywhere it's needed.
 */
export function sessionOf(req: Request): SessionClaims {
  return (req.res as Response).locals.session as SessionClaims;
}

/**
 * Timestamp to stamp a revocation with.
 *
 * One second ahead of "now", not "now" itself. tokens.ts compares an access
 * token's `iat` against this with strict `<`, and both are second-granularity —
 * a token minted in the same wall-clock second as the click that revokes it
 * would otherwise survive the comparison. The one-second margin costs nothing
 * (nothing issued after this call can have an `iat` at or before it) and closes
 * that race, which is what makes "revoke" mean "now" rather than "usually now".
 */
function revocationTimestamp(): number {
  return Math.floor(Date.now() / 1000) + 1;
}

/** Best-effort host of a redirect URI, for display only. */
function hostOf(uri: string): string {
  try {
    return new URL(uri).host;
  } catch {
    return uri;
  }
}

/** Apply the revoke action named by a submitted form body. Unknown bodies are a no-op. */
function applyRevocation(store: Store, body: Record<string, unknown>): void {
  const clientId = typeof body.client_id === "string" ? body.client_id : undefined;
  if (clientId !== undefined) {
    store.revokeClient(clientId, revocationTimestamp());
    return;
  }
  const sid = typeof body.sid === "string" ? body.sid : undefined;
  if (sid !== undefined) {
    store.deleteSession(sid);
    return;
  }
  if (body.all === "1") {
    store.revokeEverything(revocationTimestamp());
  }
}

function redirectToClients(res: Response): void {
  res.status(303).set(SETTINGS_HEADERS).set("Location", "/settings/clients").end();
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

  // ---- Connected clients -------------------------------------------------

  router.get("/clients", guardSession, (_req, res) => {
    const session = res.locals.session as SessionClaims;
    const clients = Object.values(store.clients)
      .sort((a, b) => b.client_id_issued_at - a.client_id_issued_at)
      .map((client) => ({
        id: client.client_id,
        name: client.client_name ?? null,
        issuedAt: client.client_id_issued_at,
        redirectHosts: client.redirect_uris.map(hostOf),
        revoked: client.revokedAt !== undefined,
      }));
    const sessions = Object.entries(store.sessions).map(([sid, refreshSession]) => ({
      sid,
      clientId: refreshSession.clientId,
      scope: refreshSession.scope,
      expiresAt: refreshSession.exp,
    }));
    res
      .status(200)
      .type("html")
      .set(SETTINGS_HEADERS)
      .send(renderClients({ csrf: session.csrf, clients, sessions }));
  });

  // A single dispatching endpoint, keyed on whichever field is present in the
  // submitted body — client_id revokes a client and its sessions, sid ends one
  // session, all=1 revokes everything. The three routes below it exist because
  // the rendered page (settings-pages.ts) links each row's own action, and each
  // one simply supplies the same field the dispatcher already understands.
  router.post("/clients/revoke", formBody, guardSession, guardCsrf, (req, res) => {
    applyRevocation(store, req.body as Record<string, unknown>);
    redirectToClients(res);
  });

  router.post("/clients/:id/revoke", formBody, guardSession, guardCsrf, (req, res) => {
    store.revokeClient(String(req.params.id), revocationTimestamp());
    redirectToClients(res);
  });

  router.post("/sessions/:sid/revoke", formBody, guardSession, guardCsrf, (req, res) => {
    store.deleteSession(String(req.params.sid));
    redirectToClients(res);
  });

  router.post("/clients/revoke-all", formBody, guardSession, guardCsrf, (req, res) => {
    store.revokeEverything(revocationTimestamp());
    redirectToClients(res);
  });

  // ---- Password change ----------------------------------------------------

  router.get("/password", guardSession, (_req, res) => {
    const session = res.locals.session as SessionClaims;
    res
      .status(200)
      .type("html")
      .set(SETTINGS_HEADERS)
      .send(
        renderPasswordChange(
          operator.canChangePassword
            ? { csrf: session.csrf }
            : { csrf: session.csrf, disabledReason: "OPERATOR_FILE is set to none" }
        )
      );
  });

  router.post("/password", formBody, guardSession, guardCsrf, async (req, res) => {
    const session = res.locals.session as SessionClaims;
    const ip = req.ip ?? "unknown";

    // 1. A file-less operator record cannot be written to at all.
    if (!operator.canChangePassword) {
      res
        .status(409)
        .type("html")
        .set(SETTINGS_HEADERS)
        .send(
          renderPasswordChange({
            csrf: session.csrf,
            disabledReason: "OPERATOR_FILE is set to none",
          })
        );
      return;
    }

    // 2. Same budget as every other credential check on this service.
    if (throttle.isBlocked(ip)) {
      const retryAfter = throttle.retryAfter(ip);
      log("warn", "login throttled", {
        ip,
        retry_after_s: retryAfter,
        endpoint: "settings-password",
      });
      res.set("Retry-After", String(retryAfter));
      res
        .status(429)
        .type("html")
        .set(SETTINGS_HEADERS)
        .send(
          renderPasswordChange({
            csrf: session.csrf,
            error: `Too many failed attempts. Try again in ${Math.ceil(retryAfter / 60)} minute(s).`,
          })
        );
      return;
    }

    const body = req.body as Record<string, unknown>;
    const currentPassword = typeof body.current_password === "string" ? body.current_password : "";
    const newPassword = typeof body.new_password === "string" ? body.new_password : "";
    const confirmPassword =
      typeof body.confirm_password === "string" ? body.confirm_password : "";

    // 3. The current password goes through the same throttle as a sign-in
    // failure: a wrong current password here is exactly that.
    const currentOk = await operator.verify(operator.username, currentPassword);
    if (!currentOk) {
      throttle.recordFailure(ip);
      // Fixed shape: the fail2ban filter in docs/HARDENING.md matches this line.
      log("warn", LOGIN_FAILURE_EVENT, { ip, endpoint: "settings-password" });
      res
        .status(401)
        .type("html")
        .set(SETTINGS_HEADERS)
        .send(renderPasswordChange({ csrf: session.csrf, error: "Incorrect current password." }));
      return;
    }

    // 4. A mismatched confirmation or a short password is a typo, not an
    // attack, so it costs nothing against the throttle.
    if (newPassword !== confirmPassword || newPassword.length < 12) {
      res
        .status(400)
        .type("html")
        .set(SETTINGS_HEADERS)
        .send(
          renderPasswordChange({
            csrf: session.csrf,
            error:
              "The new password and its confirmation must match, and be at least 12 characters.",
          })
        );
      return;
    }

    // 5. Bumps sessionEpoch, which invalidates the cookie carrying this very
    // request too — that is why the response below clears it explicitly rather
    // than relying on the operator noticing it stopped working.
    await operator.changePassword(newPassword);

    // 6. Disconnecting Claude clients is opt-in: a password change on its own
    // does not touch tokenEpoch, only the operator's own sessions.
    if (body.disconnect_clients === "1") {
      store.revokeEverything(revocationTimestamp());
    }

    // 7. Back to the sign-in form.
    res
      .status(303)
      .set(SETTINGS_HEADERS)
      .set("Set-Cookie", clearedSessionCookie())
      .set("Location", "/settings")
      .end();
  });

  return router;
}
