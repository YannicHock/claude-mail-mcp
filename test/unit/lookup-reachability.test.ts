/**
 * Unit tests for src/lookup-reachability.ts — whether a suggested mail server
 * answers from this host at all (#194).
 *
 * Against real sockets on 127.0.0.1: a plain server that greets, one that says
 * nothing, a closed port, and a TLS server with the self-signed certificate in
 * test/fixtures/tls. No outbound traffic.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import tls from "node:tls";
import { fileURLToPath } from "node:url";

import { reachable } from "../../src/lookup-reachability.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const CERT = readFileSync(path.join(here, "..", "fixtures", "tls", "localhost.crt"));
const KEY = readFileSync(path.join(here, "..", "fixtures", "tls", "localhost.key"));
const LOCAL = ["127.0.0.1"];

async function listen(server: net.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as net.AddressInfo).port;
}

async function closeServer(server: net.Server, sockets: Set<net.Socket>): Promise<void> {
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

/** A plain server that writes `greeting` to every connection, or nothing. */
async function plainServer(greeting: string | null) {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    if (greeting !== null) socket.write(greeting);
  });
  const port = await listen(server);
  return { port, close: () => closeServer(server, sockets) };
}

async function tlsServer() {
  const sockets = new Set<net.Socket>();
  const server = tls.createServer({ cert: CERT, key: KEY }, (socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
  });
  server.on("tlsClientError", () => {});
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
  });
  const port = await listen(server);
  return { port, close: () => closeServer(server, sockets) };
}

test("an SMTP greeting on a STARTTLS port is an answer", async () => {
  const server = await plainServer("220 mail.example ESMTP ready\r\n");
  try {
    assert.equal(
      await reachable({ host: "localhost", port: server.port, socketType: "STARTTLS" }, LOCAL, 1_000),
      true
    );
  } finally {
    await server.close();
  }
});

test("an IMAP greeting on a STARTTLS port is an answer", async () => {
  const server = await plainServer("* OK IMAP4rev1 ready\r\n");
  try {
    assert.equal(
      await reachable({ host: "localhost", port: server.port, socketType: "STARTTLS" }, LOCAL, 1_000),
      true
    );
  } finally {
    await server.close();
  }
});

test("a port that accepts and says nothing is not an answer, and gives up in time", async () => {
  const server = await plainServer(null);
  try {
    const started = Date.now();
    assert.equal(
      await reachable({ host: "localhost", port: server.port, socketType: "STARTTLS" }, LOCAL, 300),
      false
    );
    assert.ok(Date.now() - started < 1_000, "bounded by its own timeout");
  } finally {
    await server.close();
  }
});

test("something that greets in another protocol is not a mail server", async () => {
  const server = await plainServer("HTTP/1.1 400 Bad Request\r\n\r\n");
  try {
    assert.equal(
      await reachable({ host: "localhost", port: server.port, socketType: "STARTTLS" }, LOCAL, 1_000),
      false
    );
  } finally {
    await server.close();
  }
});

test("a closed port is not an answer", async () => {
  const server = await plainServer(null);
  const port = server.port;
  await server.close();
  assert.equal(await reachable({ host: "localhost", port, socketType: "SSL" }, LOCAL, 1_000), false);
});

test("implicit TLS answers when the handshake verifies", async () => {
  const server = await tlsServer();
  try {
    assert.equal(
      await reachable({ host: "localhost", port: server.port, socketType: "SSL" }, LOCAL, 1_000, {
        ca: CERT,
      }),
      true
    );
  } finally {
    await server.close();
  }
});

test("implicit TLS whose certificate does not verify is not an answer", async () => {
  // The real connection would fail on this certificate, so it must not win at
  // the lookup either. Verification is never switched off to find out.
  const server = await tlsServer();
  try {
    assert.equal(
      await reachable({ host: "localhost", port: server.port, socketType: "SSL" }, LOCAL, 1_000),
      false
    );
  } finally {
    await server.close();
  }
});

test("a second address is tried when the first does not answer", async () => {
  // The server is bound to 127.0.0.1 only, so 127.0.0.2 (still loopback) is
  // refused and the check has to move on to the next address it was given.
  const server = await plainServer("220 ready\r\n");
  try {
    assert.equal(
      await reachable(
        { host: "localhost", port: server.port, socketType: "STARTTLS" },
        ["127.0.0.2", "127.0.0.1"],
        1_000
      ),
      true
    );
  } finally {
    await server.close();
  }
});

test("an address that swallows the connection does not use up the others' time", async () => {
  // An IPv6 route that drops SYNs instead of refusing them looks like this:
  // accepted into nothing, never a word back. `dns.lookup` can hand that
  // address over first, and tried one after another it spent the whole slice,
  // so 587 came back as unreachable as 465 on exactly the host #194 is for.
  const port = await freePort();
  const silent = await plainServerOn("127.0.0.1", port, null);
  const greeter = await plainServerOn("127.0.0.2", port, "220 ready\r\n");
  try {
    const started = Date.now();
    assert.equal(
      await reachable({ host: "localhost", port, socketType: "STARTTLS" }, ["127.0.0.1", "127.0.0.2"], 1_000),
      true
    );
    assert.ok(Date.now() - started < 500, `took ${Date.now() - started}ms`);
  } finally {
    await silent.close();
    await greeter.close();
  }
});

async function freePort(): Promise<number> {
  const probe = net.createServer();
  const port = await listen(probe);
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

/** {@link plainServer}, bound to one loopback address and port. */
async function plainServerOn(host: string, port: number, greeting: string | null) {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    if (greeting !== null) socket.write(greeting);
  });
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  return { close: () => closeServer(server, sockets) };
}
