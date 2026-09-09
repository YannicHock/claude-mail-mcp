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

export const config = {
  port: int("PORT", 3220),
  /**
   * Interface to bind. Default 127.0.0.1 (loopback only) — the public
   * hostname is terminated by nginx/Caddy upstream. Set to 0.0.0.0 only
   * if you really want the process directly internet-reachable, in which
   * case you're on your own re. TLS, rate-limiting, etc.
   */
  host: optional("HOST", "127.0.0.1"),
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
