/**
 * The logger *shape* both services log through.
 *
 * Types only — no implementation. Each package keeps its own logger: the
 * connector's `createLogger` lives in src/app.ts and stamps
 * `service: "claude-mail-mcp"`, the OAuth layer's lives in oauth/src/logger.ts,
 * stamps its own service name and owns {@link LOGIN_FAILURE_EVENT}, the string
 * an operator's fail2ban jail matches on. Those differ on purpose and are not
 * shared.
 *
 * What has to be shared is the signature, because {@link
 * ./secrets.ts | shared/secrets.ts} takes a logger as a parameter and one file
 * cannot import two different `Logger` types. Both packages re-export these,
 * so every existing `import type { Logger } from "./app.js"` and
 * `from "./logger.js"` keeps working and there is still exactly one
 * declaration.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export type Logger = (
  level: LogLevel,
  message: string,
  extra?: Record<string, unknown>
) => void;
