/**
 * Environment configuration loader.
 *
 * In v0.2, only transport-level settings live here (port, auth token,
 * accounts file path, log level). Mailbox credentials moved to
 * accounts.json — see src/accounts.ts and README.md.
 */

import { readFileSync } from "node:fs";

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(
      `Missing required environment variable: ${name}. See .env.example.`
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
 * Read a value that may be given inline or as a path to a file holding it.
 *
 * `NAME_FILE` wins when both are set, and an unreadable `NAME_FILE` is fatal
 * rather than a silent fallback to `NAME` — a typo in a secret mount should stop
 * the process, not quietly downgrade it. Mirrors the same helper in
 * oauth/src/config.ts.
 *
 * Both the inline and the file-sourced path are trimmed. A secret like this one
 * has to come out byte-identical on both services for an HMAC to verify, so
 * incidental whitespace (a trailing newline pasted from `openssl rand -base64
 * 48` output) must not survive on one path but not the other. Trimming is
 * scoped to this helper rather than folded into `optional()`, which other
 * call sites (ACCOUNTS_FILE, PUBLIC_URL, HOST, LOG_LEVEL) rely on to preserve
 * incidental whitespace as-is.
 */
function secret(name: string, fallback: string): string {
  const filePath = process.env[`${name}_FILE`];
  if (filePath && filePath.trim() !== "") {
    try {
      return readFileSync(filePath.trim(), "utf8").trim();
    } catch (err) {
      throw new Error(
        `Cannot read ${name}_FILE at ${filePath.trim()}: ` +
          (err instanceof Error ? err.message : String(err))
      );
    }
  }
  return optional(name, fallback).trim();
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
   * calling /mcp — the only thing gating that endpoint. Required: the process
   * refuses to start without it.
   */
  authToken: required("AUTH_TOKEN"),
  publicUrl: optional("PUBLIC_URL", "http://localhost:3220"),

  /**
   * Shared key for the settings assertion the OAuth layer sends with proxied
   * /settings requests. Empty means the settings routes are not mounted and this
   * process behaves exactly as it did before they existed.
   */
  settingsSigningKey: secret("SETTINGS_SIGNING_KEY", ""),
} as const;

export type Config = typeof config;
