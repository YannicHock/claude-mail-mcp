/**
 * A deliberately tiny SMTP server for the unit suite: one that does not offer
 * STARTTLS, and refuses it when asked anyway (#220).
 *
 * It is the server an on-path attacker presents after stripping `STARTTLS`
 * from a real server's EHLO answer. It advertises `AUTH PLAIN LOGIN`, so a
 * client willing to log in without TLS would; every command line is recorded,
 * so a test can say that no `AUTH` ever arrived rather than only that the
 * client failed. GreenMail cannot model this — it is the plaintext server the
 * integration suite trusts on loopback.
 *
 * Dependency-free (Node stdlib only), matching the rule in fixtures.ts.
 */

import { createServer, type Server, type Socket } from "node:net";

export interface FakeSmtpServer {
  readonly port: number;
  /** Every command line any client sent, in order. */
  readonly received: readonly string[];
  close(): Promise<void>;
}

/**
 * Start the server on an ephemeral loopback port. Resolves once it is
 * listening; call `close()` to stop it and drop any live sockets.
 */
export async function startNoStartTlsSmtpServer(): Promise<FakeSmtpServer> {
  const sockets = new Set<Socket>();
  const received: string[] = [];

  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});

    socket.write("220 fake-smtp ESMTP ready\r\n");

    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let index: number;
      while ((index = buffer.indexOf("\r\n")) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        received.push(line);
        const verb = line.split(" ", 1)[0]!.toUpperCase();
        switch (verb) {
          case "EHLO":
            socket.write("250-fake-smtp\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n");
            break;
          case "STARTTLS":
            socket.write("502 5.5.1 STARTTLS not available\r\n");
            break;
          case "AUTH":
            // Never expected. Answered as a server that took the password
            // would, so a client that sent one carries on and the test sees it.
            socket.write("235 2.7.0 Authentication successful\r\n");
            break;
          case "QUIT":
            socket.write("221 2.0.0 Bye\r\n");
            socket.end();
            break;
          default:
            socket.write("250 OK\r\n");
        }
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("fake SMTP server did not bind a TCP port");
  }

  return {
    port: address.port,
    received,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
