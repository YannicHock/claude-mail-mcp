/**
 * Configuration.
 *
 * Every secret can be supplied either directly (`NAME`) or as a path to a file
 * holding it (`NAME_FILE`). The file form is what the deployment uses:
 * docker-compose.yml mounts ./secrets at /secrets in both services, which keeps
 * credentials out of `docker inspect` output and the process environment, and
 * gives the two services one file each to agree on.
 *
 * Every *secret* — and nothing else. A port, a path or a log level is plain
 * configuration, read from the environment and from nowhere else; see `plain()`
 * below. The `NAME_FILE` rule itself is stated once, in ./secrets.ts, and this
 * module reads secrets only through it.
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
  /**
   * The path `AUTH_PASSWORD_HASH_FILE` names, whether or not anything is there.
   *
   * Not a second copy of the secret and never read as one — `authPasswordHash`
   * above is the value. This is the *expectation*, kept so that the one place
   * that has to say a hash went missing can name the file it went missing from.
   * A vanished secrets mount is the failure mode bootstrap.ts refuses to boot on,
   * and "AUTH_PASSWORD_HASH is not set" is a much poorer thing to read in a
   * container log than the path the operator can go and look at.
   *
   * Optional, and absent when the hash was supplied inline or not at all.
   */
  authPasswordHashFile?: string | null;
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
   * Where the setup wizard remembers how far the operator has got. Next to the
   * claim token, on the same data volume and for the same reason: the operator
   * may be interrupted between screens, by a reload or by a container restart,
   * and must come back to the step they left rather than to the first one.
   *
   * It holds progress only — never a password, never a hash. Step 1 writes its
   * credential straight to the operator record, so there is nothing in this file
   * that would be worth reading. Null means the wizard keeps its progress in
   * memory for the life of the process, which is what a deployment with no data
   * volume gets.
   */
  wizardStateFile: string | null;
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
 * A plain configuration value, trimmed, or undefined when it is unset or blank.
 *
 * Reads the environment and nothing else. Routing these through a secret reader
 * is what gave every optional setting an accidental `_FILE` twin — `HOST_FILE`,
 * `STATE_FILE_FILE`, `MCP_PATH_FILE` and the rest were live, undocumented
 * variables nothing set and nothing meant. A path is not a secret, and has no
 * business being loadable from a secret file. Secrets go through
 * {@link resolveSecret} instead, which is where the `NAME_FILE` rule lives.
 */
function plain(env: Env, name: string): string | undefined {
  const value = env[name];
  return value !== undefined && value.trim() !== "" ? value.trim() : undefined;
}

function required(env: Env, name: string): string {
  const value = plain(env, name);
  if (value === undefined) {
    throw new ConfigError(`Missing required configuration: ${name}. See oauth/.env.example.`);
  }
  return value;
}

function optional(env: Env, name: string, fallback: string): string {
  return plain(env, name) ?? fallback;
}

/**
 * Resolve a secret through {@link resolveSecret} and record where it came from.
 *
 * The one reader of `NAME_FILE` this module has. What varies between secrets is
 * {@link ResolveOptions}, not the rule: by default an absent `NAME_FILE` is an
 * instruction to create it, `generate: false` makes it a misconfiguration, and
 * `generate: false, required: false` makes it a state the caller interprets.
 * Everything `optional()` reads is configuration rather than key material and
 * does not come through here at all.
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
  //
  // `required: false` is what says so. `generate: false` on its own treats an
  // absent `NAME_FILE` as a misconfiguration and throws, which is right for
  // every other never-generated secret and wrong for this one: every compose
  // file points AUTH_PASSWORD_HASH_FILE at a path in ./secrets that a first boot
  // has not written yet. A file that exists and cannot be *read* is still fatal.
  const authPasswordHash =
    trackedSecret(env, "AUTH_PASSWORD_HASH", secretReport, {
      generate: false,
      required: false,
    }) ?? null;
  // Deliberately read straight from the environment rather than out of the
  // resolver: what matters here is the path that was *configured*, which is
  // exactly the thing that survives the file going away.
  const authPasswordHashFileRaw = env.AUTH_PASSWORD_HASH_FILE?.trim();
  const authPasswordHashFile =
    authPasswordHashFileRaw === undefined || authPasswordHashFileRaw === ""
      ? null
      : authPasswordHashFileRaw;
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

  // Alongside both of those. The wizard's progress is worth no more than the
  // claim token it belongs to and is discarded with it, but it has to outlive a
  // reload and a restart or the operator starts over at step 1 every time.
  const wizardStateFileRaw = optional(
    env,
    "WIZARD_STATE_FILE",
    stateFile === null ? "" : join(dirname(stateFile), "setup-wizard.json")
  );
  const wizardStateFile =
    wizardStateFileRaw === "" || wizardStateFileRaw === "none" ? null : wizardStateFileRaw;

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
    authPasswordHashFile,
    stateFile,
    settingsSigningKey,
    operatorFile,
    claimTokenFile,
    wizardStateFile,
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
