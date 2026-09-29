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
 * are connected to directly, so the name is never resolved a second time
 * between the check and the socket. All of them at once, and the first that
 * answers decides: tried one after another under one deadline, an IPv6 route
 * that drops SYNs rather than refusing them — which `dns.lookup` can list
 * first — spent the whole slice, and a port that answers over IPv4 came back
 * as unreachable as the filtered one. Always resolves; never throws.
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
  if (addresses.length === 0) return false;
  return new Promise<boolean>((resolve) => {
    let pending = addresses.length;
    for (const address of addresses) {
      void answersAt(target, address, timeoutMs, opts).then((answered) => {
        pending -= 1;
        if (answered) resolve(true);
        else if (pending === 0) resolve(false);
      });
    }
  });
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
    // `on`, not `once`: a socket can report a second error after the first has
    // settled this, and an emitter with no 'error' listener left rethrows it
    // as an uncaught exception — the process, not this check. `finish` is
    // idempotent, so the listener stays for the socket's whole life.
    socket.on("error", () => finish(false));
    socket.once("close", () => finish(false));
  });
}
