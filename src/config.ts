/**
 * Environment configuration loader.
 *
 * In v0.2, only transport-level settings live here (port, auth token,
 * accounts file path, log level). Mailbox credentials moved to
 * accounts.json — see src/accounts.ts and README.md.
 *
 * Every secret can be supplied inline (`NAME`) or as a path to a file holding it
 * (`NAME_FILE`). A present file always wins; an absent one is created. That rule
 * and its consequences live in shared/secrets.ts.
 */

import { normalisePublicUrl } from "../shared/canonical-url.js";
import { trustProxyHops } from "../shared/trust-proxy.js";
import {
  resolveSecret,
  type ResolveOptions,
  type SecretReportEntry,
} from "../shared/secrets.js";

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
 * shared/secrets.ts for the whole rule. Values are trimmed on both paths, because
 * SETTINGS_SIGNING_KEY has to come out byte-identical here and in the OAuth
 * layer for the assertion's HMAC to verify, and a trailing newline pasted from
 * `openssl rand -base64 48` must not survive on one side but not the other.
 *
 * Only key material goes through this. `optional()` still reads plain
 * configuration such as ACCOUNTS_FILE, HOST and LOG_LEVEL, which deliberately
 * preserve incidental whitespace as-is. PUBLIC_URL has its own reader,
 * {@link publicUrl}, because it has to come out of both packages canonicalised
 * the same way rather than merely trimmed.
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
 * The rule itself lives in shared/trust-proxy.ts, because the OAuth layer had a
 * character-identical copy of it — error string included — with nothing
 * comparing the two (#126). Read the argument for never making this a boolean
 * there.
 *
 * Re-exported for the test suite. `config` below is evaluated once at import
 * time, so every rejection case would otherwise need a process of its own — see
 * the header of test/unit/config.defaults.test.ts for why the env
 * constellations are split across files. The parser is pure and can be
 * exercised directly.
 */
export { trustProxyHops };

/**
 * Read `PUBLIC_URL` and canonicalise it the way the OAuth layer canonicalises its
 * own copy — see {@link normalisePublicUrl} and the note on `publicUrl` below.
 *
 * A value that is not an absolute http(s) URL is fatal here rather than passed
 * along. The OAuth layer already refuses to start on the same input, and the only
 * thing this process could do with an unusable issuer is answer 401 to every
 * settings request for the life of the container — which is the failure #110 is
 * about, not a milder version of it.
 *
 * Exported for the test suite, for the same reason `trustProxyHops` is: `config`
 * below is evaluated once at import time, so a rejection case would otherwise
 * need a process of its own.
 */
export function publicUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.PUBLIC_URL;
  const value = raw && raw.trim() !== "" ? raw : "http://localhost:3220";
  try {
    return normalisePublicUrl(value);
  } catch (err) {
    throw new Error(
      `PUBLIC_URL must be an absolute http(s) URL without a fragment — it is the ` +
        `settings assertion's issuer and must name the same URL as the OAuth ` +
        `layer's PUBLIC_URL: ${err instanceof Error ? err.message : String(err)}`
    );
  }
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
  /**
   * This service's own public URL — the assertion's `iss`, compared on every
   * settings request against the value the OAuth layer holds in `.env.oauth`.
   *
   * Canonicalised by the rule *both* packages share: one shared/canonical-url.ts
   * compiled into both images since #126, mirrored by hand and pinned by a drift
   * test before that. Before #110 this
   * side only trimmed and stripped trailing slashes while the other side ran the
   * value through `new URL`, so `https://Mail.example.com` against
   * `https://mail.example.com`, or an explicit `:443` against none, 401'd every
   * settings request with nothing naming the cause.
   */
  publicUrl: publicUrl(),

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
