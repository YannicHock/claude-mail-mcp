/**
 * Environment configuration loader.
 *
 * In v0.2, only transport-level settings live here (port, auth token,
 * accounts file path, log level). Mailbox credentials moved to
 * accounts.json — see src/accounts.ts and README.md.
 *
 * Every secret can be supplied inline (`NAME`) or as a path to a file holding it
 * (`NAME_FILE`). A present file always wins; an absent one is created. That rule
 * and its consequences live in src/secrets.ts.
 */

import {
  resolveSecret,
  type ResolveOptions,
  type SecretReportEntry,
} from "./secrets.js";

/**
 * Where each configured secret came from — read from its file, taken from the
 * environment, or generated on this boot. Logged one line per secret by
 * src/index.ts; this module is evaluated at import time, before any logger
 * exists, so it collects rather than prints.
 */
const secretReport: SecretReportEntry[] = [];

/**
 * Resolve a secret and record its source.
 *
 * `NAME_FILE` wins when both are set, an absent one is an instruction to create
 * the file, and a `NAME_FILE` that is there but unreadable stays fatal — see
 * src/secrets.ts for the whole rule. Values are trimmed on both paths, because
 * SETTINGS_SIGNING_KEY has to come out byte-identical here and in the OAuth
 * layer for the assertion's HMAC to verify, and a trailing newline pasted from
 * `openssl rand -base64 48` must not survive on one side but not the other.
 *
 * Only key material goes through this. `optional()` still reads plain
 * configuration such as ACCOUNTS_FILE, PUBLIC_URL, HOST and LOG_LEVEL, which
 * deliberately preserve incidental whitespace as-is.
 */
function trackedSecret(name: string, options?: ResolveOptions): string | undefined {
  const resolved = resolveSecret(process.env, name, options);
  if (resolved.source !== undefined) {
    secretReport.push({ name, source: resolved.source, path: resolved.path });
  }
  return resolved.value;
}

function requiredSecret(name: string, options?: ResolveOptions): string {
  const value = trackedSecret(name, options);
  if (value === undefined) {
    throw new Error(
      `Missing required environment variable: ${name} (or ${name}_FILE). See .env.example.`
    );
  }
  return value;
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() !== "" ? value : fallback;
}

function int(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Environment variable ${name} must be an integer.`);
  }
  return parsed;
}

/**
 * How many reverse-proxy hops sit in front of this process — the value Express
 * takes as `trust proxy`, and therefore what decides which `X-Forwarded-For`
 * entry becomes `req.ip`.
 *
 * **Never a boolean.** `trust proxy: true` trusts the entire X-Forwarded-For
 * chain and takes its leftmost entry, and a reverse proxy only *appends* the
 * address it saw — so the leftmost entry is whatever the client wrote. This
 * connector has no login throttle for a forged address to sidestep, but `req.ip`
 * is what its two rejection log lines carry (`rejected unauthenticated MCP
 * request` in src/app.ts, `rejected settings request` in
 * src/settings-assertion.ts), and the obvious use for those is a fail2ban jail.
 * A jail reading a client-chosen field bans whatever the attacker names. A hop
 * count makes Express skip exactly the proxies that are really there.
 *
 * The default, 1, matches a single reverse proxy terminating TLS — the shape
 * every documented deployment has, including the one where the OAuth layer sits
 * in between, since its proxy forwards `X-Forwarded-For` unchanged rather than
 * appending to it (see `HOP_BY_HOP` in oauth/src/proxy.ts). Raise it only if
 * there is genuinely another trusted hop in front, such as a CDN: setting it
 * higher than the real chain reintroduces the same forgery. Use 0 when nothing
 * proxies this process, which makes `req.ip` the socket address.
 *
 * Its own variable rather than one shared with the OAuth layer's `TRUST_PROXY`
 * constant: the name is the same because the meaning is the same, and the two
 * processes never read one environment — docker-compose.yml gives them `.env`
 * and `.env.oauth`, and the pm2/systemd recipes give each its own env file — so
 * a deployment that puts a different number of proxies in front of each can say
 * so.
 *
 * Exported for the test suite. `config` below is evaluated once at import time,
 * so every rejection case would otherwise need a process of its own — see the
 * header of test/unit/config.defaults.test.ts for why the env constellations
 * are split across files. The parser is pure and can be exercised directly.
 */
export function trustProxyHops(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.TRUST_PROXY;
  if (raw === undefined || raw.trim() === "") return 1;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(
      `TRUST_PROXY must be a non-negative integer — the number of reverse-proxy ` +
        `hops in front of this service — got ${raw}. Use 0 when nothing proxies it.`
    );
  }
  return parsed;
}

export const config = {
  port: int("PORT", 3220),
  /**
   * Interface to bind. Default 127.0.0.1 (loopback only) — the public
   * hostname is terminated by nginx/Caddy upstream. Set to 0.0.0.0 only
   * if you really want the process directly internet-reachable, in which
   * case you're on your own re. TLS, rate-limiting, etc.
   */
  host: optional("HOST", "127.0.0.1"),

  /**
   * Reverse-proxy hops in front of this process, handed to Express as
   * `trust proxy` by src/app.ts. Default 1, never a boolean — see
   * {@link trustProxyHops} for what a boolean would cost.
   */
  trustProxy: trustProxyHops(),

  logLevel: optional("LOG_LEVEL", "info") as
    | "debug"
    | "info"
    | "warn"
    | "error",

  /**
   * Path to the multi-account credentials file (see src/accounts.ts). Created
   * by hand — no setup UI ships with this repository.
   *
   * Every documented deployment sets this explicitly: .env.example points at
   * /var/lib/mail-mcp/accounts.json for the systemd path, and the Dockerfile
   * and docker-compose.yml both pin /data/accounts.json for the container.
   * The fallback below is only reached by running the binary with neither, and
   * is kept for backwards compatibility with pre-0.2.1 installs; prefer to set
   * ACCOUNTS_FILE. See docs/DEPLOYMENT.md.
   */
  accountsFile: optional(
    "ACCOUNTS_FILE",
    "/root/.config/mail-mcp/accounts.json"
  ),

  /**
   * Bearer token a client must present in the Authorization header when
   * calling /mcp — the only thing gating that endpoint.
   *
   * Set `AUTH_TOKEN_FILE` and the token is read from that file, or generated
   * into it on the first boot that finds it absent — the same file the OAuth
   * layer reads as its `UPSTREAM_AUTH_TOKEN`. With neither `AUTH_TOKEN` nor
   * `AUTH_TOKEN_FILE` the process still refuses to start: there is no path to
   * write a generated token to, and a token only this process knows would gate
   * nothing anyone could get through.
   */
  authToken: requiredSecret("AUTH_TOKEN"),
  // Trimmed and stripped of a trailing slash so this matches the OAuth layer's
  // own normalisation of the same URL (see normalisePublicUrl() in
  // oauth/src/urls.ts). The two values are compared as the assertion's `iss`
  // on every settings request; a difference as small as a trailing slash
  // makes that comparison fail silently and permanently.
  publicUrl: optional("PUBLIC_URL", "http://localhost:3220").trim().replace(/\/+$/, ""),

  /**
   * Shared key for the settings assertion the OAuth layer sends with proxied
   * /settings requests. Empty means the settings routes are not mounted and this
   * process behaves exactly as it did before they existed.
   *
   * Generated into `SETTINGS_SIGNING_KEY_FILE` when that path is configured and
   * absent, so a container deployment gets a working settings UI without the
   * operator generating a key by hand. Leave both unset to keep it off.
   */
  settingsSigningKey: trackedSecret("SETTINGS_SIGNING_KEY") ?? "",

  /** @see secretReport */
  secretReport,
} as const;

export type Config = typeof config;
