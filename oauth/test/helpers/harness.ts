/**
 * Integration test harness.
 *
 * Builds the real app — the same {@link createApp} the entry point uses, with the
 * real middleware chain — in front of a stub upstream that records exactly what it
 * was sent. That recording is the point: it is how the tests prove the connector's
 * static token reaches the upstream and appears in nothing the client can see.
 *
 * The port is discovered before the config is built, because the issuer has to be
 * the address the server actually answers on. A plain `listen(0)` after app
 * creation would not do: the issuer is baked into the metadata documents, the JWT
 * `iss` and `aud` claims, and the origin check.
 */

import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Express } from "express";

import { createApp } from "../../src/app.js";
import type { OAuthConfig } from "../../src/config.js";
import { silentLogger, type Logger } from "../../src/logger.js";
import { OperatorRecord } from "../../src/operator.js";
import { hashPassword } from "../../src/passwords.js";
import { SESSION_COOKIE } from "../../src/session.js";
import { Store } from "../../src/store.js";
import { LoginThrottle } from "../../src/throttle.js";
import { HOSTED_CLAUDE_REDIRECT_URIS } from "../../src/urls.js";

export const TEST_USERNAME = "operator";
export const TEST_PASSWORD = "correct horse battery staple";
export const UPSTREAM_TOKEN = "upstream-secret-token-do-not-leak";
export const CLAUDE_CALLBACK = "https://claude.ai/api/mcp/auth_callback";

/** Cheap scrypt parameters — the algorithm path is identical, only slower. */
const FAST_SCRYPT = { N: 1024, r: 8, p: 1 } as const;

export interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export interface UpstreamStub {
  requests: RecordedRequest[];
  /** Replace the responder. Defaults to a JSON-RPC style 200. */
  respondWith(
    handler: (req: IncomingMessage, res: ServerResponse, body: string) => void
  ): void;
  url: string;
}

export interface Harness {
  /** Base URL the app answers on; equals the issuer. */
  baseUrl: string;
  config: OAuthConfig;
  store: Store;
  operator: OperatorRecord;
  throttle: LoginThrottle;
  upstream: UpstreamStub;
  /** Sign in as the test operator and return the session cookie's value. */
  signIn(): Promise<string>;
  close(): Promise<void>;
}

export interface HarnessOptions {
  log?: Logger;
  configOverrides?: Partial<OAuthConfig>;
  throttle?: LoginThrottle;
  /**
   * Backing file for the operator record. Omitted by default so most tests
   * build an in-memory record and never touch the filesystem — only the tests
   * that need `changePassword` or a persisted `bumpSessionEpoch` pass one.
   */
  operatorPath?: string;
}

export async function startHarness(opts: HarnessOptions = {}): Promise<Harness> {
  const upstream = await startUpstreamStub();

  let app: Express | null = null;
  const server = createServer((req, res) => {
    if (app === null) {
      res.statusCode = 503;
      res.end();
      return;
    }
    app(req, res);
  });
  await listen(server, "127.0.0.1");
  const port = (server.address() as AddressInfo).port;
  // "localhost" rather than "127.0.0.1": loadConfig only tolerates plain http for
  // a local run, and the same string has to serve as issuer, audience and origin.
  const issuer = `http://localhost:${port}`;

  const authPasswordHash = await hashPassword(TEST_PASSWORD, FAST_SCRYPT);

  const config: OAuthConfig = {
    port,
    host: "127.0.0.1",
    issuer,
    mcpPath: "/mcp",
    resource: `${issuer}/mcp`,
    upstreamMcpUrl: upstream.url,
    upstreamAuthToken: UPSTREAM_TOKEN,
    signingKey: new TextEncoder().encode("test-signing-key-at-least-32-bytes-long"),
    authUsername: TEST_USERNAME,
    authPasswordHash,
    stateFile: null,
    settingsSigningKey: new TextEncoder().encode(
      "test-settings-signing-key-at-least-32-bytes-long"
    ),
    operatorFile: null,
    trustProxy: 1,
    accessTokenTtl: 3600,
    refreshTokenTtl: 2592000,
    redirectAllowlist: [...HOSTED_CLAUDE_REDIRECT_URIS],
    logLevel: "error",
    ...opts.configOverrides,
  };

  const log = opts.log ?? silentLogger;
  const store = await Store.open(null, silentLogger);
  const throttle = opts.throttle ?? new LoginThrottle();
  const operator = await OperatorRecord.open(
    opts.operatorPath ?? null,
    { username: TEST_USERNAME, passwordHash: authPasswordHash },
    log
  );
  ({ app } = createApp({
    config,
    store,
    operator,
    log,
    throttle,
    proxyTimeoutMs: 5_000,
  }));

  return {
    baseUrl: issuer,
    config,
    store,
    operator,
    throttle,
    upstream,
    async signIn(): Promise<string> {
      const res = await fetch(`${issuer}/settings/login`, {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: issuer },
        body: new URLSearchParams({ username: TEST_USERNAME, password: TEST_PASSWORD }),
      });
      const setCookie = res.headers.get("set-cookie") ?? "";
      const match = new RegExp(`^${SESSION_COOKIE}=([^;]+)`).exec(setCookie);
      if (!match) {
        throw new Error(`signIn: no session cookie in the response (status ${res.status})`);
      }
      return match[1];
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await upstream.close();
      await store.close();
    },
  };
}

interface ClosableUpstream extends UpstreamStub {
  close(): Promise<void>;
}

async function startUpstreamStub(): Promise<ClosableUpstream> {
  const requests: RecordedRequest[] = [];
  let handler: (req: IncomingMessage, res: ServerResponse, body: string) => void = (
    _req,
    res
  ) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { tools: [{ name: "list_accounts" }] },
      })
    );
  };

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      requests.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body,
      });
      handler(req, res, body);
    });
  });
  await listen(server, "127.0.0.1");
  const port = (server.address() as AddressInfo).port;

  return {
    requests,
    url: `http://127.0.0.1:${port}`,
    respondWith(next) {
      handler = next;
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function listen(server: Server, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
}

// ---- Flow helpers ---------------------------------------------------------

/** PKCE pair, generated the way a spec-compliant client would. */
export function makePkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");
  return { verifier, challenge };
}

/** Register a client the way Claude's hosted surfaces do. */
export async function registerClaudeClient(
  baseUrl: string,
  overrides: Record<string, unknown> = {}
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Claude",
      redirect_uris: [CLAUDE_CALLBACK],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      ...overrides,
    }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** Pull the hidden request token out of the rendered sign-in form. */
export function extractRequestToken(html: string): string | null {
  const match = /name="request" value="([^"]+)"/.exec(html);
  return match ? match[1] : null;
}

/**
 * Drive the whole flow the way Claude does, up to and including the token
 * exchange. Returns the token endpoint's response.
 */
export async function completeAuthorizationFlow(
  harness: Harness,
  options: {
    username?: string;
    password?: string;
    resource?: string;
  } = {}
): Promise<{
  status: number;
  body: Record<string, unknown>;
  clientId: string;
}> {
  const { baseUrl } = harness;
  const registration = await registerClaudeClient(baseUrl);
  const clientId = registration.body.client_id as string;
  const { verifier, challenge } = makePkce();
  const resource = options.resource ?? harness.config.resource;

  const authorizeUrl = new URL(`${baseUrl}/authorize`);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("redirect_uri", CLAUDE_CALLBACK);
  authorizeUrl.searchParams.set("code_challenge", challenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  authorizeUrl.searchParams.set("state", "opaque-state");
  authorizeUrl.searchParams.set("resource", resource);

  const form = await fetch(authorizeUrl, { redirect: "manual" });
  const requestToken = extractRequestToken(await form.text());
  if (requestToken === null) throw new Error("no request token in sign-in form");

  const login = await fetch(`${baseUrl}/authorize`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: baseUrl,
    },
    body: new URLSearchParams({
      request: requestToken,
      username: options.username ?? TEST_USERNAME,
      password: options.password ?? TEST_PASSWORD,
    }),
  });

  const location = login.headers.get("location");
  if (location === null) {
    throw new Error(`login did not redirect (status ${login.status})`);
  }
  const code = new URL(location).searchParams.get("code");
  if (code === null) throw new Error(`no code in redirect: ${location}`);

  const token = await fetch(`${baseUrl}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: CLAUDE_CALLBACK,
      resource,
    }),
  });

  return {
    status: token.status,
    body: (await token.json()) as Record<string, unknown>,
    clientId,
  };
}

// ---- Settings UI helpers ---------------------------------------------------

/**
 * Which of `Origin` and `Referer` a form POST arrives with.
 *
 * `fetch` always sets `Origin`, which is convenient and is what every caller
 * here wants by default — but it is not what a browser does. Chrome sends no
 * `Origin` on a *same-origin* form POST, only `Referer`, and that combination
 * is what the origin check has to survive. Pass this to drive the other rows
 * of that matrix; omit it and the request is same-origin via `Origin`, exactly
 * as before.
 */
export interface SubmissionOptions {
  /** Replaces the default `{ origin: baseUrl }` wholesale. */
  headers?: Record<string, string>;
}

/** POST to /settings/login with the given credentials, same-origin by default. */
export async function signInWith(
  harness: Harness,
  username: string,
  password: string,
  options: SubmissionOptions = {}
): Promise<Response> {
  return fetch(`${harness.baseUrl}/settings/login`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(options.headers ?? { origin: harness.baseUrl }),
    },
    body: new URLSearchParams({ username, password }),
  });
}

/** GET /settings with the given session cookie, if any. */
export async function getSettings(harness: Harness, cookie?: string): Promise<Response> {
  return fetch(`${harness.baseUrl}/settings`, {
    redirect: "manual",
    headers: cookie ? { cookie: `${SESSION_COOKIE}=${cookie}` } : {},
  });
}

/**
 * Drive the OAuth sign-in form POST, the way completeAuthorizationFlow does.
 *
 * Same-origin via `Origin` unless {@link SubmissionOptions} says otherwise.
 */
export async function postAuthorizeForm(
  harness: Harness,
  username: string,
  password: string,
  options: SubmissionOptions = {}
): Promise<Response> {
  const { baseUrl } = harness;
  const registration = await registerClaudeClient(baseUrl);
  const clientId = registration.body.client_id as string;
  const { challenge } = makePkce();

  const authorizeUrl = new URL(`${baseUrl}/authorize`);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("redirect_uri", CLAUDE_CALLBACK);
  authorizeUrl.searchParams.set("code_challenge", challenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");

  const form = await fetch(authorizeUrl, { redirect: "manual" });
  const requestToken = extractRequestToken(await form.text());
  if (requestToken === null) throw new Error("no request token in sign-in form");

  return fetch(`${baseUrl}/authorize`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...(options.headers ?? { Origin: baseUrl }),
    },
    body: new URLSearchParams({ request: requestToken, username, password }),
  });
}

/**
 * GET /authorize the way a client starts the flow, and hand back the response
 * so a test can read both the rendered form and the headers it was served with.
 */
export async function getAuthorizePage(harness: Harness): Promise<Response> {
  const registration = await registerClaudeClient(harness.baseUrl);
  const { challenge } = makePkce();

  const url = new URL(`${harness.baseUrl}/authorize`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", registration.body.client_id as string);
  url.searchParams.set("redirect_uri", CLAUDE_CALLBACK);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");

  return fetch(url, { redirect: "manual" });
}

/** Pull the CSRF token out of a rendered settings page. */
export function extractCsrf(html: string): string {
  return /name="_csrf" value="([^"]+)"/.exec(html)?.[1] ?? "";
}

/** GET /settings/clients with the given session cookie. */
export async function getClients(harness: Harness, cookie?: string): Promise<Response> {
  return fetch(`${harness.baseUrl}/settings/clients`, {
    redirect: "manual",
    headers: cookie ? { cookie: `${SESSION_COOKIE}=${cookie}` } : {},
  });
}

/** POST a form-urlencoded body to a /settings/* path, authenticated with the given session cookie. */
export async function postForm(
  harness: Harness,
  path: string,
  cookie: string,
  fields: Record<string, string>
): Promise<Response> {
  return fetch(`${harness.baseUrl}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: harness.baseUrl,
      cookie: `${SESSION_COOKIE}=${cookie}`,
    },
    body: new URLSearchParams(fields),
  });
}

/** Redeem a refresh token at /token, the way Claude does to keep a connection alive. */
export async function postTokenRefresh(
  harness: Harness,
  refreshToken: string,
  clientId: string
): Promise<Response> {
  return fetch(`${harness.baseUrl}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
    }),
  });
}
