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
 * The host *as configured* decides first, and resolution can only ever make
 * the answer stricter:
 *
 *   1. An address literal is local when it is loopback, private or
 *      link-local — {@link isLocalIp}, an allow-list. No lookup.
 *   2. A name can only be local when no public DNS name has its shape:
 *      a single label (`localhost`, a Docker service such as
 *      `protonmail-bridge`), or one under a suffix reserved for local use —
 *      `.localhost` (RFC 6761), `.local` (mDNS, RFC 6762), `.home.arpa`
 *      (RFC 8375) and `.internal` (reserved by ICANN in 2024, the suffix of
 *      `host.docker.internal`). Any other name — `smtp.gmail.com` — requires
 *      STARTTLS and is never resolved here, so no DNS answer, forged or not,
 *      can let a public server's name fall back to plaintext.
 *   3. Such a name is then resolved, and is local only when it has at least
 *      one address and every address is local. That catches the honest way a
 *      short name reaches the internet: a search domain that turns `mail` into
 *      `mail.example.com`. A name that does not resolve is not local.
 *
 * What step 3 does *not* do is make a name of that shape safe against an
 * attacker who can forge its resolution. Such a name is local only by its DNS
 * answer, and whoever forges that answer can point it at an address of their
 * own that passes, then read the plaintext login. A `.local` name is answered
 * by multicast DNS, so that is any peer on the LAN. For a bridge, configure an
 * address literal or a Docker service name (Docker's resolver is inside the
 * host); for anything on the internet, configure its dotted public name, which
 * step 2 never lets fall back.
 *
 * ## The checked address is the one connected to
 *
 * A name allowed plaintext by step 3 is connected to at the address that was
 * checked, never by name. Were the library left to resolve the name again, a
 * resolver that answered the check with a private address and the connect
 * with a public one would get a plaintext `LOGIN` to a public host. So
 * {@link imapTlsOptions} and {@link smtpTlsOptions} hand back the host to
 * connect to: the checked address, with the configured name as `servername`
 * for SNI and the certificate check if the server does offer STARTTLS. One
 * address is pinned, IPv4 first when there is one, since a pinned connection
 * has no second family to fall back to. A name that requires STARTTLS is
 * connected to by name: there, a forged answer only reaches a server that has
 * to present a certificate for that name.
 *
 * The #194 rival-port check (`src/lookup-reachability.ts`) is not affected:
 * it connects and reads a greeting, and never logs in.
 *
 * ## An `http://` CalDAV URL (#247)
 *
 * CalDAV sends the account's Basic credentials with every request, so an
 * `http://` URL is the same exposure, chosen by the operator rather than
 * forced by an attacker. The owner's decision (spec 2026-10-18 §2.14, A) is
 * the same rule: {@link caldavUrlProblem} allows `http://` only to a host
 * {@link localMailAddress} calls local, and `https://` always. The settings
 * form, its JSON route and the wizard refuse anything else before the probe
 * runs; a stored file that holds one still loads (#155), is warned about once
 * at start, and its calendar tools are refused (`src/client-pool.ts`).
 *
 * Unlike IMAP and SMTP, the CalDAV connection is *not* pinned to the checked
 * address: tsdav and the client's own requests go through `fetch`, which
 * resolves the name again. The check is repeated before every calendar tool
 * call, which narrows the gap to milliseconds but does not close it. What is
 * left is a resolver that answers the check privately and the connect
 * publicly, for a name of local form — the same attacker step 3 above already
 * concedes can point such a name at a LAN address of their own.
 */

import net from "node:net";

import { isLocalIp, resolveAddresses } from "./net-address.js";

/** The one thing classification does that leaves the process. Injectable for tests. */
export interface MailTlsDeps {
  /** Every address a hostname has. Rejects if it has none. */
  resolveAddresses(hostname: string): Promise<string[]>;
}

const defaultMailTlsDeps: MailTlsDeps = { resolveAddresses };

/** Where a local host is reached in plaintext: the checked address, and the name it was checked for. */
export interface LocalAddress {
  address: string;
  /** The configured name, normalised; absent when the host was an address literal. */
  name?: string;
}

/**
 * The seam every connection builder takes: where to connect in plaintext when
 * `host` is local, `null` when it is not and `tls: false` must be STARTTLS.
 * {@link localMailAddress} in production; the tests inject `null` to point a
 * public-server code path at a fake server on loopback.
 */
export type LocalAddressCheck = (host: string) => Promise<LocalAddress | null>;

/** The seam, as the probe and both clients take it. Tests only. */
export interface MailTlsTestOptions {
  localAddress?: LocalAddressCheck;
}

/**
 * Suffixes no public DNS name can have. See step 2 in the module header; keep
 * the list there, `docs/HARDENING.md` and the CHANGELOG entry in step with it.
 */
const LOCAL_SUFFIXES = [".localhost", ".local", ".home.arpa", ".internal"];

/** `[::1]` is how an IPv6 literal is written in a URL, and may be typed so. */
function unbracket(host: string): string {
  return host.trim().replace(/^\[(.*)\]$/, "$1");
}

/**
 * Where `host` is reached when it is loopback or private, by the three steps
 * in the module header, or `null`. Resolves a name at most once, and the
 * address it returns is the one that was checked. Never rejects: a lookup
 * that fails is "not local".
 */
export async function localMailAddress(
  host: string,
  deps: MailTlsDeps = defaultMailTlsDeps
): Promise<LocalAddress | null> {
  const literal = unbracket(host);
  if (net.isIP(literal) !== 0) return isLocalIp(literal) ? { address: literal } : null;

  // `localhost.` and `localhost` are one name; the trailing dot only says so.
  const name = literal.toLowerCase().replace(/\.$/, "");
  if (name === "") return null;
  const localByForm = !name.includes(".") || LOCAL_SUFFIXES.some((suffix) => name.endsWith(suffix));
  if (!localByForm) return null;

  let addresses: string[];
  try {
    addresses = await deps.resolveAddresses(name);
  } catch {
    return null;
  }
  if (addresses.length === 0 || !addresses.every((address) => isLocalIp(address))) return null;
  return { address: addresses.find((address) => net.isIPv4(address)) ?? addresses[0]!, name };
}

/**
 * What a save is refused with, and what a calendar tool on a stored account
 * is refused with, when its CalDAV URL is {@link caldavUrlProblem}'s problem.
 */
export const CALDAV_HTTP_MESSAGE =
  "This CalDAV URL is not https:// and its host is not local, so the CalDAV password would cross " +
  "the network unencrypted. Use the server's https:// URL; http:// is only accepted for a " +
  "loopback or private host, such as a Radicale on the same machine.";

/**
 * Why a CalDAV URL must not be used, or `null` when it may (#247): `https://`
 * always may; `http://` may when its host is local by {@link localMailAddress}
 * — an allow-listed literal, or a local-form name that resolves only to local
 * addresses; anything else may not. Never rejects: a lookup that fails is
 * "not local". A string that is no URL at all is not this check's to judge,
 * and is `null`.
 */
export async function caldavUrlProblem(
  url: string,
  deps: MailTlsDeps = defaultMailTlsDeps
): Promise<string | null> {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  if (parsed.protocol === "https:") return null;
  if (parsed.protocol === "http:" && (await localMailAddress(parsed.hostname, deps)) !== null) return null;
  return CALDAV_HTTP_MESSAGE;
}

/** The host and TLS half of an `ImapFlow` options object. */
export interface ImapTlsOptions {
  host: string;
  secure: boolean;
  doSTARTTLS?: true;
  servername?: string;
}

/** The host and TLS half of a nodemailer SMTP transport's options. */
export interface SmtpTlsOptions {
  host: string;
  secure: boolean;
  requireTLS?: true;
  servername?: string;
}

/** Where to connect in opportunistic mode, as either library spells it. */
function pinned(local: LocalAddress): { host: string; servername?: string } {
  return local.name === undefined ? { host: local.address } : { host: local.address, servername: local.name };
}

/**
 * `doSTARTTLS` is left unset rather than `false` on a local host: unset is
 * imapflow's opportunistic mode, which still upgrades when the server offers
 * it; `false` would never upgrade. A `tls: true` account is not classified.
 */
export async function imapTlsOptions(
  host: string,
  tls: boolean,
  check: LocalAddressCheck = localMailAddress
): Promise<ImapTlsOptions> {
  if (tls) return { host, secure: true };
  const local = await check(host);
  return local === null ? { host, secure: false, doSTARTTLS: true } : { ...pinned(local), secure: false };
}

/**
 * On a local host nodemailer's default stands, which upgrades when the server
 * offers STARTTLS. A `tls: true` account is not classified.
 */
export async function smtpTlsOptions(
  host: string,
  tls: boolean,
  check: LocalAddressCheck = localMailAddress
): Promise<SmtpTlsOptions> {
  if (tls) return { host, secure: true };
  const local = await check(host);
  return local === null ? { host, secure: false, requireTLS: true } : { ...pinned(local), secure: false };
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

/**
 * The error to pass on for `err`: {@link STARTTLS_REQUIRED_MESSAGE}, with the
 * library's own error as its `cause`, when it is a STARTTLS refusal; `err`
 * itself otherwise. The one rewording the probe and both clients share.
 */
export function startTlsError(err: unknown): unknown {
  return isStartTlsUnavailable(err) ? new Error(STARTTLS_REQUIRED_MESSAGE, { cause: err }) : err;
}
