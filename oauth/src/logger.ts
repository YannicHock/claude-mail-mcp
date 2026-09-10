/**
 * Structured logging.
 *
 * Two rules this service holds to, both because of what sits behind it:
 *
 * 1. No token, password, code verifier or authorization code is ever logged, in
 *    any field. Identifiers that are safe to correlate on (`jti`, `sid`, client
 *    id) are logged instead.
 * 2. Failed logins log a single line in a fixed shape, so an external
 *    fail2ban-style jail can match on it. No filter ships with this repository;
 *    an operator's own may already depend on the shape, which is why changing it
 *    is a deployment change, not a cosmetic one — see {@link LOGIN_FAILURE_EVENT}.
 */

/**
 * Re-exported, not declared: shared/secrets.ts takes a logger as a parameter and
 * both packages have to hand it the same type (#126). Every existing
 * `import type { Logger } from "./logger.js"` keeps working. What is *not*
 * shared is anything below — the service name, the level threshold and
 * {@link LOGIN_FAILURE_EVENT} are this service's own.
 */
import type { LogLevel, Logger } from "../../shared/log.js";

export type { LogLevel, Logger } from "../../shared/log.js";

const LEVELS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/**
 * The message a failed login logs. This string plus the `ip` field is the
 * deployment API for an external fail2ban-style jail (see docs/HARDENING.md,
 * which documents the shape but ships no filter of its own) — an operator's
 * jail may already be matching on it, so its shape must not change casually.
 */
export const LOGIN_FAILURE_EVENT = "login failed";

/** A logger that discards everything. The default in tests. */
export const silentLogger: Logger = () => {};

export function createLogger(minLevel: LogLevel): Logger {
  const threshold = LEVELS[minLevel] ?? LEVELS.info;
  return (level, message, extra) => {
    if (LEVELS[level] < threshold) return;
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      service: "claude-mail-mcp-oauth",
      msg: message,
      ...extra,
    });
    if (level === "error" || level === "warn") {
      process.stderr.write(`${line}\n`);
    } else {
      process.stdout.write(`${line}\n`);
    }
  };
}
