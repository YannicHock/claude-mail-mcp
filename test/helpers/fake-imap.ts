/**
 * A deliberately tiny IMAP server that rejects every login, for the unit
 * suite.
 *
 * The GreenMail fixture (docker-compose.test.yml) is what proves src/probe.ts
 * reads a *real* server's rejection correctly, and test/integration/probe.test.ts
 * is where that is asserted. This helper exists so the same classification is
 * also covered offline: telling "wrong password" apart from "host unreachable"
 * is the entire point of the probe, and a regression in it should not be able
 * to hide until someone runs the Docker-backed suite.
 *
 * It speaks just enough of RFC 3501 to get imapflow from greeting to LOGIN: a
 * greeting, a CAPABILITY response advertising nothing (so imapflow picks the
 * plain LOGIN command rather than an AUTHENTICATE mechanism, and skips
 * STARTTLS and ID), and then a tagged `NO` — byte-for-byte the shape GreenMail
 * answers a wrong password with.
 *
 * Dependency-free (Node stdlib only), matching the rule in fixtures.ts.
 */

import { createServer, type Server, type Socket } from "node:net";

export interface FakeImapServer {
  readonly port: number;
  close(): Promise<void>;
}

/**
 * Start the server on an ephemeral loopback port. Resolves once it is
 * listening; call `close()` to stop it and drop any live sockets.
 */
export async function startRejectingImapServer(): Promise<FakeImapServer> {
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

function handleLine(socket: Socket, line: string): void {
  // Every client command is `<tag> <COMMAND> [args]`; the tag has to come back
  // verbatim on the tagged response or the client never settles the request.
  const [tag, rawCommand] = line.split(" ", 2);
  if (!tag || !rawCommand) return;

  switch (rawCommand.toUpperCase()) {
    case "CAPABILITY":
      // The bare minimum: no AUTH=* (so imapflow uses LOGIN rather than
      // AUTHENTICATE), no STARTTLS, no ID, no LOGINDISABLED.
      socket.write("* CAPABILITY IMAP4rev1\r\n");
      socket.write(`${tag} OK CAPABILITY completed\r\n`);
      return;
    case "LOGIN":
      socket.write(`${tag} NO LOGIN failed. Invalid login/password\r\n`);
      return;
    case "LOGOUT":
      socket.write("* BYE fake-imap signing off\r\n");
      socket.write(`${tag} OK LOGOUT completed\r\n`);
      socket.end();
      return;
    default:
      socket.write(`${tag} BAD unsupported in fake-imap\r\n`);
      return;
  }
}
