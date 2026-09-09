/**
 * Process entry point.
 *
 * Does nothing to the request path itself — that is entirely {@link createApp}'s
 * job. This loads configuration, opens the store, binds the socket and handles
 * shutdown, so that the app factory stays testable without a listening port.
 */

import { existsSync } from "node:fs";
import { dirname } from "node:path";

import {
  Bootstrap,
  BootstrapError,
  DATA_DIRECTORY_BIND_MOUNT,
  DATA_DIRECTORY_HOLDS,
  operatorSeed,
} from "./bootstrap.js";
import { ConfigError, loadConfig } from "./config.js";
import { createApp, SERVICE_NAME, VERSION } from "./app.js";
import { createLogger } from "./logger.js";
import { OperatorRecord } from "./operator.js";
import { canCreateFilesIn, dataDirectoryAdvice, logSecretReport } from "./secrets.js";
import { Store } from "./store.js";

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      // Configuration problems are the operator's to fix and the stack trace adds
      // nothing; print the message alone so it is readable in `docker logs`.
      process.stderr.write(`${SERVICE_NAME}: ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }

  const log = createLogger(config.logLevel);
  // First thing in the log, before anything that might fail on a secret: which
  // of them were read and which this boot created. On a shared secret an
  // operator otherwise has no way to tell which of the two services wrote it.
  logSecretReport(config.secretReport, log);
  const store = await Store.open(config.stateFile, log);

  // Before the operator record, not after: whether to open one at all is what
  // this answers. An unclaimed instance has no operator to seed a record from,
  // and seeding one anyway would claim the instance on its owner's behalf with a
  // password nobody chose.
  let bootstrap: Bootstrap;
  try {
    bootstrap = Bootstrap.open(config, log);
  } catch (err) {
    if (err instanceof BootstrapError) {
      process.stderr.write(`${SERVICE_NAME}: ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }

  // Every boot while unclaimed, not only the first. A container that restarts
  // mid-setup must not cost the operator the link, and the token it prints is the
  // same one the previous boot wrote.
  bootstrap.announce();

  // The other half of #105. An *unclaimed* instance that cannot write its data
  // directory is fatal and `Bootstrap.open` has already said so; a claimed one
  // boots and serves perfectly well until the first client registration, session
  // rotation or password change fails with an EACCES nobody is watching for. Not
  // fatal — refusing to start would take a working instance off the air over a
  // fault it can still serve most requests around — but said out loud at boot,
  // once, rather than discovered from a Claude client that will not reconnect.
  const dataDirectory = config.claimTokenFile === null ? null : dirname(config.claimTokenFile);
  if (dataDirectory !== null && existsSync(dataDirectory) && !canCreateFilesIn(dataDirectory)) {
    log("warn", "data directory is not writable", {
      path: dataDirectory,
      note: dataDirectoryAdvice({
        path: dataDirectory,
        holds: DATA_DIRECTORY_HOLDS,
        bindMountSource: DATA_DIRECTORY_BIND_MOUNT,
      }),
    });
  }

  // Absent while unbootstrapped: there is no record to open and seeding one
  // would claim the instance on its owner's behalf. That is also what keeps
  // `/settings/*` a 404 in that state — and no longer what keeps it one
  // afterwards. Since #121 the app resolves the record itself the first time it
  // needs one, so a wizard that finishes in this process opens the settings UI
  // in the same breath it opens `/mcp`, without a restart.
  const operator = bootstrap.bootstrapped
    ? await OperatorRecord.open(config.operatorFile, operatorSeed(config), log)
    : undefined;

  const { app } = createApp({ config, store, operator, bootstrap, log });

  const server = app.listen(config.port, config.host, () => {
    log("info", "listening", {
      version: VERSION,
      address: `${config.host}:${config.port}`,
      // Which half of the state table this process is serving. Never the token:
      // the banner above is where that belongs, once, deliberately.
      bootstrapped: bootstrap.bootstrapped,
      issuer: config.issuer,
      resource: config.resource,
      upstream: config.upstreamMcpUrl,
      // Neither the signing key nor the upstream token is ever logged; the
      // allowlist is, because a redirect_uri rejection is otherwise very hard to
      // diagnose from the client side.
      redirect_allowlist: config.redirectAllowlist,
    });
  });

  // Expired refresh sessions would otherwise sit in the state file until they
  // were next looked up, which for an abandoned session is never.
  const prune = setInterval(
    () => {
      const dropped = store.pruneExpiredSessions();
      if (dropped > 0) log("info", "pruned expired sessions", { dropped });
    },
    60 * 60 * 1000
  );
  prune.unref();

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log("info", "shutting down", { signal });
    clearInterval(prune);
    server.close(() => {
      // Flush before exiting, so a registration or rotation from the last few
      // milliseconds is not lost.
      void store.close().then(() => process.exit(0));
    });
    // Do not wait forever on a client holding a connection open.
    setTimeout(() => {
      log("warn", "forcing shutdown after timeout", {});
      void store.close().then(() => process.exit(0));
    }, 10_000).unref();
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

// This module deliberately re-exports nothing. Its only statement with an effect
// is the call below, so there is no way to import it without starting a server —
// which is precisely why everything worth importing lives in ./app.js instead,
// and why the tests build their server from there.
await main();
