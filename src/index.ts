#!/usr/bin/env node
/**
 * claude-mail-mcp — entry point (v0.2).
 *
 * Boots an Express server that exposes:
 *   - GET  /health        liveness probe + accounts summary
 *   - POST /mcp           MCP Streamable HTTP transport (Bearer-auth gated)
 *
 * The routes themselves live in src/app.ts (`createApp`), which the test suite
 * builds its server from too. This file owns only the process concerns: config,
 * the AccountsStore/ClientPool lifecycle, binding the port and shutdown.
 *
 * v0.2: multi-account per deployment. Credentials live in accounts.json
 * (created by hand — see docs/DEPLOYMENT.md), watched via fs.watch for
 * hot-reload. Calendar tools are always registered; tools that require
 * CalDAV error friendly if the resolved account has none configured.
 */

import { config } from "./config.js";
import { AccountsStore } from "./accounts.js";
import { ClientPool } from "./client-pool.js";
import { createApp, VERSION } from "./app.js";

export { createApp, SERVER_NAME, VERSION } from "./app.js";
export type { CreateAppOptions, Logger, LogLevel } from "./app.js";

function log(
  level: "debug" | "info" | "warn" | "error",
  message: string,
  extra?: Record<string, unknown>
): void {
  const order = { debug: 0, info: 1, warn: 2, error: 3 };
  if (order[level] < order[config.logLevel]) return;
  const line = {
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...extra,
  };
  console.error(JSON.stringify(line));
}

async function main(): Promise<void> {
  const store = new AccountsStore(config.accountsFile);
  const pool = new ClientPool(store);
  await store.start((next, prev) => {
    log("info", "accounts.json changed", {
      previous: prev.map((a) => a.id),
      current: next.map((a) => a.id),
    });
    pool.resetAll().catch((err) =>
      log("warn", "client pool reset failed", {
        error: err instanceof Error ? err.message : String(err),
      })
    );
  });
  log("info", "accounts loaded", {
    file: config.accountsFile,
    count: store.list().length,
    ids: store.ids(),
  });

  const app = createApp({
    store,
    pool,
    authToken: config.authToken,
    accountsFile: config.accountsFile,
    log,
  });

  app.listen(config.port, config.host, () => {
    log("info", "claude-mail-mcp listening", {
      host: config.host,
      port: config.port,
      version: VERSION,
      public_url: config.publicUrl,
      accounts_file: config.accountsFile,
      accounts: store.ids(),
    });
  });

  const shutdown = async (signal: string): Promise<void> => {
    log("info", "shutting down", { signal });
    store.stop();
    await pool.closeAll().catch(() => {});
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
