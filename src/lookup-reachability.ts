/**
 * Does a suggested mail server answer from this host at all? (#194)
 *
 * The address lookup can find several candidates for one service — the ISPDB's
 * `smtp.gmail.com:465` and the provider table's `:587`, say — and a host whose
 * outbound 465 is filtered (Hetzner's is) can reach only one of them. This is
 * the check that tells them apart before the operator is shown either.
 *
 * It is a connect, never a login. At lookup time the operator has typed a
 * password, but spending an authentication attempt per candidate against a
 * provider that rate-limits failed logins is a hazard of its own, and "the host
 * answered" is the half of the question a filtered port fails anyway. So:
 *
 * - **Implicit TLS** answers when the TLS handshake completes *and verifies*
 *   against the host name, exactly as the real connection later will. A
 *   certificate that would fail there must not win here, so verification is
 *   never switched off to find out.
 * - **STARTTLS** answers when the server greets as a mail server does —
 *   `220` for SMTP, `* OK` for IMAP. STARTTLS itself is not negotiated: the
 *   greeting already proves the port is open and a mail server is behind it.
 *
 * `addresses` are the ones the caller already resolved and checked, and they
 * are connected to directly, in order, so the name is never resolved a second
 * time between the check and the socket. Always resolves; never throws.
 */

import net from "node:net";
import tls from "node:tls";

import type { SocketType } from "./autoconfig.js";

export interface ReachTarget {
  host: string;
  port: number;
  socketType: SocketType;
}

/** What a mail server says first on a plaintext port, SMTP or IMAP. */
const MAIL_GREETING = /^(220[ -]|\* OK)/;

export async function reachable(
  target: ReachTarget,
  addresses: readonly string[],
  timeoutMs: number,
  opts: { ca?: string | Buffer } = {}
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (const address of addresses) {
    const left = deadline - Date.now();
    if (left <= 0) return false;
    if (await answersAt(target, address, left, opts)) return true;
  }
  return false;
}

function answersAt(
  target: ReachTarget,
  address: string,
  timeoutMs: number,
  opts: { ca?: string | Buffer }
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let socket: net.Socket;
    const finish = (answer: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(answer);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();

    if (target.socketType === "SSL") {
      socket = tls.connect({
        host: address,
        port: target.port,
        servername: target.host,
        ...(opts.ca === undefined ? {} : { ca: opts.ca }),
      });
      socket.once("secureConnect", () => finish((socket as tls.TLSSocket).authorized));
    } else {
      socket = net.connect({ host: address, port: target.port });
      let greeting = "";
      socket.on("data", (chunk: Buffer) => {
        greeting += chunk.toString("latin1");
        if (greeting.length >= 5 || greeting.includes("\n")) finish(MAIL_GREETING.test(greeting));
      });
    }
    socket.once("error", () => finish(false));
    socket.once("close", () => finish(false));
  });
}
