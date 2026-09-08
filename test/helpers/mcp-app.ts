/**
 * In-process Express + MCP harness for integration tests.
 *
 * src/index.ts wires the real thing (Bearer auth, GET /health, POST /mcp)
 * but does so entirely inside `main()`, which isn't structured for testing:
 * it never returns or exports the Express app, the underlying http.Server,
 * or the AccountsStore/ClientPool it builds, and its auth check
 * (`bearerAuth`) is a private, non-exported function. Concretely, that
 * means there is no way to import src/index.ts from a test and still get a
 * handle to shut the server down afterwards — and on Windows, a listening
 * server (or an un-stopped AccountsStore — see the fs.watch note in
 * accounts.test.ts) that outlives its test file hangs the whole
 * `node --test` run. Flagged in the task report as a suggested refactor
 * (export a small `createApp()`/`createServer()` from src/index.ts) so a
 * future test — or this one — can start the real thing directly.
 *
 * Until then, this harness rebuilds the same wiring using the real
 * exported building blocks (AccountsStore, ClientPool, registerMailTools,
 * registerCalendarTools) so account resolution and tool registration are
 * exercised for real; only the ~20 lines of Express glue below are
 * duplicated from src/index.ts and must be kept in sync with it by hand.
 */

import express, { NextFunction, Request, Response } from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { AccountsStore } from "../../src/accounts.js";
import { ClientPool } from "../../src/client-pool.js";
import { registerMailTools } from "../../src/tools-mail.js";
import { registerCalendarTools } from "../../src/tools-calendar.js";

// Mirrors the two constants src/index.ts passes to `new McpServer(...)`
// (there: `name: "claude-mail-mcp"`, `const VERSION = "0.2.1"`, neither
// exported).
export const HARNESS_SERVER_NAME = "claude-mail-mcp";
export const HARNESS_SERVER_VERSION = "0.2.1";

export interface McpTestApp {
  url: string;
  port: number;
  store: AccountsStore;
  pool: ClientPool;
  close(): Promise<void>;
}

/**
 * Start a real Express app — real AccountsStore reading `accountsFile`,
 * real ClientPool, real registered tools — on a free loopback port.
 * `close()` guarantees the listener is closed, the store's fs.watch is
 * stopped, and pooled IMAP connections are closed, regardless of what the
 * caller did in between.
 */
export async function startMcpApp(opts: {
  accountsFile: string;
  authToken: string;
}): Promise<McpTestApp> {
  const store = new AccountsStore(opts.accountsFile);
  await store.start();

  const pool = new ClientPool(store);

  const mcp = new McpServer({
    name: HARNESS_SERVER_NAME,
    version: HARNESS_SERVER_VERSION,
  });
  registerMailTools(mcp, pool, store);
  registerCalendarTools(mcp, pool);

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "5mb" }));

  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      server: HARNESS_SERVER_NAME,
      version: HARNESS_SERVER_VERSION,
      accounts: store.publicSummaries(),
      accounts_file: opts.accountsFile,
    });
  });

  // Mirrors src/index.ts's bearerAuth exactly — keep in sync by hand.
  function bearerAuth(req: Request, res: Response, next: NextFunction): void {
    const header = req.header("authorization") ?? "";
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match || match[1] !== opts.authToken) {
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

  const server = await new Promise<Server>((resolve, reject) => {
    const s: Server = app.listen(0, "127.0.0.1", () => resolve(s));
    s.on("error", reject);
  });
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    store,
    pool,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.stop();
      await pool.closeAll().catch(() => {});
    },
  };
}
