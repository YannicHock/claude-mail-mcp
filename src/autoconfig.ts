/**
 * Autoconfig lookup — derive a mailbox's IMAP/SMTP/CalDAV settings from an
 * email address.
 *
 * This is tier 1 of the setup wizard's step-2 cascade (see
 * `docs/planning/specs/2026-09-09-issue-19-setup-wizard.md` §5.3). The wizard
 * asks for an address and a password; only when this module finds nothing does
 * the operator see the provider list, and only then the full mailbox form.
 * Each tier exists so that the next one is not needed.
 *
 * Lookup order, first hit wins:
 *
 *   1. https://autoconfig.<domain>/mail/config-v1.1.xml?emailaddress=<addr>
 *   2. https://<domain>/.well-known/autoconfig/mail/config-v1.1.xml
 *   3. Mozilla ISPDB — https://autoconfig.thunderbird.net/v1.1/<domain>
 *   4. DNS SRV `_imaps._tcp` / `_submission._tcp` (RFC 6186)
 *
 * CalDAV is discovered separately, via `.well-known/caldav` (RFC 6764) and
 * `_caldavs._tcp`. Not finding it is normal, not a failure — CalDAV is
 * optional for this connector.
 *
 * ## The result is a suggestion, not a configuration
 *
 * {@link MailboxSuggestion} deliberately has no password field anywhere in it,
 * and is not an `Account`. It cannot be persisted without going back through
 * the form the operator confirms, because the one thing needed to build an
 * `ImapCreds`/`SmtpCreds` — the password — only ever exists in that form. A
 * wrong autoconfig answer that fails at connect time is far harder to diagnose
 * than one the operator read first, so "shown for confirmation" is enforced by
 * the shape of the type rather than by a comment asking callers to behave.
 *
 * ## This fetches URLs derived from user input
 *
 * `autoconfig.<domain>` is whatever the person setting up the instance typed,
 * so an unconstrained fetch here is server-side request forgery: point the
 * address at a domain whose autoconfig host resolves to 169.254.169.254 and
 * the connector becomes a proxy into its own network. The constraints are
 * therefore part of the contract, not hardening applied afterwards:
 *
 *   - HTTPS only, including after a redirect.
 *   - Resolve first, then refuse loopback, link-local, RFC 1918 and the other
 *     non-public ranges ({@link isPublicIp}). The addresses that passed are
 *     then *pinned* into the request via the `lookup` hook, so the name cannot
 *     resolve to something else between the check and the connect (DNS
 *     rebinding) — the check and the socket see the same answer.
 *   - At most one redirect, re-checked against exactly the same rules.
 *   - {@link PER_ATTEMPT_TIMEOUT_MS} per attempt (a redirect is another
 *     attempt), {@link TOTAL_TIMEOUT_MS} for the whole cascade.
 *   - {@link MAX_RESPONSE_BYTES} of body, after which the socket is destroyed
 *     rather than the buffer grown.
 *
 * Every one of those is best-effort in the same direction: a rejection is
 * indistinguishable, to the caller, from "this domain has no autoconfig".
 * {@link lookupMailboxSettings} never rejects and never reports a reason. The
 * wizard's answer to a failure is the provider list, and an operator cannot
 * act on "the ISPDB returned 502" anyway.
 *
 * No XML parser is pulled in for this (no new runtime dependencies): the
 * clientConfig format is a flat, fixed set of elements and is read with a
 * small scanner below. That also means no entity resolution of any kind
 * happens, which is the actual defence against XXE in a document fetched from
 * a host the operator does not control.
 */

import dns from "node:dns/promises";
import https from "node:https";
import net from "node:net";
import type { LookupFunction } from "node:net";
import type { Readable } from "node:stream";

export const PER_ATTEMPT_TIMEOUT_MS = 3_000;
export const TOTAL_TIMEOUT_MS = 10_000;
export const MAX_RESPONSE_BYTES = 128 * 1024;
export const MAX_REDIRECTS = 1;

const USER_AGENT = "claude-mail-mcp autoconfig";

/** An implicit-TLS socket, or a plaintext one upgraded with STARTTLS. */
export type SocketType = "SSL" | "STARTTLS";

/**
 * One suggested server. Field-for-field the connectable half of `ImapCreds` /
 * `SmtpCreds` from `./accounts.js` — `host`, `port`, `tls`, and the `user` the
 * provider says to log in with — with the credential half missing on purpose.
 */
export interface SuggestedServer {
  host: string;
  port: number;
  /** Implicit TLS from the first byte. STARTTLS is `false`, as `ImapCreds.tls` means. */
  tls: boolean;
  socketType: SocketType;
  user: string;
}

export interface SuggestedCalDav {
  url: string;
  user: string;
  source: "well-known" | "dns-srv";
}

export type SuggestionSource =
  | "autoconfig-subdomain"
  | "autoconfig-well-known"
  | "ispdb"
  | "dns-srv";

/** What the wizard shows for confirmation. Never written anywhere directly. */
export interface MailboxSuggestion {
  email: string;
  domain: string;
  source: SuggestionSource;
  imap: SuggestedServer;
  smtp: SuggestedServer;
  caldav: SuggestedCalDav | null;
}

export interface HttpResponse {
  status: number;
  location: string | null;
  body: string;
}

export interface SrvRecord {
  name: string;
  port: number;
  priority: number;
  weight: number;
}

/**
 * The four things this module does that leave the process. Injectable so the
 * unit tests can drive the cascade, the redirect rules and the address rules
 * against fixtures without any outbound traffic — the guard itself is not part
 * of this seam, so a test that stubs a redirect still exercises the real
 * checks.
 */
export interface AutoconfigDeps {
  /** Every address a hostname has. Rejects if it has none. */
  resolveAddresses(hostname: string): Promise<string[]>;
  /**
   * One HTTPS GET against `url`, connecting only to `addresses`, never
   * following a redirect, with the body capped.
   */
  httpsGet(url: URL, addresses: readonly string[], timeoutMs: number): Promise<HttpResponse>;
  resolveSrv(name: string): Promise<SrvRecord[]>;
}

export interface LookupOptions {
  totalMs?: number;
  perAttemptMs?: number;
  deps?: AutoconfigDeps;
}

// ---------------------------------------------------------------- addresses

/**
 * Is this a public unicast address we are willing to open a connection to?
 *
 * Anything unparseable is `false`: this is the deny-by-default half of
 * resolve-then-refuse, so an address shape we do not recognise must not be
 * treated as safe.
 */
export function isPublicIp(address: string): boolean {
  if (net.isIPv4(address)) return isPublicIpv4(address);
  if (net.isIPv6(address)) return isPublicIpv6(address);
  return false;
}

function isPublicIpv4(address: string): boolean {
  const parts = address.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return false;
  }
  const [a, b] = parts as [number, number, number, number];
  if (a === 0) return false; // "this network"
  if (a === 10) return false; // RFC 1918
  if (a === 127) return false; // loopback
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT, RFC 6598
  if (a === 169 && b === 254) return false; // link-local, incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return false; // RFC 1918
  if (a === 192 && b === 168) return false; // RFC 1918
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking, RFC 2544
  if (a >= 224) return false; // multicast, reserved, broadcast
  return true;
}

function isPublicIpv6(address: string): boolean {
  const groups = expandIpv6(address);
  if (!groups) return false;

  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible addresses reach the v4
  // internet, so they are judged by the v4 rules — otherwise ::ffff:127.0.0.1
  // walks straight past a v6-only check.
  const isMapped = groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff;
  const isCompat = groups.slice(0, 6).every((g) => g === 0) && (groups[6] !== 0 || groups[7] !== 0);
  if (isMapped || isCompat) {
    const hi = groups[6]!;
    const lo = groups[7]!;
    return isPublicIpv4(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`);
  }

  const first = groups[0]!;
  if (groups.every((g) => g === 0)) return false; // ::
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return false; // ::1
  if ((first & 0xfe00) === 0xfc00) return false; // unique local, fc00::/7
  if ((first & 0xffc0) === 0xfe80) return false; // link-local, fe80::/10
  if ((first & 0xffc0) === 0xfec0) return false; // site-local (deprecated)
  if ((first & 0xff00) === 0xff00) return false; // multicast
  return true;
}

/** Expand an IPv6 literal into its eight 16-bit groups, or null if malformed. */
function expandIpv6(address: string): number[] | null {
  let text = address;
  const zone = text.indexOf("%");
  if (zone !== -1) text = text.slice(0, zone);

  // A trailing dotted-quad (::ffff:1.2.3.4) becomes two more groups first.
  const dotted = text.lastIndexOf(":");
  const tail = text.slice(dotted + 1);
  if (tail.includes(".")) {
    if (!net.isIPv4(tail)) return null;
    const octets = tail.split(".").map(Number);
    const hi = ((octets[0]! << 8) | octets[1]!).toString(16);
    const lo = ((octets[2]! << 8) | octets[3]!).toString(16);
    text = `${text.slice(0, dotted + 1)}${hi}:${lo}`;
  }

  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    for (const group of part.split(":")) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
      out.push(parseInt(group, 16));
    }
    return out;
  };
  const head = parse(halves[0]!);
  const rest = halves.length === 2 ? parse(halves[1]!) : [];
  if (!head || !rest) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const fill = 8 - head.length - rest.length;
  if (fill < 0) return null;
  return [...head, ...new Array<number>(fill).fill(0), ...rest];
}

/**
 * The guard every request passes through: HTTPS, then resolve, then refuse
 * anything that is not public. Returns the addresses to pin the connection to,
 * or `null` — one shape for "not allowed" and "could not tell", because the
 * caller treats both the same way.
 *
 * A host with *any* non-public address is refused wholesale rather than having
 * that address filtered out: a name that answers with both a public and an
 * internal address is either misconfigured or hostile, and there is nothing to
 * gain from connecting to the half of it we happen to like.
 */
export async function resolveSafeUrl(
  url: URL,
  deps: AutoconfigDeps,
  timeoutMs: number
): Promise<string[] | null> {
  if (url.protocol !== "https:") return null;
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (!hostname) return null;
  try {
    const addresses = await withTimeout(deps.resolveAddresses(hostname), timeoutMs);
    if (addresses.length === 0) return null;
    if (!addresses.every(isPublicIp)) return null;
    return addresses;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- transport

/**
 * Read a response body, refusing rather than buffering past `maxBytes`. The
 * stream is destroyed on the chunk that crosses the line, so an endless
 * response costs us that chunk and nothing more.
 */
export async function readCapped(stream: Readable, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buf.length;
    if (size > maxBytes) {
      stream.destroy();
      throw new Error(`response too large (over ${maxBytes} bytes)`);
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * The shipped implementations. `httpsGet` pins the connection to the addresses
 * the guard already approved by handing `https.request` a `lookup` that
 * resolves nothing and simply returns them — the Host header and SNI still
 * carry the real name, so virtual hosting and certificate validation work
 * unchanged, but the name is never resolved a second time.
 *
 * `timeout` on the request only fires on socket inactivity, so it is paired
 * with a hard timer that destroys the request outright: the deadline has to
 * bound the whole exchange, not just the gaps in it.
 */
export const defaultDeps: AutoconfigDeps = {
  async resolveAddresses(hostname) {
    const entries = await dns.lookup(hostname, { all: true, verbatim: true });
    return entries.map((entry) => entry.address);
  },

  httpsGet(url, addresses, timeoutMs) {
    return new Promise<HttpResponse>((resolve, reject) => {
      const pinned: LookupFunction = (_hostname, options, callback) => {
        const entries = addresses.map((address) => ({
          address,
          family: net.isIPv6(address) ? 6 : 4,
        }));
        if (options.all) {
          callback(null, entries);
        } else {
          callback(null, entries[0]!.address, entries[0]!.family);
        }
      };

      const req = https.request(
        {
          hostname: url.hostname,
          port: url.port === "" ? 443 : Number(url.port),
          path: `${url.pathname}${url.search}`,
          method: "GET",
          servername: url.hostname,
          headers: {
            "user-agent": USER_AGENT,
            accept: "application/xml, text/xml, */*",
            "accept-encoding": "identity",
          },
          lookup: pinned,
          timeout: timeoutMs,
        },
        (res) => {
          const status = res.statusCode ?? 0;
          const location = typeof res.headers.location === "string" ? res.headers.location : null;
          if (status >= 300 && status < 400) {
            // Nothing in a redirect body is of any use, and reading it is one
            // more chance for a hostile host to spend our budget.
            res.resume();
            resolve({ status, location, body: "" });
            return;
          }
          readCapped(res, MAX_RESPONSE_BYTES).then(
            (body) => resolve({ status, location, body }),
            (err) => reject(err)
          );
        }
      );

      const hardStop = setTimeout(() => {
        req.destroy(new Error(`autoconfig request timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      hardStop.unref?.();

      req.on("timeout", () => req.destroy(new Error("autoconfig request stalled")));
      req.on("error", (err) => {
        clearTimeout(hardStop);
        reject(err);
      });
      req.on("close", () => clearTimeout(hardStop));
      req.end();
    });
  },

  async resolveSrv(name) {
    const records = await dns.resolveSrv(name);
    return records.map((r) => ({
      name: r.name,
      port: r.port,
      priority: r.priority,
      weight: r.weight,
    }));
  },
};

/**
 * Stop waiting on `promise` after `ms`. As in `probe.ts`, this only stops
 * watching — the transport above enforces its own copy of the same deadline,
 * which is what actually tears the socket down. `dns.lookup` cannot be
 * cancelled at all (getaddrinfo runs on the threadpool), so for the resolve
 * step this is genuinely all there is; the work is bounded and inert, and the
 * cascade has already moved on.
 */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer!: NodeJS.Timeout;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, expiry]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The two deadlines from §5.3, in one object: a per-attempt slice, never
 * longer than what is left of the cascade's overall budget. `null` means the
 * cascade is out of time and the caller should stop.
 */
class Budget {
  private readonly endsAt: number;

  constructor(
    totalMs: number,
    private readonly perAttemptMs: number
  ) {
    this.endsAt = Date.now() + totalMs;
  }

  slice(): number | null {
    const remaining = this.endsAt - Date.now();
    if (remaining <= 0) return null;
    return Math.min(this.perAttemptMs, remaining);
  }
}

interface Hop {
  url: URL;
  status: number;
  location: string | null;
  body: string;
}

/**
 * A guarded GET, following at most `maxRedirects` hops. Every hop — the first
 * one included — goes through {@link resolveSafeUrl} again, so a redirect is
 * held to exactly the rules the original URL was: https, resolvable, public.
 * Each hop is its own attempt and gets its own slice of the budget.
 */
async function getGuarded(
  start: URL,
  deps: AutoconfigDeps,
  budget: Budget,
  maxRedirects: number
): Promise<Hop | null> {
  let url = start;
  for (let hop = 0; ; hop++) {
    const slice = budget.slice();
    if (slice === null) return null;

    const addresses = await resolveSafeUrl(url, deps, slice);
    if (!addresses) return null;

    let response: HttpResponse;
    try {
      response = await withTimeout(deps.httpsGet(url, addresses, slice), slice);
    } catch {
      return null;
    }

    const redirecting = response.status >= 300 && response.status < 400;
    if (!redirecting || hop >= maxRedirects || !response.location) {
      return { url, status: response.status, location: response.location, body: response.body };
    }

    let next: URL;
    try {
      next = new URL(response.location, url);
    } catch {
      return null;
    }
    url = next;
  }
}

// ---------------------------------------------------------- the address itself

interface Address {
  full: string;
  local: string;
  domain: string;
}

const LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/** A hostname we are willing to put in a URL or show as a suggestion. */
function isHostname(value: string): boolean {
  if (value.length === 0 || value.length > 253) return false;
  const labels = value.toLowerCase().split(".");
  if (labels.length < 2) return false;
  return labels.every((label) => label.length <= 63 && LABEL.test(label));
}

/**
 * Split an address, refusing anything this module should not build a URL from.
 * Deliberately stricter than RFC 5321 — an address literal (`user@[10.0.0.1]`)
 * or a single-label domain (`user@localhost`) is a perfectly valid address and
 * exactly the shape that turns this lookup into an internal port scanner, and
 * neither has an autoconfig endpoint to find in the first place.
 */
function parseAddress(email: string): Address | null {
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) return null;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1).toLowerCase();
  if (local.length > 64 || !/^[^\s@]+$/.test(local)) return null;
  if (!isHostname(domain)) return null;
  return { full: `${local}@${domain}`, local, domain };
}

// ---------------------------------------------------------- clientConfig XML

interface ServerCandidate {
  host: string;
  port: number;
  socketType: SocketType;
  username: string | null;
  passwordAuth: boolean;
}

/** Strip everything that is markup noise rather than an element we read. */
function stripNoise(xml: string): string {
  return xml
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\?[\s\S]*?\?>/g, "")
    .replace(/<!DOCTYPE[^>[]*(\[[\s\S]*?\])?[^>]*>/gi, "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = parseInt(body.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (body.startsWith("#")) {
      const code = parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[body.toLowerCase()] ?? match;
  });
}

function childText(block: string, tag: string): string | null {
  const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "i").exec(block);
  return match ? decodeEntities(match[1]!).trim() : null;
}

function childTexts(block: string, tag: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "gi");
  let match: RegExpExecArray | null;
  while ((match = re.exec(block)) !== null) out.push(decodeEntities(match[1]!).trim());
  return out;
}

function attribute(attrs: string, name: string): string | null {
  const match = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(attrs);
  return match ? (match[2] ?? match[3] ?? null) : null;
}

function blocks(xml: string, tag: string): Array<{ attrs: string; inner: string }> {
  const out: Array<{ attrs: string; inner: string }> = [];
  const re = new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)</${tag}>`, "gi");
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml)) !== null) out.push({ attrs: match[1]!, inner: match[2]! });
  return out;
}

/**
 * `plain` is dropped rather than downgraded to: suggesting an unencrypted
 * mail connection because a document asked for one is not a suggestion worth
 * putting in front of an operator.
 */
function toSocketType(value: string | null): SocketType | null {
  switch (value?.trim().toUpperCase()) {
    case "SSL":
    case "TLS":
      return "SSL";
    case "STARTTLS":
      return "STARTTLS";
    default:
      return null;
  }
}

function toCandidate(inner: string): ServerCandidate | null {
  const host = childText(inner, "hostname");
  const portText = childText(inner, "port");
  const socketType = toSocketType(childText(inner, "socketType"));
  if (!host || !portText || !socketType) return null;
  if (!isHostname(host)) return null;
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  const auth = childTexts(inner, "authentication").map((a) => a.toLowerCase());
  return {
    host,
    port,
    socketType,
    username: childText(inner, "username"),
    // No entry at all is the common case in hand-written documents and means
    // "a password", which is the only thing this connector can do anyway.
    passwordAuth: auth.length === 0 || auth.some((a) => a.startsWith("password") || a === "plain"),
  };
}

/** Implicit TLS beats STARTTLS; a server we can log into beats one we cannot. */
function best(candidates: ServerCandidate[]): ServerCandidate | null {
  const score = (c: ServerCandidate): number =>
    (c.passwordAuth ? 4 : 0) + (c.socketType === "SSL" ? 2 : 1);
  return [...candidates].sort((a, b) => score(b) - score(a))[0] ?? null;
}

function resolveUsername(template: string | null, address: Address): string {
  if (!template) return address.full;
  const filled = template
    .replace(/%EMAILADDRESS%/gi, address.full)
    .replace(/%EMAILLOCALPART%/gi, address.local)
    .replace(/%EMAILDOMAIN%/gi, address.domain);
  return filled.trim().length > 0 ? filled : address.full;
}

function toServer(candidate: ServerCandidate, address: Address): SuggestedServer {
  return {
    host: candidate.host,
    port: candidate.port,
    tls: candidate.socketType === "SSL",
    socketType: candidate.socketType,
    user: resolveUsername(candidate.username, address),
  };
}

/**
 * Read a Mozilla clientConfig document. Returns null unless it yields *both*
 * an IMAP and an SMTP server: half a suggestion would send the operator to the
 * full form anyway, having first shown them a screen implying otherwise.
 */
export function parseClientConfig(
  xml: string,
  email: string
): { imap: SuggestedServer; smtp: SuggestedServer } | null {
  const address = parseAddress(email);
  if (!address) return null;
  if (!/<clientConfig\b/i.test(xml)) return null;

  const doc = stripNoise(xml);
  const incoming = blocks(doc, "incomingServer")
    .filter((b) => attribute(b.attrs, "type")?.toLowerCase() === "imap")
    .map((b) => toCandidate(b.inner))
    .filter((c): c is ServerCandidate => c !== null);
  const outgoing = blocks(doc, "outgoingServer")
    .filter((b) => {
      const type = attribute(b.attrs, "type")?.toLowerCase();
      return type === undefined || type === null || type === "smtp";
    })
    .map((b) => toCandidate(b.inner))
    .filter((c): c is ServerCandidate => c !== null);

  const imap = best(incoming);
  const smtp = best(outgoing);
  if (!imap || !smtp) return null;
  return { imap: toServer(imap, address), smtp: toServer(smtp, address) };
}

// ------------------------------------------------------------------ DNS SRV

/** RFC 2782 ordering, reduced to what a suggestion needs: the best one. */
function bestSrv(records: SrvRecord[]): SrvRecord | null {
  const usable = records.filter((r) => r.name !== "." && isHostname(r.name));
  if (usable.length === 0) return null;
  return [...usable].sort((a, b) => a.priority - b.priority || b.weight - a.weight)[0] ?? null;
}

async function lookupSrv(
  name: string,
  deps: AutoconfigDeps,
  budget: Budget
): Promise<SrvRecord | null> {
  const slice = budget.slice();
  if (slice === null) return null;
  try {
    return bestSrv(await withTimeout(deps.resolveSrv(name), slice));
  } catch {
    return null;
  }
}

/**
 * RFC 6186. The hosts that come back are shown for confirmation and connected
 * to later by `probe.ts` on the operator's say-so; unlike the URLs above they
 * are never fetched by this module, so they are checked for shape rather than
 * for where they resolve.
 */
async function fromSrv(
  address: Address,
  deps: AutoconfigDeps,
  budget: Budget
): Promise<{ imap: SuggestedServer; smtp: SuggestedServer } | null> {
  const imapRecord = await lookupSrv(`_imaps._tcp.${address.domain}`, deps, budget);
  if (!imapRecord) return null;

  // `_submissions` is implicit TLS (RFC 8314), `_submission` is STARTTLS.
  const implicit = await lookupSrv(`_submissions._tcp.${address.domain}`, deps, budget);
  const starttls = implicit ? null : await lookupSrv(`_submission._tcp.${address.domain}`, deps, budget);
  const smtpRecord = implicit ?? starttls;
  if (!smtpRecord) return null;

  return {
    imap: {
      host: imapRecord.name,
      port: imapRecord.port,
      tls: true,
      socketType: "SSL",
      user: address.full,
    },
    smtp: {
      host: smtpRecord.name,
      port: smtpRecord.port,
      tls: implicit !== null,
      socketType: implicit !== null ? "SSL" : "STARTTLS",
      user: address.full,
    },
  };
}

// ------------------------------------------------------------------- CalDAV

/** Statuses that mean "there is a CalDAV service here", 401 very much included. */
const CALDAV_PRESENT = new Set([200, 207, 401, 403, 405]);

/**
 * RFC 6764 discovery. The redirect from `/.well-known/caldav` *is* the answer,
 * so it is read rather than followed — but the target is still put through the
 * same guard, because a suggestion pointing at an internal host is one the
 * operator would be confirming blind.
 */
async function findCalDav(
  address: Address,
  deps: AutoconfigDeps,
  budget: Budget
): Promise<SuggestedCalDav | null> {
  let wellKnown: URL;
  try {
    wellKnown = new URL(`https://${address.domain}/.well-known/caldav`);
  } catch {
    return null;
  }

  const hop = await getGuarded(wellKnown, deps, budget, 0);
  if (hop) {
    if (hop.status >= 300 && hop.status < 400 && hop.location) {
      try {
        const target = new URL(hop.location, hop.url);
        const slice = budget.slice();
        if (slice !== null && (await resolveSafeUrl(target, deps, slice))) {
          return { url: target.toString(), user: address.full, source: "well-known" };
        }
      } catch {
        // Fall through to SRV.
      }
    } else if (CALDAV_PRESENT.has(hop.status)) {
      return { url: hop.url.toString(), user: address.full, source: "well-known" };
    }
  }

  const record = await lookupSrv(`_caldavs._tcp.${address.domain}`, deps, budget);
  if (!record) return null;
  const authority = record.port === 443 ? record.name : `${record.name}:${record.port}`;
  return { url: `https://${authority}/`, user: address.full, source: "dns-srv" };
}

// ------------------------------------------------------------- the cascade

async function fetchClientConfig(
  url: URL,
  address: Address,
  deps: AutoconfigDeps,
  budget: Budget
): Promise<{ imap: SuggestedServer; smtp: SuggestedServer } | null> {
  const hop = await getGuarded(url, deps, budget, MAX_REDIRECTS);
  if (!hop || hop.status < 200 || hop.status >= 300) return null;
  return parseClientConfig(hop.body, address.full);
}

/**
 * Look up `email`'s mailbox settings. Resolves with a {@link MailboxSuggestion}
 * to show the operator for confirmation, or with `null` — which is not an
 * error and carries no reason, because the wizard's response to it is simply
 * the provider list. Never rejects, and never takes longer than `totalMs`
 * (default {@link TOTAL_TIMEOUT_MS}) plus the time to unwind.
 */
export async function lookupMailboxSettings(
  email: string,
  opts: LookupOptions = {}
): Promise<MailboxSuggestion | null> {
  const deps = opts.deps ?? defaultDeps;
  const budget = new Budget(opts.totalMs ?? TOTAL_TIMEOUT_MS, opts.perAttemptMs ?? PER_ATTEMPT_TIMEOUT_MS);

  try {
    const address = parseAddress(email);
    if (!address) return null;

    const tiers: Array<{ source: SuggestionSource; url: URL }> = [
      {
        source: "autoconfig-subdomain",
        url: new URL(
          `https://autoconfig.${address.domain}/mail/config-v1.1.xml?emailaddress=${encodeURIComponent(address.full)}`
        ),
      },
      {
        source: "autoconfig-well-known",
        url: new URL(`https://${address.domain}/.well-known/autoconfig/mail/config-v1.1.xml`),
      },
      {
        source: "ispdb",
        url: new URL(`https://autoconfig.thunderbird.net/v1.1/${encodeURIComponent(address.domain)}`),
      },
    ];

    let source: SuggestionSource = "dns-srv";
    let servers: { imap: SuggestedServer; smtp: SuggestedServer } | null = null;
    for (const tier of tiers) {
      servers = await fetchClientConfig(tier.url, address, deps, budget);
      if (servers) {
        source = tier.source;
        break;
      }
    }
    if (!servers) servers = await fromSrv(address, deps, budget);
    if (!servers) return null;

    return {
      email: address.full,
      domain: address.domain,
      source,
      imap: servers.imap,
      smtp: servers.smtp,
      caldav: await findCalDav(address, deps, budget),
    };
  } catch {
    // Best-effort by contract: no autoconfig failure is ever surfaced to the
    // operator as an error, so an unforeseen one is not surfaced either.
    return null;
  }
}
