/**
 * What `tls: false` means on the wire, for every IMAP and SMTP connection the
 * connector makes with a password (#220).
 *
 * In the account model `tls: false` only says "not implicit TLS". Both
 * libraries read that as *opportunistic* STARTTLS: upgrade if the server
 * offers it, log in in cleartext if it does not. An on-path attacker who
 * strips `STARTTLS` from the server's capabilities gets the password. #194
 * made that path the ordinary one, since it suggests `smtp.gmail.com:587` on
 * hosts that filter 465.
 *
 * The owner's decision on #220 (option 3): `tls: false` requires STARTTLS
 * unless the host is loopback or private. No schema change and no migration;
 * GreenMail on loopback, which the integration suite speaks plaintext to, and
 * a local bridge keep working. A server that then does not offer STARTTLS is
 * refused before `LOGIN`/`AUTH` — imapflow's `doSTARTTLS: true`, nodemailer's
 * `requireTLS: true` — and the refusal says why ({@link STARTTLS_REQUIRED_MESSAGE}).
 *
 * ## Which hosts are local
 *
 * The rule has to hold against an attacker who can alter traffic, and DNS is
 * traffic. So the host *as configured* decides first, and resolution can only
 * ever make the answer stricter:
 *
 *   1. An address literal is local when it is not public, by the same
 *      {@link isPublicIp} the #194 lookup uses to refuse connecting anywhere
 *      internal: loopback, RFC 1918, link-local, unique local, CGNAT. No
 *      lookup; there is nothing to look up.
 *   2. A name can only be local when no public DNS name has its shape:
 *      a single label (`localhost`, a Docker service such as
 *      `protonmail-bridge`), or one under a suffix reserved for local use —
 *      `.localhost` (RFC 6761), `.local` (mDNS, RFC 6762), `.home.arpa`
 *      (RFC 8375) and `.internal` (reserved by ICANN in 2024, the suffix of
 *      `host.docker.internal`). Any other name — `smtp.gmail.com` — requires
 *      STARTTLS and is never resolved here, so no DNS answer, forged or not,
 *      can let a public server's name fall back to plaintext.
 *   3. Such a name is then resolved, and is local only when it has at least
 *      one address and every address is not public. That catches the one
 *      honest way a short name reaches the internet: a search domain that
 *      turns `mail` into `mail.example.com`. A name that does not resolve is
 *      not local, which costs nothing, since the connection would fail too.
 *
 * ## The checked address is the one connected to
 *
 * A name allowed plaintext by step 3 is connected to at the address that was
 * checked, never by name. Were the library left to resolve the name again, a
 * resolver that answered the check with a private address and the connect
 * with a public one would get a plaintext `LOGIN` to a public host — the very
 * downgrade this module exists to stop. So {@link imapTlsOptions} and
 * {@link smtpTlsOptions} hand back the host to connect to: the checked address
 * with the configured name kept as `servername`, for SNI and the certificate
 * check if the server does offer STARTTLS. One address is pinned, IPv4 first
 * when there is one, since a pinned connection has no second family to fall
 * back to. A name that requires STARTTLS is connected to by name, as before:
 * there, a forged answer only reaches a server that has to present a
 * certificate for that name.
 *
 * The #194 rival-port check (`src/lookup-reachability.ts`) is not affected:
 * it connects and reads a greeting, and never logs in.
 */

import dns from "node:dns/promises";
import net from "node:net";

import { isPublicIp } from "./autoconfig.js";

/** The one thing classification does that leaves the process. Injectable for tests. */
export interface MailTlsDeps {
  /** Every address a hostname has. Rejects if it has none. */
  resolveAddresses(hostname: string): Promise<string[]>;
}

export const defaultMailTlsDeps: MailTlsDeps = {
  async resolveAddresses(hostname) {
    const entries = await dns.lookup(hostname, { all: true, verbatim: true });
    return entries.map((entry) => entry.address);
  },
};

/**
 * The seam every connection builder takes: the address to connect to in
 * plaintext when `host` is local, `null` when it is not and `tls: false` must
 * be STARTTLS. {@link localMailAddress} in production; the tests inject `null`
 * to point a public-server code path at a fake server on loopback.
 */
export type LocalAddressCheck = (host: string) => Promise<string | null>;

/** Suffixes no public DNS name can have. See step 2 in the module header. */
const LOCAL_SUFFIXES = [".localhost", ".local", ".home.arpa", ".internal"];

/**
 * The address `host` is reached at when it is loopback or private, by the
 * three steps in the module header, or `null`. Resolves a name at most once,
 * and the address it returns is the one that was checked. Never rejects: a
 * lookup that fails is "not local".
 */
export async function localMailAddress(
  host: string,
  deps: MailTlsDeps = defaultMailTlsDeps
): Promise<string | null> {
  // `[::1]` is how an IPv6 literal is written in a URL, and may be typed so.
  const unbracketed = host.trim().replace(/^\[(.*)\]$/, "$1");
  if (net.isIP(unbracketed) !== 0) return isPublicIp(unbracketed) ? null : unbracketed;

  // `localhost.` and `localhost` are one name; the trailing dot only says so.
  const name = unbracketed.toLowerCase().replace(/\.$/, "");
  if (name === "") return null;
  const localByForm = !name.includes(".") || LOCAL_SUFFIXES.some((suffix) => name.endsWith(suffix));
  if (!localByForm) return null;

  let addresses: string[];
  try {
    addresses = await deps.resolveAddresses(name);
  } catch {
    return null;
  }
  if (addresses.length === 0 || addresses.some((address) => isPublicIp(address))) return null;
  return addresses.find((address) => net.isIPv4(address)) ?? addresses[0]!;
}

/** Where to connect, for a `tls: false` account. */
interface Endpoint {
  host: string;
  /** The configured name, when `host` is the address it was checked at. */
  servername?: string;
}

/**
 * `null` when `tls: false` must mean STARTTLS for `host`; otherwise where to
 * connect in opportunistic mode. Never asks about a `tls: true` account:
 * implicit TLS has nothing to fall back from, and is connected to by name.
 */
async function plaintextEndpoint(host: string, check: LocalAddressCheck): Promise<Endpoint | null> {
  const address = await check(host);
  if (address === null) return null;
  // A literal comes back as itself (unbracketed); only a resolved name needs
  // its name carried beside the address.
  return address === host.trim().replace(/^\[(.*)\]$/, "$1")
    ? { host: address }
    : { host: address, servername: host };
}

/**
 * The host and TLS half of an `ImapFlow` options object. `doSTARTTLS` is left
 * unset rather than `false` on a local host: unset is imapflow's opportunistic
 * mode, which still upgrades when the server offers it; `false` would never
 * upgrade.
 */
export async function imapTlsOptions(
  host: string,
  tls: boolean,
  check: LocalAddressCheck = localMailAddress
): Promise<{ host: string; secure: boolean; doSTARTTLS?: true; servername?: string }> {
  if (tls) return { host, secure: true };
  const local = await plaintextEndpoint(host, check);
  return local === null ? { host, secure: false, doSTARTTLS: true } : { ...local, secure: false };
}

/**
 * The host and TLS half of a nodemailer SMTP transport's options. On a local
 * host nodemailer's default stands, which upgrades when the server offers
 * STARTTLS.
 */
export async function smtpTlsOptions(
  host: string,
  tls: boolean,
  check: LocalAddressCheck = localMailAddress
): Promise<{ host: string; secure: boolean; requireTLS?: true; servername?: string }> {
  if (tls) return { host, secure: true };
  const local = await plaintextEndpoint(host, check);
  return local === null ? { host, secure: false, requireTLS: true } : { ...local, secure: false };
}

/**
 * What the probe and both clients report when a server is refused for this.
 * A fixed string: the libraries' own wording ("Server does not support
 * STARTTLS") says what happened but not why it is an error, nor what to do.
 */
export const STARTTLS_REQUIRED_MESSAGE =
  "the server does not offer STARTTLS, and with TLS off a server that is not local is only " +
  "used over STARTTLS: turn TLS on (993 for IMAP, 465 for SMTP) or use a server that offers it";

/**
 * True for the error each library raises when STARTTLS was required and the
 * server did not offer it, or refused it when asked. Read by shape, like
 * `shared/credential-failure.ts` reads imapflow's errors.
 *
 * Not for a TLS handshake that failed after the server agreed — an untrusted
 * certificate, say. The server did offer STARTTLS there, and the library's own
 * message names what went wrong.
 */
export function isStartTlsUnavailable(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const fields = err as Error & { tlsFailed?: unknown; code?: unknown; command?: unknown };
  // imapflow's `_failSTARTTLS()`: not in CAPABILITY, or STARTTLS answered NO/BAD.
  if (fields.tlsFailed === true && err.message === "Server does not support STARTTLS") return true;
  // nodemailer's `_actionSTARTTLS()`: STARTTLS answered with anything but 2xx.
  if (
    fields.code === "ETLS" &&
    fields.command === "STARTTLS" &&
    err.message.startsWith("Error upgrading connection with STARTTLS")
  ) {
    return true;
  }
  // nodemailer's `_actionEHLO()`: no EHLO, and HELO has no STARTTLS at all.
  return err.message.startsWith("EHLO failed but HELO does not support required STARTTLS");
}
