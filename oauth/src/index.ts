/**
 * Process entry point.
 *
 * Does nothing to the request path itself — that is entirely {@link createApp}'s
 * job. This loads configuration, opens the store, binds the socket and handles
 * shutdown, so that the app factory stays testable without a listening port.
 */

import { ConfigError, loadConfig } from "./config.js";
import { createApp, SERVICE_NAME, VERSION } from "./app.js";
import { createLogger } from "./logger.js";
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
  const store = await Store.open(config.stateFile, log);
  const { app } = createApp({ config, store, log });

  const server = app.listen(config.port, config.host, () => {
    log("info", "listening", {
      version: VERSION,
      address: `${config.host}:${config.port}`,
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
