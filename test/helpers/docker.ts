/**
 * Docker Compose lifecycle helpers for the GreenMail-backed integration
 * suite. Used by more than one integration test file — currently
 * test/integration/mail-server.test.ts and test/integration/probe.test.ts —
 * each of which independently calls composeUp() in its own `before()` and
 * composeDown() in its own `after()`.
 *
 * composeUp()/composeDown() are unguarded global operations: they act on one
 * shared Docker Compose project (named after the repo directory, since
 * docker-compose.test.yml declares no explicit `name:`) and one shared set of
 * published host ports (3143/3025/3993). There is no reference counting —
 * whichever file's `after()` runs first tears the fixture down for everyone,
 * including a file whose tests are still using it.
 *
 * `node --test` runs multiple test *files* concurrently by default, which
 * makes that a real problem the moment two files here both own the
 * lifecycle: package.json's `test:integration` script passes
 * `--test-concurrency=1` specifically to serialize integration test files
 * for this reason — running mail-server.test.ts and probe.test.ts together
 * without it produced ECONNREFUSED/"Connection not available" failures in
 * whichever file's `before()` lost the race. That flag is a real fix, not a
 * workaround to later remove — but it does mean adding a third Docker-backed
 * integration file costs every other one a little more wall-clock time,
 * serialized rather than parallel.
 *
 * The flag could be dropped only if this file's lifecycle became actually
 * shared-safe: e.g. genuine cross-process reference counting (a lockfile
 * under the OS temp dir, incremented in composeUp() and only actually
 * running `down` when it reaches zero in composeDown()), or giving each
 * integration file its own Compose project name *and* its own set of host
 * ports (the current ports are hardcoded in docker-compose.test.yml, so two
 * concurrent `up`s for genuinely separate projects would otherwise collide
 * trying to publish the same ports). Either is more machinery than this
 * fixture has needed so far; --test-concurrency=1 is the cheaper trade until
 * that changes.
 *
 * Dependency-free (Node stdlib only), matching the rule in fixtures.ts.
 */

import { execFileSync } from "node:child_process";
import { Socket } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path to the GreenMail compose file, resolved from this file's
 * own location so it works regardless of the test runner's cwd. */
export const COMPOSE_FILE = path.resolve(__dirname, "..", "..", "docker-compose.test.yml");

const GREENMAIL_SERVICE = "greenmail";

/**
 * True if the Docker daemon is reachable. This is the gate integration test
 * files use to skip cleanly (via node:test's `{ skip }` option) instead of
 * failing when Docker isn't available.
 */
export function isDockerAvailable(): boolean {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** `docker compose up -d` for the GreenMail service. Throws on failure —
 * that's a real setup failure, not a "Docker unavailable" skip. */
export function composeUp(): void {
  execFileSync(
    "docker",
    ["compose", "-f", COMPOSE_FILE, "up", "-d", "--remove-orphans"],
    { stdio: "inherit" }
  );
}

/** Tear down the GreenMail stack and its volumes. Best-effort: a teardown
 * failure is logged, not thrown, so it never masks a real test result. */
export function composeDown(): void {
  try {
    execFileSync(
      "docker",
      ["compose", "-f", COMPOSE_FILE, "down", "-v", "--remove-orphans"],
      { stdio: "inherit" }
    );
  } catch (err) {
    console.error(
      "docker compose down failed (ignored):",
      err instanceof Error ? err.message : err
    );
  }
}

function composeLogs(): string {
  try {
    return execFileSync(
      "docker",
      ["compose", "-f", COMPOSE_FILE, "logs", "--no-color", GREENMAIL_SERVICE],
      { encoding: "utf8" }
    );
  } catch {
    return "";
  }
}

/**
 * Resolves true once host:port not only accepts a TCP connection but also
 * sends at least one byte back (a protocol greeting), within `timeoutMs`.
 *
 * A bare "did connect() succeed" check is NOT enough here: GreenMail's IMAP
 * listener (unlike its SMTP one) accepts the TCP connection immediately —
 * well before its protocol handler has finished initializing — and only
 * writes the "* OK ... ready" greeting a couple of seconds later. imapflow
 * enforces its own greeting timeout and aborts the connection with a
 * `ClosedAfterConnectText` error if the greeting doesn't show up in time,
 * so a probe that only checks "is the port open" reports ready too early
 * and the very first real connection then fails intermittently. Waiting
 * for the first byte of data instead measures the thing that actually
 * matters: can a client complete the handshake.
 */
function canHandshake(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new Socket();
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("data", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
    socket.once("close", () => done(false));
    socket.connect(port, host);
  });
}

/**
 * Poll GreenMail's plain IMAP and SMTP ports directly rather than sleeping
 * a fixed amount of time or scraping log output — see
 * greenmail-findings.md #5 for the original plan (grep the startup log for
 * "Started GreenMail"), which turned out not to hold for this image/config:
 * standalone v2.1.13 with `-Dgreenmail.setup.test.all` never actually
 * prints that banner. In practice both ports finish their handshake within
 * a few seconds once the image is already pulled; the timeout here is
 * generous to also cover a cold pull.
 */
export async function waitForGreenmailReady(
  host = "127.0.0.1",
  ports: number[] = [3143, 3025],
  timeoutMs = 60_000
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const results = await Promise.all(ports.map((port) => canHandshake(host, port, 2000)));
    if (results.every(Boolean)) return;
  }
  throw new Error(
    `GreenMail did not complete a handshake on ${ports.join(", ")} within ${timeoutMs}ms. Container logs:\n${composeLogs()}`
  );
}
