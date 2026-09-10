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

import { existsSync } from "node:fs";
import { dirname } from "node:path";

import { config } from "./config.js";
import { AccountsStore } from "./accounts.js";
import { ClientPool } from "./client-pool.js";
import { createApp, VERSION } from "./app.js";
import { canCreateFilesIn, dataDirectoryAdvice, logSecretReport } from "../shared/secrets.js";

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
  // Before anything else: which secrets this boot read and which it created.
  // auth_token and settings_signing_key are shared with the OAuth layer, and
  // "who generated it" is otherwise impossible to tell from the outside.
  logSecretReport(config.secretReport, log);

  // #105, the connector's half of it — and the quiet half. An unwritable data
  // directory does not stop this process: it reads accounts.json perfectly well
  // and serves every mail tool from it. What it stops is a mailbox ever being
  // *saved*, which is the setup wizard's step 2 and the whole of the settings
  // UI, and it stops it with an EACCES from a browser form rather than anything
  // in the startup log.
  //
  // So the answer depends on what is already there. No accounts file yet means
  // an instance that can never acquire one — the first boot of a clean clone,
  // which is what the issue is about — and it says so and stops. One that exists
  // means a connector already serving mailboxes, and taking it off the air over a
  // fault it can serve around would be the worse trade: that one gets a warning
  // it can act on at leisure.
  //
  // A directory that is not there at all is neither: the accounts file is
  // optional, an absent path is how a local `npm start` legitimately begins, and
  // AccountsStore already starts empty on ENOENT.
  const dataDirectory = dirname(config.accountsFile);
  if (existsSync(dataDirectory) && !canCreateFilesIn(dataDirectory)) {
    const advice = dataDirectoryAdvice({
      path: dataDirectory,
      holds: "accounts.json, every mailbox credential this connector holds",
      bindMountSource: "./data",
    });
    if (existsSync(config.accountsFile)) {
      log("warn", "data directory is not writable", { path: dataDirectory, note: advice });
    } else {
      // Not through `log`: this is the last thing this process will do, the
      // operator is reading `docker compose logs`, and a paste-ready command
      // inside a JSON string is not something anyone can act on.
      process.stderr.write(`claude-mail-mcp: ${advice}`);
      process.exit(1);
    }
  }

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
    settingsSigningKey: config.settingsSigningKey,
    publicUrl: config.publicUrl,
    trustProxy: config.trustProxy,
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
