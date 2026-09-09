/**
 * Configuration.
 *
 * Every secret can be supplied either directly (`NAME`) or as a path to a file
 * holding it (`NAME_FILE`). The file form is what the deployment uses:
 * docker-compose.yml mounts ./secrets at /secrets in both services, which keeps
 * credentials out of `docker inspect` output and the process environment, and
 * gives the two services one file each to agree on.
 *
 * Validation is strict and happens at startup. A service that sits in front of
 * live mailboxes should refuse to run misconfigured rather than discover it on
 * the first request.
 *
 * The three random secrets — the connector's auth token, the token signing key
 * and the settings signing key — generate themselves when `NAME_FILE` names a
 * path that does not exist yet; see ./secrets.ts for the precedence rule and why
 * a present file must always win. Generation writes the value to that path, so a
 * restart reads back what the first boot produced: nothing here is regenerated
 * per process, and a rotation stays distinguishable from an attack in the logs.
 * `AUTH_PASSWORD_HASH` is never generated.
 */

import { readFileSync } from "node:fs";
// POSIX explicitly: this service only ever runs in a Linux container (see the
// /data and /secrets paths below), so path math on those literals must stay
// forward-slashed even when a contributor runs the test suite on Windows.
import { dirname, join } from "node:path/posix";

import type { LogLevel } from "./logger.js";
import { isValidHashFormat } from "./passwords.js";
import {
  SecretError,
  resolveSecret,
  type ResolveOptions,
  type ResolvedSecret,
  type SecretReportEntry,
} from "./secrets.js";
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
  /**
   * The operator's password hash, or null when none was supplied.
   *
   * Optional since the claim-token gate: an instance with no hash *and* no
   * operator record is an unbootstrapped one, which is a state this service now
   * starts in deliberately rather than refusing to boot from. It is still never
   * generated — it is the one secret with a meaning outside the deployment — and
   * a hash that is present but malformed is still fatal.
   *
   * Null does not mean "no password". Once the operator record exists it is the
   * live credential and this is ignored; see operator.ts.
   */
  authPasswordHash: string | null;
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
   * Where the one-time claim token lives while this instance is unbootstrapped.
   * Sits on the same data volume as the operator record, because the two have to
   * disappear and appear together. Null disables the gate's ability to mint a
   * token at all, which is only sensible when there is nothing to gate.
   */
  claimTokenFile: string | null;
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
  /**
   * Where each configured secret came from — read, seeded or generated. Logged
   * once at startup by index.ts; `loadConfig` runs before the logger exists,
   * because the log level is part of what it loads.
   */
  secretReport: SecretReportEntry[];
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

/**
 * Resolve a secret through {@link resolveSecret} and record where it came from.
 *
 * Unlike {@link readSecret} above, an absent `NAME_FILE` here is an instruction
 * to create it rather than an error. Only the three random secrets go through
 * this; everything else `optional()` reads is configuration, not key material,
 * and has nothing meaningful to generate.
 */
function trackedSecret(
  env: Env,
  name: string,
  report: SecretReportEntry[],
  options?: ResolveOptions
): string | undefined {
  let resolved: ResolvedSecret;
  try {
    resolved = resolveSecret(env, name, options);
  } catch (err) {
    // Surface as the operator-facing single line index.ts prints, not a stack.
    throw err instanceof SecretError ? new ConfigError(err.message) : err;
  }
  if (resolved.source !== undefined) {
    report.push({ name, source: resolved.source, path: resolved.path });
  }
  return resolved.value;
}

function requiredSecret(
  env: Env,
  name: string,
  report: SecretReportEntry[],
  options?: ResolveOptions
): string {
  const value = trackedSecret(env, name, report, options);
  if (value === undefined) {
    throw new ConfigError(
      `Missing required configuration: ${name} (or ${name}_FILE). See oauth/.env.example.`
    );
  }
  return value;
}

/**
 * Read a secret that is allowed to be missing entirely.
 *
 * Deliberately not {@link trackedSecret} with `generate: false`: that treats an
 * absent `NAME_FILE` as a misconfiguration and throws, which is exactly right for
 * every caller it has and exactly wrong for `AUTH_PASSWORD_HASH` now that a
 * missing hash is a legitimate state rather than a mistake. Every deployment's
 * compose file points `AUTH_PASSWORD_HASH_FILE` at a path in `./secrets`, so on a
 * first boot the file simply is not there yet.
 *
 * Only ENOENT is tolerated. A `NAME_FILE` that exists but cannot be read stays
 * fatal, as it has always been — a permission error on a secret mount must stop
 * the service, not silently downgrade the instance to unclaimed.
 */
function absentableSecret(
  env: Env,
  name: string,
  report: SecretReportEntry[]
): string | null {
  const path = env[`${name}_FILE`]?.trim();
  const inline = env[name]?.trim();

  if (path !== undefined && path !== "") {
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new ConfigError(
          `Cannot read ${name}_FILE at ${path}: ` +
            (err instanceof Error ? err.message : String(err))
        );
      }
      if (inline === undefined || inline === "") return null;
      report.push({ name, source: "environment", path: null });
      return inline;
    }
    const value = raw.trim();
    if (value === "") return null;
    report.push({ name, source: "file", path });
    return value;
  }

  if (inline === undefined || inline === "") return null;
  report.push({ name, source: "environment", path: null });
  return inline;
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
  const secretReport: SecretReportEntry[] = [];
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

  const upstreamAuthToken = requiredSecret(env, "UPSTREAM_AUTH_TOKEN", secretReport);

  const signingKeyRaw = requiredSecret(env, "SIGNING_KEY", secretReport);
  const signingKey = new TextEncoder().encode(signingKeyRaw);
  if (signingKey.length < MIN_SIGNING_KEY_BYTES) {
    throw new ConfigError(
      `SIGNING_KEY must be at least ${MIN_SIGNING_KEY_BYTES} bytes; got ${signingKey.length}. ` +
        `Generate one with: openssl rand -base64 48`
    );
  }

  // Never generated: it is the one secret with a meaning outside this
  // deployment, and the wizard sets it through OperatorRecord instead. Absent is
  // allowed and means "nobody has configured this instance yet" — see
  // bootstrap.ts. Present but malformed stays fatal: that is a typo, not a state.
  const authPasswordHash = absentableSecret(env, "AUTH_PASSWORD_HASH", secretReport);
  if (authPasswordHash !== null && !isValidHashFormat(authPasswordHash)) {
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

  const settingsKeyRaw = trackedSecret(env, "SETTINGS_SIGNING_KEY", secretReport);
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

  // Next to the operator record, on the same volume: the token exists exactly
  // while the record does not, and a deployment that persists one but not the
  // other could neither remember a claim nor resume an interrupted one.
  const claimTokenFileRaw = optional(
    env,
    "CLAIM_TOKEN_FILE",
    stateFile === null ? "" : join(dirname(stateFile), "claim-token.txt")
  );
  const claimTokenFile =
    claimTokenFileRaw === "" || claimTokenFileRaw === "none" ? null : claimTokenFileRaw;

  return {
    port: integer(env, "PORT", 8080),
    host: optional(env, "HOST", "0.0.0.0"),
    issuer,
    mcpPath,
    resource,
    upstreamMcpUrl: upstreamMcpUrl.replace(/\/+$/, ""),
    upstreamAuthToken,
    signingKey,
    authUsername: optional(env, "AUTH_USERNAME", "operator"),
    authPasswordHash,
    stateFile,
    settingsSigningKey,
    operatorFile,
    claimTokenFile,
    trustProxy: trustProxyHops(env),
    accessTokenTtl: integer(env, "ACCESS_TOKEN_TTL", 3600),
    refreshTokenTtl: integer(env, "REFRESH_TOKEN_TTL", 30 * 24 * 3600),
    redirectAllowlist: buildRedirectAllowlist(env),
    logLevel: logLevelRaw as LogLevel,
    secretReport,
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
