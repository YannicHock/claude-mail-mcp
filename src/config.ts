/**
 * Environment configuration loader.
 *
 * In v0.2, only transport-level settings live here (port, auth token,
 * accounts file path, log level). Mailbox credentials moved to
 * accounts.json — see src/accounts.ts and README.md.
 */

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
} as const;

export type Config = typeof config;
