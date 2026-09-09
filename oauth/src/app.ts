/**
 * Express application factory.
 *
 * The whole request path lives here so tests exercise the real middleware chain
 * rather than a re-implementation of it — the same reason the connector's own
 * `src/app.ts` is split out from its entry point, and for the same failure it
 * prevents: a test suite that stays green after the auth check is deleted.
 *
 * Body parsing is per route, never global. `/token` is form-urlencoded and
 * `/register` is JSON — Anthropic's documentation calls this out explicitly, and
 * a single `express.json()` mount, which is what the connector uses, makes
 * `/token` return 415 or see an empty body. `/mcp` gets no parser at all: its
 * payload must reach the connector as bytes.
 */

import express, { type NextFunction, type Request, type Response } from "express";

import { ASSERTION_HEADER, signAssertion } from "./assertion.js";
import { type Bootstrap, parseSetupPath } from "./bootstrap.js";
import { registerClient } from "./clients.js";
import { CodeStore } from "./codes.js";
import type { OAuthConfig } from "./config.js";
import { silentLogger, LOGIN_FAILURE_EVENT, type Logger } from "./logger.js";
import {
  escapeHtml,
  isSameOrigin,
  renderErrorPage,
  renderLoginPage,
  signAuthorizationRequest,
  verifyAuthorizationRequest,
} from "./login.js";
import {
  MCP_SCOPE,
  authorizationServerMetadata,
  protectedResourceMetadata,
  wwwAuthenticate,
} from "./metadata.js";
import type { OperatorRecord } from "./operator.js";
import { constantTimeEquals, verifyPassword } from "./passwords.js";
import { CODE_CHALLENGE_METHOD, isValidCodeChallenge, verifyChallenge } from "./pkce.js";
import { createProxy } from "./proxy.js";
import { pageHeaders } from "./settings-pages.js";
import {
  createSettingsRouter,
  requireSession,
  sessionOf,
  type MailboxSummary,
} from "./settings-routes.js";
import { createSetupWizard } from "./setup-routes.js";
import { Store } from "./store.js";
import { LoginThrottle } from "./throttle.js";
import { TokenIssuer } from "./tokens.js";
import { redirectUriAllowed, sameResource } from "./urls.js";

export const SERVICE_NAME = "claude-mail-mcp-oauth";
export const VERSION = "0.6.3";

export interface CreateAppOptions {
  config: OAuthConfig;
  store: Store;
  log?: Logger;
  /**
   * The live operator credential. Required for the settings UI to mount: see
   * the settings-router block below. Absent in a configuration that has not
   * opted into the settings UI at all.
   */
  operator?: OperatorRecord;
  /**
   * The live bootstrap state. Absent means "bootstrapped", which is what every
   * caller that predates the claim-token gate wants and what the settings-only
   * tests still build.
   *
   * When it reports unbootstrapped this app answers `/health`, serves the setup
   * page to the holder of the claim token, 503s the MCP endpoint and 404s
   * everything else — see the gate below.
   */
  bootstrap?: Bootstrap;
  /** Overrides for tests; production uses the defaults. */
  codeStore?: CodeStore;
  throttle?: LoginThrottle;
  proxyTimeoutMs?: number;
}

export interface OAuthApp {
  app: express.Express;
  store: Store;
}

export function createApp(opts: CreateAppOptions): OAuthApp {
  const { config, store } = opts;
  const log: Logger = opts.log ?? silentLogger;
  const codes = opts.codeStore ?? new CodeStore();
  const throttle = opts.throttle ?? new LoginThrottle();

  const tokens = new TokenIssuer({
    issuer: config.issuer,
    signingKey: config.signingKey,
    accessTokenTtl: config.accessTokenTtl,
    refreshTokenTtl: config.refreshTokenTtl,
    store,
  });

  /**
   * CSP for the consent screen.
   *
   * `form-action` cannot be plain 'self' here. Submitting this form redirects to
   * the client's registered redirect_uri, and Chrome enforces form-action against
   * the *redirect target* as well as the action URL — so 'self' alone blocks the
   * hand-off to claude.ai and the flow dies on the last step with a console-only
   * error. The allowlist is the same one a redirect_uri is validated against at
   * registration, so this widens form-action to exactly the destinations the
   * authorization code could already legitimately be sent to, and nothing else.
   */
  const loginFormActions = [
    "'self'",
    ...new Set(
      config.redirectAllowlist
        .map((uri) => {
          try {
            return new URL(uri).origin;
          } catch {
            return null;
          }
        })
        .filter((origin): origin is string => origin !== null)
    ),
  ].join(" ");
  const loginCsp =
    `default-src 'none'; style-src 'unsafe-inline'; form-action ${loginFormActions}; ` +
    `frame-ancestors 'none'`;

  const metadataOptions = { issuer: config.issuer, resource: config.resource };
  const resourceMetadataUrl = `${config.issuer}/.well-known/oauth-protected-resource${config.mcpPath}`;

  const app = express();
  app.disable("x-powered-by");
  // A hop count, never `true`.
  //
  // `trust proxy: true` trusts the whole X-Forwarded-For chain and takes its
  // leftmost entry as req.ip — and that entry is supplied by the client. The
  // reverse proxy only *appends* the address it saw, so a client sending
  // `X-Forwarded-For: <anything>` chooses its own req.ip. That defeats the login
  // throttle outright, since every attempt lands in a different bucket, and it
  // writes an attacker-chosen address into the log line the fail2ban filter
  // reads.
  //
  // With a hop count, Express skips exactly that many trusted entries from the
  // socket outward, so req.ip is the address the outermost trusted proxy
  // actually observed. Default 1, for the single reverse proxy in front.
  app.set("trust proxy", config.trustProxy);

  const jsonBody = express.json({ limit: "64kb" });
  const formBody = express.urlencoded({ extended: false, limit: "64kb" });

  const mcpRoute = config.mcpPath === "" ? "/" : config.mcpPath;

  // ---- The claim-token gate ----------------------------------------------

  // First in the chain, ahead of every route, because an unclaimed instance must
  // not answer any of them. See bootstrap.ts for what "unclaimed" means and why
  // it is not simply "the secrets are missing".
  //
  //                    unbootstrapped        claimed
  //   /health          200                   200
  //   /setup/<token>   the wizard            404
  //   /setup/<other>   404                   404
  //   /mcp             503                   normal
  //   /settings/*      not mounted           normal
  //   everything else  404                   normal
  //
  // Two properties this table is built around. `/mcp` answers 503 rather than
  // 401: an instance with no credentials cannot reject anything meaningfully, and
  // a 401 would invite guessing against a service that has nothing to guess at.
  // And a wrong claim token gets the *same* 404 the claimed instance serves —
  // byte for byte, from the same responder — so scanning cannot tell an unclaimed
  // instance from a claimed one. A 401 here would announce "there is a token, and
  // this is not it".
  const bootstrap = opts.bootstrap;
  // Built once, and only for an instance that is actually unclaimed: the state
  // never goes back to unbootstrapped, so a process that started claimed has no
  // wizard to build and no progress file to read.
  const wizard =
    bootstrap !== undefined && !bootstrap.bootstrapped
      ? createSetupWizard({ config, log, notFound: sendNotFound })
      : null;
  if (bootstrap !== undefined) {
    app.use((req, res, next) => {
      // Read per request, not captured: complete() flips this in a live process
      // and the routes must open in the same breath.
      if (bootstrap.bootstrapped) {
        // `/setup/*` is not registered anywhere else, so it falls through to the
        // catch-all 404 below. Permanently: there is no route back into setup,
        // and starting over means deleting the data volume.
        next();
        return;
      }

      if (req.path === "/health") {
        next();
        return;
      }

      if (req.path === mcpRoute) {
        res.status(503).json({
          error: "not_configured",
          error_description: "This instance has not been set up yet.",
        });
        return;
      }

      const setup = parseSetupPath(req.path);
      if (setup !== null && wizard !== null && bootstrap.accepts(setup.token)) {
        // Past the token check, and only past it, the wizard routes on the rest
        // of the path — including its own POSTs, which is why the check is here
        // and the routing is there. An unknown sub-path under a valid token comes
        // back through `sendNotFound` below, so it is the same 404 a wrong token
        // gets, byte for byte.
        wizard.handle(req, res, setup).catch(next);
        return;
      }

      sendNotFound(req, res);
    });
  }

  // ---- Discovery ---------------------------------------------------------

  const sendProtectedResourceMetadata = (_req: Request, res: Response): void => {
    res.set("Cache-Control", "public, max-age=300");
    res.json(protectedResourceMetadata(metadataOptions));
  };

  // Both the bare path and the path-suffixed variant. Claude probes the suffixed
  // one first when the MCP endpoint has a path component, and falls back to the
  // bare one; serving both means neither probe order can miss.
  app.get("/.well-known/oauth-protected-resource", sendProtectedResourceMetadata);
  if (config.mcpPath !== "") {
    app.get(
      `/.well-known/oauth-protected-resource${config.mcpPath}`,
      sendProtectedResourceMetadata
    );
  }

  app.get("/.well-known/oauth-authorization-server", (_req, res) => {
    res.set("Cache-Control", "public, max-age=300");
    res.json(authorizationServerMetadata(metadataOptions));
  });

  // ---- Dynamic client registration --------------------------------------

  app.post("/register", jsonBody, (req, res) => {
    const result = registerClient(req.body, config.redirectAllowlist, store);
    if (!result.ok) {
      log("warn", "client registration rejected", {
        ip: req.ip,
        error: result.error,
      });
      res.status(400).json({
        error: result.error,
        error_description: result.error_description,
      });
      return;
    }
    log("info", "client registered", {
      client_id: result.client.client_id,
      client_name: result.client.client_name,
    });
    res.status(201).set("Cache-Control", "no-store").json(result.client);
  });

  // ---- Authorization -----------------------------------------------------

  app.get("/authorize", async (req, res) => {
    const params = req.query as Record<string, string | undefined>;

    const clientId = params.client_id;
    const redirectUri = params.redirect_uri;

    // Client identity and redirect URI are validated before anything else, and a
    // failure here renders an error page rather than redirecting. Redirecting an
    // error to an unvalidated URI is the open-redirect this ordering prevents.
    if (typeof clientId !== "string" || clientId === "") {
      respondWithErrorPage(res, 400, "Invalid request", "client_id is missing.");
      return;
    }
    const client = store.getClient(clientId);
    if (!client) {
      log("warn", "authorize for unknown client", { ip: req.ip, client_id: clientId });
      respondWithErrorPage(
        res,
        400,
        "Unknown client",
        "This client is not registered with this authorization server."
      );
      return;
    }
    if (typeof redirectUri !== "string" || redirectUri === "") {
      respondWithErrorPage(res, 400, "Invalid request", "redirect_uri is missing.");
      return;
    }
    if (
      !client.redirect_uris.includes(redirectUri) ||
      !redirectUriAllowed(redirectUri, config.redirectAllowlist)
    ) {
      log("warn", "authorize with unregistered redirect_uri", {
        ip: req.ip,
        client_id: clientId,
      });
      respondWithErrorPage(
        res,
        400,
        "Invalid redirect URI",
        "This redirect URI is not registered for this client."
      );
      return;
    }

    // Past this point the redirect URI is trusted, so errors go back to the client
    // as an OAuth error response per RFC 6749 section 4.1.2.1.
    const state = typeof params.state === "string" ? params.state : undefined;
    const fail = (error: string, description: string): void => {
      redirectWithError(res, redirectUri, error, description, state, config.issuer);
    };

    if (params.response_type !== "code") {
      fail("unsupported_response_type", "Only the authorization code flow is supported.");
      return;
    }
    if (params.code_challenge_method !== CODE_CHALLENGE_METHOD) {
      fail(
        "invalid_request",
        `code_challenge_method must be ${CODE_CHALLENGE_METHOD}.`
      );
      return;
    }
    if (
      typeof params.code_challenge !== "string" ||
      !isValidCodeChallenge(params.code_challenge)
    ) {
      fail("invalid_request", "A valid S256 code_challenge is required.");
      return;
    }

    // RFC 8707. Claude always sends this; an absent value defaults to this
    // service's own resource rather than failing, and a value naming a different
    // resource is refused because a token must never be minted for someone else.
    const requestedResource = params.resource;
    if (
      typeof requestedResource === "string" &&
      requestedResource !== "" &&
      !sameResource(requestedResource, config.resource)
    ) {
      log("warn", "authorize for a foreign resource", {
        ip: req.ip,
        client_id: clientId,
      });
      fail("invalid_target", "This authorization server does not protect that resource.");
      return;
    }

    const requestToken = await signAuthorizationRequest(
      {
        clientId,
        redirectUri,
        codeChallenge: params.code_challenge,
        scope: MCP_SCOPE,
        resource: config.resource,
        ...(state !== undefined ? { state } : {}),
        ...(client.client_name !== undefined ? { clientName: client.client_name } : {}),
      },
      config.signingKey,
      config.issuer
    );

    sendLoginPage(res, 200, {
      requestToken,
      redirectHost: hostOf(redirectUri),
      clientName: client.client_name,
    }, loginCsp);
  });

  app.post("/authorize", formBody, async (req, res) => {
    const ip = req.ip ?? "unknown";

    if (!isSameOrigin({ origin: req.get("origin"), referer: req.get("referer") }, config.issuer)) {
      log("warn", "authorize POST rejected by origin check", { ip });
      respondWithErrorPage(
        res,
        403,
        "Request blocked",
        "This form submission did not come from this site. Start again from the beginning."
      );
      return;
    }

    const body = req.body as Record<string, unknown>;
    const requestToken = typeof body.request === "string" ? body.request : "";
    const request = await verifyAuthorizationRequest(
      requestToken,
      config.signingKey,
      config.issuer
    );
    if (!request) {
      respondWithErrorPage(
        res,
        400,
        "Session expired",
        "This sign-in form is no longer valid. Start the connection again from Claude."
      );
      return;
    }

    if (throttle.isBlocked(ip)) {
      const retryAfter = throttle.retryAfter(ip);
      log("warn", "login throttled", { ip, retry_after_s: retryAfter });
      res.set("Retry-After", String(retryAfter));
      sendLoginPage(res, 429, {
        requestToken,
        redirectHost: hostOf(request.redirectUri),
        clientName: request.clientName,
        error: `Too many failed attempts. Try again in ${Math.ceil(retryAfter / 60)} minute(s).`,
      }, loginCsp);
      return;
    }

    const username = typeof body.username === "string" ? body.username : "";
    const password = typeof body.password === "string" ? body.password : "";

    if (!(await verifyOperator(username, password))) {
      const failures = throttle.recordFailure(ip);
      // Fixed shape: the fail2ban filter in docs/HARDENING.md matches this line.
      log("warn", LOGIN_FAILURE_EVENT, { ip, failures });
      sendLoginPage(res, 401, {
        requestToken,
        redirectHost: hostOf(request.redirectUri),
        clientName: request.clientName,
        error: "Incorrect username or password.",
      }, loginCsp);
      return;
    }

    throttle.recordSuccess(ip);
    log("info", "login succeeded", { ip, client_id: request.clientId });

    const code = codes.issue({
      clientId: request.clientId,
      redirectUri: request.redirectUri,
      codeChallenge: request.codeChallenge,
      scope: request.scope,
      resource: request.resource,
      sub: operatorUsername,
    });

    const target = new URL(request.redirectUri);
    target.searchParams.set("code", code);
    if (request.state !== undefined) target.searchParams.set("state", request.state);
    // RFC 9207: advertised in the metadata, so it must actually be sent.
    target.searchParams.set("iss", config.issuer);
    res.redirect(302, target.toString());
  });

  /**
   * The operator identity the consent screen authenticates against.
   *
   * The operator record when there is one, and the configured hash only when
   * there is not (`OPERATOR_FILE=none`). The record is the live credential — that
   * is the entire reason it exists, since `/run/secrets` is read-only and a
   * password change has to be able to write somewhere — but this route had kept
   * checking `AUTH_PASSWORD_HASH` directly, so a password changed in the settings
   * UI left the OAuth sign-in still accepting the old one. It has to be the
   * record now in any case: since the claim-token gate the hash may legitimately
   * be absent, and after the setup wizard there is nothing else to check against.
   *
   * Both halves always run, so a wrong username and a wrong password cost the
   * same and neither can be told from the other by timing or by the message.
   */
  const operatorUsername = opts.operator?.username ?? config.authUsername;
  async function verifyOperator(username: string, password: string): Promise<boolean> {
    if (opts.operator !== undefined) return opts.operator.verify(username, password);
    const nameOk = constantTimeEquals(username, config.authUsername);
    const hash = config.authPasswordHash;
    // No record and no hash: there is nothing to authenticate against. The gate
    // means this route is not reachable in that state at all; failing closed is
    // what keeps that true if it ever becomes reachable.
    const passwordOk = hash === null ? false : await verifyPassword(password, hash);
    return nameOk && passwordOk;
  }

  // ---- Token -------------------------------------------------------------

  app.post("/token", formBody, async (req, res) => {
    res.set("Cache-Control", "no-store");
    const body = (req.body ?? {}) as Record<string, unknown>;
    const grantType = body.grant_type;

    if (grantType === "authorization_code") {
      await handleAuthorizationCodeGrant(body, res);
      return;
    }
    if (grantType === "refresh_token") {
      await handleRefreshGrant(body, res);
      return;
    }
    tokenError(res, 400, "unsupported_grant_type", "Supported: authorization_code, refresh_token.");
  });

  async function handleAuthorizationCodeGrant(
    body: Record<string, unknown>,
    res: Response
  ): Promise<void> {
    const code = typeof body.code === "string" ? body.code : "";
    const verifier = typeof body.code_verifier === "string" ? body.code_verifier : "";
    const clientId = typeof body.client_id === "string" ? body.client_id : "";
    const redirectUri = typeof body.redirect_uri === "string" ? body.redirect_uri : "";

    if (code === "" || verifier === "") {
      tokenError(res, 400, "invalid_request", "code and code_verifier are required.");
      return;
    }

    const redeemed = codes.redeem(code);
    if (!redeemed) {
      tokenError(res, 400, "invalid_grant", "The authorization code is invalid or expired.");
      return;
    }
    // Everything below was fixed when the code was issued. Comparing against the
    // token request is what stops a client swapping any of it in between.
    if (clientId !== "" && clientId !== redeemed.clientId) {
      tokenError(res, 400, "invalid_grant", "The authorization code was issued to another client.");
      return;
    }
    if (redirectUri !== "" && redirectUri !== redeemed.redirectUri) {
      tokenError(res, 400, "invalid_grant", "redirect_uri does not match the authorization request.");
      return;
    }
    if (!verifyChallenge(verifier, redeemed.codeChallenge)) {
      log("warn", "PKCE verification failed", { client_id: redeemed.clientId });
      tokenError(res, 400, "invalid_grant", "PKCE verification failed.");
      return;
    }
    const requestedResource = body.resource;
    if (
      typeof requestedResource === "string" &&
      requestedResource !== "" &&
      !sameResource(requestedResource, redeemed.resource)
    ) {
      tokenError(res, 400, "invalid_target", "resource does not match the authorization request.");
      return;
    }

    const issued = await tokens.issue({
      sub: redeemed.sub,
      clientId: redeemed.clientId,
      scope: redeemed.scope,
      resource: redeemed.resource,
    });
    log("info", "issued tokens", { client_id: redeemed.clientId, grant: "authorization_code" });
    res.json(tokenResponse(issued));
  }

  async function handleRefreshGrant(
    body: Record<string, unknown>,
    res: Response
  ): Promise<void> {
    const refreshToken = typeof body.refresh_token === "string" ? body.refresh_token : "";
    if (refreshToken === "") {
      tokenError(res, 400, "invalid_request", "refresh_token is required.");
      return;
    }

    const rotated = await tokens.rotate(refreshToken);
    if (!rotated.ok) {
      if (rotated.reason === "reused") {
        log("error", "refresh token reuse detected, session revoked", {});
      }
      // Always invalid_grant, whatever went wrong. Anthropic's documentation is
      // specific that a refresh failure must use this code and not invalid_request
      // or something custom, or Claude does not recover by re-authorizing.
      tokenError(res, 400, "invalid_grant", "The refresh token is invalid or expired.");
      return;
    }
    log("info", "issued tokens", { grant: "refresh_token" });
    res.json(tokenResponse(rotated.tokens));
  }

  // ---- MCP proxy ---------------------------------------------------------

  const proxy = createProxy({
    upstreamUrl: config.upstreamMcpUrl,
    upstreamAuthToken: config.upstreamAuthToken,
    log,
    ...(opts.proxyTimeoutMs !== undefined ? { timeoutMs: opts.proxyTimeoutMs } : {}),
  });

  app.all(mcpRoute, async (req: Request, res: Response) => {
    const header = req.get("authorization") ?? "";
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match) {
      challenge(res, "invalid_token", "Authentication required.");
      return;
    }

    const verified = await tokens.verifyAccessToken(match[1], config.resource);
    if (!verified.ok) {
      log("warn", "rejected MCP request", { ip: req.ip, reason: verified.reason });
      challenge(res, "invalid_token", describeTokenFailure(verified.reason));
      return;
    }

    proxy(req, res);
  });

  function challenge(res: Response, error: string, description: string): void {
    // A 401 with this header is the entire protocol signal. A 200 carrying an
    // error body produces no auth prompt in Claude at all — it becomes a tool
    // error handed to the model, and the user never sees a Connect button.
    res
      .status(401)
      .set(
        "WWW-Authenticate",
        wwwAuthenticate({
          resourceMetadataUrl,
          error,
          errorDescription: description,
        })
      )
      .json({ error, error_description: description });
  }

  // ---- Health and fallthrough -------------------------------------------

  app.get("/health", (_req, res) => {
    // Deliberately says nothing about the connector behind it. The connector's own
    // /health discloses its version, how many mailboxes are configured and the path
    // to the credentials file, and it is not proxied.
    res.json({ status: "ok", service: SERVICE_NAME, version: VERSION });
  });

  // ---- Settings UI ---------------------------------------------------------

  // Mounted only when a settings signing key is configured and an operator
  // record is available. Without both there is nothing the connector would
  // accept for the mailbox pages, and a half-mounted UI that can list but not
  // reach them is worse than no UI.
  if (config.settingsSigningKey !== null && opts.operator) {
    const settingsDeps = {
      config,
      store,
      operator: opts.operator,
      throttle,
      log,
      upstreamHealth: () => fetchUpstreamHealth(config, log),
    };
    const settingsSigningKey = config.settingsSigningKey;

    app.use("/settings", createSettingsRouter(settingsDeps));

    // The mailbox management UI itself is served by the connector, not this
    // service — this is a pure proxy, the same shape as the /mcp one above, with
    // two differences: it authenticates the caller with the operator's session
    // cookie instead of a bearer token, and it replaces that cookie with a signed
    // assertion rather than a static secret, since the claim being made is "this
    // browser session, right now" rather than "any holder of this credential".
    //
    // Mounting requireSession directly ahead of the proxy handler — rather than
    // going through createSettingsRouter — is what guarantees an unauthenticated
    // request is answered locally (the sign-in form) and never reaches the
    // connector at all.
    //
    // Note what is deliberately absent here: unlike every state-changing route
    // in settings-routes.ts, there is no requireCsrf on this mount. That is not
    // an oversight. This route has no body parser and forwards the request body
    // to the connector as raw bytes (see proxy.ts's own header on why nothing
    // here may consume the stream), so this service cannot read a `_csrf` field
    // out of a form body without destroying exactly the byte-for-byte forwarding
    // the proxy exists to preserve. CSRF protection for these requests happens
    // one hop later: the assertion signed below carries this session's own
    // `csrf` claim, and the connector's own settings router verifies a
    // submitted `_csrf` field against it (constant-time) before acting on any
    // state-changing mailbox request. See spec section 3.3.
    const settingsUpstreamPath = (req: Request): string =>
      `/settings/mailboxes${req.path === "/" ? "" : req.path}`;

    const settingsProxy = createProxy({
      upstreamUrl: config.upstreamMcpUrl,
      upstreamAuthToken: config.upstreamAuthToken,
      upstreamPath: settingsUpstreamPath,
      extraHeaders: (req) => {
        const session = sessionOf(req);
        return {
          [ASSERTION_HEADER]: signAssertion(
            {
              sub: session.sub,
              sid: session.sid,
              csrf: session.csrf,
              method: req.method,
              path: settingsUpstreamPath(req),
            },
            settingsSigningKey,
            config.issuer
          ),
        };
      },
      log,
      ...(opts.proxyTimeoutMs !== undefined ? { timeoutMs: opts.proxyTimeoutMs } : {}),
    });

    app.use("/settings/mailboxes", requireSession(settingsDeps), (req, res) => {
      settingsProxy(req, res);
    });
  }

  app.use(sendNotFound);

  // Express 5 forwards async rejections here. Without it a thrown error in a
  // handler would hang the request until the client's own timeout.
  app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
    log("error", "unhandled request error", {
      path: req.path,
      error: err.message,
    });
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.status(500).json({ error: "server_error" });
  });

  return { app, store };
}

/**
 * The 404 every unmatched path gets.
 *
 * One function rather than one per site, because the claim-token gate depends on
 * its response being *identical* to the catch-all's: a wrong token on an
 * unclaimed instance and any unknown path on a claimed one must be
 * indistinguishable, down to the body. Two copies of this would drift and the
 * difference would be the oracle.
 */
function sendNotFound(req: Request, res: Response): void {
  res.status(404).json({
    error: "not_found",
    message: `${req.method} ${req.path} is not a valid endpoint.`,
  });
}

function tokenResponse(issued: {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  scope: string;
}): Record<string, unknown> {
  return {
    access_token: issued.accessToken,
    token_type: "Bearer",
    expires_in: issued.expiresIn,
    refresh_token: issued.refreshToken,
    scope: issued.scope,
  };
}

function tokenError(
  res: Response,
  status: number,
  error: string,
  description: string
): void {
  res.status(status).json({ error, error_description: description });
}

function respondWithErrorPage(
  res: Response,
  status: number,
  title: string,
  detail: string
): void {
  res.status(status).type("html").send(renderErrorPage(title, detail));
}

function sendLoginPage(
  res: Response,
  status: number,
  options: Parameters<typeof renderLoginPage>[0],
  csp: string
): void {
  res
    .status(status)
    .type("html")
    // The same set the settings pages and the wizard are served with, differing
    // only in the CSP the caller passes: the consent screen carries a request
    // token and takes a password, must not be cached anywhere, and has no reason
    // to be framed by anything. Written out inline here until #61 — which is how
    // this page, the one the operator actually types a password into, ended up
    // outside every guard covering the identical set next door.
    .set(pageHeaders(csp))
    .send(renderLoginPage(options));
}

function redirectWithError(
  res: Response,
  redirectUri: string,
  error: string,
  description: string,
  state: string | undefined,
  issuer: string
): void {
  const target = new URL(redirectUri);
  target.searchParams.set("error", error);
  target.searchParams.set("error_description", description);
  if (state !== undefined) target.searchParams.set("state", state);
  // RFC 9207 requires `iss` on error responses too, so a client can tell which
  // authorization server rejected it before acting on the error.
  target.searchParams.set("iss", issuer);
  res.redirect(302, target.toString());
}

function describeTokenFailure(reason: string): string {
  switch (reason) {
    case "expired_token":
      return "The access token has expired.";
    case "wrong_audience":
      return "The access token was not issued for this resource.";
    case "wrong_use":
      return "A refresh token cannot be used as a bearer credential.";
    case "revoked_session":
      return "The session this access token belongs to has been revoked.";
    default:
      return "The access token is invalid.";
  }
}

/**
 * Ask the connector how it is doing, for the settings overview.
 *
 * Never throws and never rejects: any failure — network error, timeout, a
 * non-2xx status, an unparseable body — comes back as `reachable: false`, so
 * the overview page says the connector is unreachable rather than the
 * settings request itself erroring. Bounded to 3 seconds so an operator
 * loading their own settings page is never left waiting on a connector that
 * is down.
 *
 * The connector's /health reports mailboxes as `accounts: [{ id, label,
 * default, ... }]` — note `default`, not `isDefault`; that field is renamed
 * here to match what settings-pages.ts renders.
 */
async function fetchUpstreamHealth(
  config: OAuthConfig,
  log: Logger
): Promise<{ reachable: boolean; version: string | null; mailboxes: MailboxSummary[] }> {
  try {
    const res = await fetch(`${config.upstreamMcpUrl}/health`, {
      signal: AbortSignal.timeout(3_000),
    });
    if (!res.ok) return { reachable: false, version: null, mailboxes: [] };

    const body = (await res.json()) as {
      version?: unknown;
      accounts?: Array<{ id?: unknown; label?: unknown; default?: unknown }>;
    };
    const mailboxes: MailboxSummary[] = Array.isArray(body.accounts)
      ? body.accounts
          .filter(
            (account): account is { id: string; label: string; default?: unknown } =>
              typeof account.id === "string" && typeof account.label === "string"
          )
          .map((account) => ({
            id: account.id,
            label: account.label,
            isDefault: account.default === true,
          }))
      : [];

    return {
      reachable: true,
      version: typeof body.version === "string" ? body.version : null,
      mailboxes,
    };
  } catch (err) {
    log("warn", "upstream health check failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return { reachable: false, version: null, mailboxes: [] };
  }
}

function hostOf(uri: string): string {
  try {
    return new URL(uri).host;
  } catch {
    return escapeHtml(uri);
  }
}
