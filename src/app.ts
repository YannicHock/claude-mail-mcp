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

/** MCP `serverInfo.name` reported to clients, and the `server` field of `/health`. */
export const SERVER_NAME = "claude-mail-mcp";

/** MCP `serverInfo.version` reported to clients, and the `version` field of `/health`. */
export const VERSION = "0.4.0";

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

  app.use((req, res) => {
    res.status(404).json({
      error: "not_found",
      message: `${req.method} ${req.path} is not a valid endpoint. Use GET /health or POST /mcp.`,
    });
  });

  return app;
}
