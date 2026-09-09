/**
 * Deliberately tiny IMAP servers for the unit suite, one per misbehaviour
 * src/probe.ts has to survive.
 *
 * The GreenMail fixture (docker-compose.test.yml) is what proves src/probe.ts
 * reads a *real* server's rejection correctly, and test/integration/probe.test.ts
 * is where that is asserted. This helper exists so the same classification is
 * also covered offline: telling "wrong password" apart from "host unreachable"
 * is the entire point of the probe, and a regression in it should not be able
 * to hide until someone runs the Docker-backed suite.
 *
 * Both servers speak just enough of RFC 3501 to get imapflow from greeting to
 * LOGIN: a greeting, a CAPABILITY response advertising nothing (so imapflow
 * picks the plain LOGIN command rather than an AUTHENTICATE mechanism, and
 * skips STARTTLS and ID), and then the failure being modelled — a tagged `NO`,
 * byte-for-byte the shape GreenMail answers a wrong password with, or a socket
 * that simply goes away. Neither behaviour is reachable from a well-behaved
 * fixture, which is why they are hand-rolled here.
 *
 * Dependency-free (Node stdlib only), matching the rule in fixtures.ts.
 */

import { createServer, type Server, type Socket } from "node:net";

export interface FakeImapServer {
  readonly port: number;
  close(): Promise<void>;
}

/** How one of these servers answers a single client command line. */
type LineHandler = (socket: Socket, line: string) => void;

/**
 * Start a server on an ephemeral loopback port, driving each received command
 * line through `handleLine`. Resolves once it is listening; call `close()` to
 * stop it and drop any live sockets.
 */
async function startFakeImapServer(handleLine: LineHandler): Promise<FakeImapServer> {
  const sockets = new Set<Socket>();

  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    // A client that goes away mid-command must not take the process with it.
    socket.on("error", () => {});

    socket.write("* OK [CAPABILITY IMAP4rev1] fake-imap ready\r\n");

    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let index: number;
      while ((index = buffer.indexOf("\r\n")) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        handleLine(socket, line);
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("fake IMAP server did not bind a TCP port");
  }

  return {
    port: address.port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

/**
 * Start a server on an ephemeral loopback port. Resolves once it is
 * listening; call `close()` to stop it and drop any live sockets.
 */
export async function startRejectingImapServer(): Promise<FakeImapServer> {
  return startFakeImapServer(handleRejectingLine);
}

/**
 * The same server, except that `LOGIN` is answered by closing the connection
 * instead of by a tagged response — a half-open or overloaded mail server, the
 * exact case the connection test exists to survive.
 *
 * The interesting part is not the failure imapflow reports for the command in
 * flight (`Unexpected close`, a connectivity failure like any other) but what
 * it does *afterwards*: it emits a second `'error'` event on the `ImapFlow`
 * instance once the probe has already resolved. An `EventEmitter` with no
 * `'error'` listener rethrows, and Node turns that into an uncaught exception
 * that takes the whole connector down — see probeImap() in src/probe.ts, and
 * the regression test in test/unit/probe.test.ts that catches it.
 */
export async function startMidLoginDropImapServer(): Promise<FakeImapServer> {
  return startFakeImapServer(handleMidLoginDropLine);
}

/**
 * Split a client command line into its tag and command. Every client command
 * is `<tag> <COMMAND> [args]`; the tag has to come back verbatim on the tagged
 * response or the client never settles the request.
 */
function parseCommand(line: string): { tag: string; command: string } | null {
  const [tag, rawCommand] = line.split(" ", 2);
  if (!tag || !rawCommand) return null;
  return { tag, command: rawCommand.toUpperCase() };
}

/** Answer CAPABILITY, so imapflow gets as far as issuing LOGIN at all. */
function writeCapability(socket: Socket, tag: string): void {
  // The bare minimum: no AUTH=* (so imapflow uses LOGIN rather than
  // AUTHENTICATE), no STARTTLS, no ID, no LOGINDISABLED.
  socket.write("* CAPABILITY IMAP4rev1\r\n");
  socket.write(`${tag} OK CAPABILITY completed\r\n`);
}

function handleRejectingLine(socket: Socket, line: string): void {
  const parsed = parseCommand(line);
  if (!parsed) return;

  switch (parsed.command) {
    case "CAPABILITY":
      writeCapability(socket, parsed.tag);
      return;
    case "LOGIN":
      socket.write(`${parsed.tag} NO LOGIN failed. Invalid login/password\r\n`);
      return;
    case "LOGOUT":
      socket.write("* BYE fake-imap signing off\r\n");
      socket.write(`${parsed.tag} OK LOGOUT completed\r\n`);
      socket.end();
      return;
    default:
      socket.write(`${parsed.tag} BAD unsupported in fake-imap\r\n`);
      return;
  }
}

function handleMidLoginDropLine(socket: Socket, line: string): void {
  const parsed = parseCommand(line);
  if (!parsed) return;

  switch (parsed.command) {
    case "CAPABILITY":
      writeCapability(socket, parsed.tag);
      return;
    case "LOGIN":
      // No response at all, tagged or untagged: just a FIN while the client is
      // still waiting for its LOGIN to settle. A graceful close rather than a
      // destroy, because that is what a server shedding load actually does, and
      // it is what imapflow reports as "Unexpected close".
      socket.end();
      return;
    default:
      socket.write(`${parsed.tag} BAD unsupported in fake-imap\r\n`);
      return;
  }
}
