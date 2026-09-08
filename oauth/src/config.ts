/**
 * Configuration.
 *
 * Every secret can be supplied either directly (`NAME`) or as a path to a file
 * holding it (`NAME_FILE`). The file form is what the deployment uses: the target
 * host mounts Docker file-secrets under /run/secrets, matching how the other
 * applications there are configured, and it keeps credentials out of `docker
 * inspect` output and the process environment.
 *
 * Validation is strict and happens at startup. A service that sits in front of
 * live mailboxes should refuse to run misconfigured rather than discover it on
 * the first request — in particular, a missing signing key must never silently
 * become a generated one, or every restart would log the operator out and, worse,
 * make it impossible to tell a rotation from an attack.
 */

import { readFileSync } from "node:fs";
// POSIX explicitly: this service only ever runs in a Linux container (see the
// /data and /run/secrets paths below), so path math on those literals must stay
// forward-slashed even when a contributor runs the test suite on Windows.
import { dirname, join } from "node:path/posix";

import type { LogLevel } from "./logger.js";
import { isValidHashFormat } from "./passwords.js";
import {
  HOSTED_CLAUDE_REDIRECT_URIS,
  LOOPBACK_REDIRECT_URIS,
  canonicalResource,
  isTransportSafeRedirectUri,
  normalisePublicUrl,
} from "./urls.js";

export interface OAuthConfig {
  port: number;
  host: string;
  /** Issuer and public base URL, canonical, no trailing slash. */
  issuer: string;
  /** Path the MCP endpoint is served at, e.g. "/mcp". */
  mcpPath: string;
  /** Canonical resource identifier: issuer + mcpPath. */
  resource: string;
  /** Where to forward authenticated MCP traffic, e.g. http://mail-mcp:3220. */
  upstreamMcpUrl: string;
  /** The connector's static AUTH_TOKEN. Never leaves this process. */
  upstreamAuthToken: string;
  signingKey: Uint8Array;
  authUsername: string;
  authPasswordHash: string;
  stateFile: string | null;
  /**
   * Key for the assertion the settings proxy sends to the connector. Null turns
   * the settings UI off entirely: with no key there is nothing the connector
   * would accept, so the routes are not mounted at all.
   */
  settingsSigningKey: Uint8Array | null;
  /**
   * Where the live operator record lives. AUTH_PASSWORD_HASH seeds it once; after
   * that this file wins, because /run/secrets is mounted read-only and a password
   * change has to be able to write somewhere. `OPERATOR_FILE=none` keeps the old
   * behaviour — hash from the secret, password change disabled.
   */
  operatorFile: string | null;
  /**
   * Number of reverse-proxy hops in front of this service. Determines which
   * X-Forwarded-For entry becomes `req.ip`, and therefore which address the
   * login throttle buckets on and the fail2ban log line names.
   */
  trustProxy: number;
  accessTokenTtl: number;
  refreshTokenTtl: number;
  redirectAllowlist: string[];
  logLevel: LogLevel;
}

const LOG_LEVELS: LogLevel[] = ["debug", "info", "warn", "error"];

/** Minimum signing key length. 32 bytes matches the HS256 output size. */
const MIN_SIGNING_KEY_BYTES = 32;

export class ConfigError extends Error {}

type Env = Record<string, string | undefined>;

/**
 * Read a value that may be given inline or as a file path.
 *
 * `NAME_FILE` wins when both are set, and an unreadable `NAME_FILE` is an error
 * rather than a silent fallback to `NAME` — a typo in a secret mount should stop
 * the service, not quietly downgrade it to whatever was in the environment.
 */
function readSecret(env: Env, name: string): string | undefined {
  const filePath = env[`${name}_FILE`];
  if (filePath && filePath.trim() !== "") {
    try {
      return readFileSync(filePath.trim(), "utf8").trim();
    } catch (err) {
      throw new ConfigError(
        `Cannot read ${name}_FILE at ${filePath.trim()}: ` +
          (err instanceof Error ? err.message : String(err))
      );
    }
  }
  const inline = env[name];
  return inline && inline.trim() !== "" ? inline.trim() : undefined;
}

function required(env: Env, name: string): string {
  const value = readSecret(env, name);
  if (value === undefined) {
    throw new ConfigError(
      `Missing required configuration: ${name} (or ${name}_FILE). See oauth/.env.example.`
    );
  }
  return value;
}

function optional(env: Env, name: string, fallback: string): string {
  return readSecret(env, name) ?? fallback;
}

function integer(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ConfigError(`${name} must be a positive integer, got ${raw}.`);
  }
  return parsed;
}

function boolean(env: Env, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const normalised = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalised)) return true;
  if (["0", "false", "no", "off"].includes(normalised)) return false;
  throw new ConfigError(`${name} must be a boolean, got ${raw}.`);
}

export function loadConfig(env: Env = process.env): OAuthConfig {
  const publicUrlRaw = required(env, "PUBLIC_URL");
  let issuer: string;
  try {
    issuer = normalisePublicUrl(publicUrlRaw);
  } catch (err) {
    throw new ConfigError(
      `PUBLIC_URL must be an absolute http(s) URL without a fragment: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
  if (!issuer.startsWith("https://") && !issuer.startsWith("http://localhost")) {
    // Claude reaches this service over the public internet and OAuth 2.1 requires
    // HTTPS for every authorization server endpoint. Plain http is tolerated only
    // for a local development run.
    throw new ConfigError(
      `PUBLIC_URL must use https (got ${issuer}). TLS is terminated by the reverse proxy; ` +
        `set PUBLIC_URL to the public https URL, not the internal one.`
    );
  }

  const mcpPath = normaliseMcpPath(optional(env, "MCP_PATH", "/mcp"));
  const resource = canonicalResource(`${issuer}${mcpPath}`);

  const upstreamMcpUrl = optional(env, "UPSTREAM_MCP_URL", "http://mail-mcp:3220");
  try {
    const parsed = new URL(upstreamMcpUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("must be http or https");
    }
  } catch (err) {
    throw new ConfigError(
      `UPSTREAM_MCP_URL is not a usable URL (${upstreamMcpUrl}): ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }

  const signingKeyRaw = required(env, "SIGNING_KEY");
  const signingKey = new TextEncoder().encode(signingKeyRaw);
  if (signingKey.length < MIN_SIGNING_KEY_BYTES) {
    throw new ConfigError(
      `SIGNING_KEY must be at least ${MIN_SIGNING_KEY_BYTES} bytes; got ${signingKey.length}. ` +
        `Generate one with: openssl rand -base64 48`
    );
  }

  const authPasswordHash = required(env, "AUTH_PASSWORD_HASH");
  if (!isValidHashFormat(authPasswordHash)) {
    throw new ConfigError(
      "AUTH_PASSWORD_HASH is not a valid scrypt hash. Generate one with: npm run hash-password"
    );
  }

  const logLevelRaw = optional(env, "LOG_LEVEL", "info");
  if (!LOG_LEVELS.includes(logLevelRaw as LogLevel)) {
    throw new ConfigError(
      `LOG_LEVEL must be one of ${LOG_LEVELS.join(", ")}; got ${logLevelRaw}.`
    );
  }

  const stateFileRaw = optional(env, "STATE_FILE", "/data/oauth-state.json");
  const stateFile = stateFileRaw === "" || stateFileRaw === "none" ? null : stateFileRaw;

  const settingsKeyRaw = readSecret(env, "SETTINGS_SIGNING_KEY");
  let settingsSigningKey: Uint8Array | null = null;
  if (settingsKeyRaw !== undefined) {
    settingsSigningKey = new TextEncoder().encode(settingsKeyRaw);
    if (settingsSigningKey.length < MIN_SIGNING_KEY_BYTES) {
      throw new ConfigError(
        `SETTINGS_SIGNING_KEY must be at least ${MIN_SIGNING_KEY_BYTES} bytes; got ` +
          `${settingsSigningKey.length}. Generate one with: openssl rand -base64 48`
      );
    }
  }

  const operatorFileRaw = optional(
    env,
    "OPERATOR_FILE",
    stateFile === null ? "" : join(dirname(stateFile), "operator.json")
  );
  const operatorFile =
    operatorFileRaw === "" || operatorFileRaw === "none" ? null : operatorFileRaw;

  return {
    port: integer(env, "PORT", 8080),
    host: optional(env, "HOST", "0.0.0.0"),
    issuer,
    mcpPath,
    resource,
    upstreamMcpUrl: upstreamMcpUrl.replace(/\/+$/, ""),
    upstreamAuthToken: required(env, "UPSTREAM_AUTH_TOKEN"),
    signingKey,
    authUsername: optional(env, "AUTH_USERNAME", "operator"),
    authPasswordHash,
    stateFile,
    settingsSigningKey,
    operatorFile,
    trustProxy: trustProxyHops(env),
    accessTokenTtl: integer(env, "ACCESS_TOKEN_TTL", 3600),
    refreshTokenTtl: integer(env, "REFRESH_TOKEN_TTL", 30 * 24 * 3600),
    redirectAllowlist: buildRedirectAllowlist(env),
    logLevel: logLevelRaw as LogLevel,
  };
}

/**
 * The set of redirect URIs a client may register.
 *
 * Claude's two hosted callbacks are always present. Loopback support is off by
 * default: it exists for Claude Code, which does not need this service at all
 * (it can use the connector's static token directly), so enabling it would widen
 * the allowlist for a client that has a simpler path available.
 */
function buildRedirectAllowlist(env: Env): string[] {
  const allowlist: string[] = [...HOSTED_CLAUDE_REDIRECT_URIS];

  if (boolean(env, "ALLOW_LOOPBACK_REDIRECT", false)) {
    allowlist.push(...LOOPBACK_REDIRECT_URIS);
  }

  const extra = env.EXTRA_REDIRECT_URIS;
  if (extra && extra.trim() !== "") {
    for (const entry of extra.split(",").map((value) => value.trim())) {
      if (entry === "") continue;
      if (!isTransportSafeRedirectUri(entry)) {
        throw new ConfigError(
          `EXTRA_REDIRECT_URIS entry is not usable as a redirect URI: ${entry}. ` +
            `Every entry must use https, or http on a loopback address.`
        );
      }
      allowlist.push(entry);
    }
  }

  return allowlist;
}

/**
 * How many proxy hops to trust.
 *
 * Never a boolean. `trust proxy: true` trusts the entire X-Forwarded-For chain
 * and takes its leftmost entry, which the client writes — so a client could pick
 * its own `req.ip` and sidestep the login throttle one forged address at a time.
 * A hop count makes Express skip exactly the proxies that are really there.
 *
 * The default, 1, matches a single reverse proxy terminating TLS. Raise it only
 * if there is genuinely another trusted hop in front, such as a CDN: setting it
 * higher than the real chain reintroduces the same forgery.
 */
function trustProxyHops(env: Env): number {
  const raw = env.TRUST_PROXY;
  if (raw === undefined || raw.trim() === "") return 1;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new ConfigError(
      `TRUST_PROXY must be a non-negative integer — the number of reverse-proxy ` +
        `hops in front of this service — got ${raw}. Use 0 when nothing proxies it.`
    );
  }
  return parsed;
}

function normaliseMcpPath(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "" || trimmed === "/") return "";
  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withLeadingSlash.replace(/\/+$/, "");
}

/**
 * The path segment appended to /.well-known/oauth-protected-resource for the
 * path-suffixed variant Claude probes first. Empty when the MCP endpoint sits at
 * the origin root, in which case only the bare well-known path applies.
 */
export function wellKnownSuffix(mcpPath: string): string {
  return mcpPath;
}
