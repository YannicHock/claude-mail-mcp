/**
 * Two deliberately tiny HTTP servers standing in for the two things a CalDAV
 * URL can be when it is neither working nor unreachable, for the unit suite.
 *
 * Telling "wrong password" apart from "host unreachable" is the entire point
 * of the probe, and the CalDAV half of it could not: tsdav's discovery loses
 * the `401` on the way out (it walks a list of candidate root URLs and keeps
 * only the *last* failure), so a rejected password surfaced as `cannot find
 * principalUrl` — which reads as a bug in this software rather than as either
 * of the two answers the operator needs. See src/probe.ts.
 *
 * There is no Docker fixture for CalDAV the way GreenMail covers IMAP, so
 * these servers are the whole of that coverage. They speak no CalDAV at all,
 * on purpose:
 *
 *   - `"reject-credentials"` answers every request `401`, which is what a real
 *     endpoint does to a mistyped password, and is the only thing the probe's
 *     pre-flight looks at.
 *   - `"not-caldav"` answers every request `200 text/html`, i.e. a perfectly
 *     reachable web server that is not a calendar. This is the case that must
 *     stay distinguishable from the other two.
 *
 * Dependency-free (Node stdlib only), matching the rule in fixtures.ts.
 */

import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";

export type FakeCalDavBehaviour = "reject-credentials" | "not-caldav";

export interface FakeCalDavServer {
  /** A URL under the server, shaped like the path an operator would configure. */
  readonly url: string;
  close(): Promise<void>;
}

/**
 * Start the server on an ephemeral loopback port. Resolves once it is
 * listening; call `close()` to stop it and drop any live sockets.
 */
export async function startFakeCalDavServer(
  behaviour: FakeCalDavBehaviour
): Promise<FakeCalDavServer> {
  const sockets = new Set<Socket>();

  const server: Server = createServer((req, res) => {
    // PROPFIND carries a body. Nothing here cares what is in it, but it has to
    // be drained or the socket sits half-read until the client gives up.
    req.resume();

    if (behaviour === "reject-credentials") {
      res.writeHead(401, {
        "WWW-Authenticate": 'Basic realm="fake-caldav"',
        "Content-Type": "text/plain; charset=utf-8",
      });
      res.end("Unauthorized\n");
      return;
    }

    // Reachable, answers, and is emphatically not a calendar: no XML, no
    // `DAV:` header, nothing tsdav's discovery can make an account out of.
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end("<!doctype html><title>fake-caldav</title><p>Not a CalDAV endpoint.\n");
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    // A client that goes away mid-request must not take the process with it.
    socket.on("error", () => {});
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("fake CalDAV server did not bind a TCP port");
  }

  return {
    url: `http://127.0.0.1:${address.port}/dav`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
