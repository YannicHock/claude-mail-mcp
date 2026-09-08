/**
 * Express application factory.
 *
 * Everything between the internet and a configured mailbox lives here: the
 * Bearer-token check on `/mcp`, the unauthenticated `/health` probe, the MCP
 * Streamable HTTP handler and the catch-all 404. `src/index.ts` is the process
 * entry point and does nothing to the request path itself — it loads config,
 * builds the AccountsStore/ClientPool, calls {@link createApp}, binds the port
 * and handles shutdown.
 *
 * The split exists so tests can exercise the *real* middleware chain. Before
 * it, `test/helpers/mcp-app.ts` re-implemented `bearerAuth` and `/health` by
 * hand and every MCP-protocol test ran against that copy: deleting the auth
 * check from the shipped server left all tests green. Tests now build their
 * server with this function, so the auth check on the way to every mailbox is
 * covered by the suite.
 *
 * Why a separate module rather than an export from `index.ts`: importing
 * `index.ts` executes its top-level `main()`, which binds a port and installs
 * signal handlers. Making that conditional on being the entry point would mean
 * an `import.meta.url` / `process.argv[1]` comparison that is wrong whenever
 * the `bin` symlink is used, silently turning `claude-mail-mcp` into a no-op.
 * A plain module has no such failure mode. `index.ts` re-exports
 * {@link createApp} for consumers that import the package entry point.
 */

import express, { NextFunction, Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { AccountsStore } from "./accounts.js";
import { ClientPool } from "./client-pool.js";
import { registerMailTools } from "./tools-mail.js";
import { registerCalendarTools } from "./tools-calendar.js";
import { createSettingsRouter } from "./settings-routes.js";

/** MCP `serverInfo.name` reported to clients, and the `server` field of `/health`. */
export const SERVER_NAME = "claude-mail-mcp";

/** MCP `serverInfo.version` reported to clients, and the `version` field of `/health`. */
export const VERSION = "0.5.0";

export type LogLevel = "debug" | "info" | "warn" | "error";

export type Logger = (
  level: LogLevel,
  message: string,
  extra?: Record<string, unknown>
) => void;

export interface CreateAppOptions {
  /** Account store backing `/health` and every tool's account resolution. */
  store: AccountsStore;
  /** Lazy per-account IMAP/SMTP/CalDAV clients handed to the tool registrations. */
  pool: ClientPool;
  /** Value `Authorization: Bearer <token>` must match to reach `/mcp`. */
  authToken: string;
  /** Reported verbatim as `accounts_file` in the `/health` body. */
  accountsFile: string;
  /**
   * Structured logger. Defaults to a no-op so a test harness does not have to
   * silence the process-level logger `index.ts` passes in.
   */
  log?: Logger;
  /**
   * Shared HMAC key for verifying the settings assertion the OAuth layer attaches
   * to a proxied `/settings` request — see settings-assertion.ts. The settings
   * routes are mounted only when this is set; an empty/undefined value leaves this
   * process behaving exactly as it did before those routes existed.
   */
  settingsSigningKey?: string;
  /**
   * This connector's own public URL, checked as the assertion's `iss` claim.
   * Must equal the OAuth layer's `PUBLIC_URL` or every assertion fails closed —
   * see docs/DEPLOYMENT.md. Required unconditionally (rather than only alongside
   * `settingsSigningKey`) so it can't be added later and be missing by accident.
   */
  publicUrl: string;
}

/**
 * Build the Express app. Does not listen — the caller owns the socket, which
 * is what lets a test bind port 0 and close it deterministically afterwards.
 */
export function createApp(opts: CreateAppOptions): express.Express {
  const { store, pool, authToken, accountsFile } = opts;
  const log: Logger = opts.log ?? (() => {});

  const mcp = new McpServer({
    name: SERVER_NAME,
    version: VERSION,
  });
  registerMailTools(mcp, pool, store);
  registerCalendarTools(mcp, pool);

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", true);
  app.use(express.json({ limit: "5mb" }));

  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      server: SERVER_NAME,
      version: VERSION,
      accounts: store.publicSummaries(),
      accounts_file: accountsFile,
    });
  });

  function bearerAuth(req: Request, res: Response, next: NextFunction): void {
    const header = req.header("authorization") ?? "";
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match || match[1] !== authToken) {
      log("warn", "rejected unauthenticated MCP request", {
        ip: req.ip,
        path: req.path,
      });
      res.status(401).json({
        error: "unauthorized",
        message: "Missing or invalid Bearer token",
      });
      return;
    }
    next();
  }

  app.post("/mcp", bearerAuth, async (req, res) => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      transport.close().catch(() => {});
    });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      log("error", "MCP request failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      if (!res.headersSent) {
        res.status(500).json({
          error: "internal_error",
          message: err instanceof Error ? err.message : "Unknown error",
        });
      }
    }
  });

  // Scoped to the /settings prefix rather than applied globally — mounting
  // bearerAuth at the app root would make an unrelated 404 into a 401 for
  // every unknown path, a behaviour change nothing here calls for. The
  // settings router itself mounts at "/" (not "/settings") so its routes
  // keep their full path — requireSettingsAssertion depends on req.path
  // matching the "htu" the OAuth layer signed; see settings-assertion.ts.
  if (opts.settingsSigningKey) {
    app.use("/settings", bearerAuth);
    app.use(
      createSettingsRouter({
        store,
        issuer: opts.publicUrl,
        settingsKey: opts.settingsSigningKey,
        log,
      })
    );
  }

  app.use((req, res) => {
    res.status(404).json({
      error: "not_found",
      message: `${req.method} ${req.path} is not a valid endpoint. Use GET /health or POST /mcp.`,
    });
  });

  // App-wide rather than router-only: the global express.json() above (on
  // /mcp) and the settings router's express.urlencoded() both call next(err)
  // on a malformed or oversized body, and neither is a route handler that can
  // catch that itself — it never reaches one. Without this, such an error
  // falls through to Express 5's default handler, which renders an HTML page
  // (including a stack trace unless NODE_ENV=production, which nothing here
  // sets) instead of this app's otherwise-consistent JSON error shape. This
  // sits after the 404 handler, not before it: the 404 handler always sends a
  // response itself rather than calling next(), so ordering the two doesn't
  // matter for correctness, but an error handler reads better last. It leaves
  // the /mcp handler's own try/catch above alone — that one only ever sees
  // errors from mcp.connect()/handleRequest() *after* the body already parsed
  // successfully, so the two paths cannot both fire for the same request.
  app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    const status = errorStatus(err);
    log("warn", "rejected malformed request body", {
      path: req.path,
      status,
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(status).json({
      error: "bad_request",
      message: "The request could not be processed: malformed or oversized body.",
    });
  });

  return app;
}

/** Body-parser errors (body-parser/raw-body) set `.status`/`.statusCode` to a
 * real 4xx (413 too large, 400 malformed, etc.); anything else defaults to 400
 * rather than assuming a 500 for what is, in every case this handler is
 * reached, a request the client sent wrong. */
function errorStatus(err: unknown): number {
  const candidate =
    (err as { status?: unknown } | null)?.status ?? (err as { statusCode?: unknown } | null)?.statusCode;
  return typeof candidate === "number" && candidate >= 400 && candidate < 600 ? candidate : 400;
}
