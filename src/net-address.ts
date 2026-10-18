/**
 * What an IP address is, for the two places that decide something by it: the
 * #194 lookup, which refuses to connect anywhere that is not public
 * (`src/autoconfig.ts`), and `tls: false`, which allows plaintext only to an
 * address that is local (`src/mail-tls.ts`, #220).
 *
 * The two questions are not each other's negation, and the two answers here
 * deliberately differ. {@link isPublicIp} is a refuse-by-default guard: what it
 * does not recognise as public is refused, so "not public" is everything from
 * loopback to multicast to a shape it cannot parse. {@link isLocalIp} is an
 * allow-list for the opposite stake — being *allowed* is what costs something
 * there, a password in cleartext — so it names the loopback, private and
 * link-local ranges and nothing else. `0.0.0.0`, `::`, CGNAT, the benchmarking
 * range, reserved, broadcast and multicast are neither public nor local.
 */

import dns from "node:dns/promises";
import net from "node:net";

/** Every address a hostname has, in the resolver's own order. Rejects if it has none. */
export async function resolveAddresses(hostname: string): Promise<string[]> {
  const entries = await dns.lookup(hostname, { all: true, verbatim: true });
  return entries.map((entry) => entry.address);
}

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

/**
 * Is this address on this machine or a private network: loopback (127/8,
 * `::1`), RFC 1918 (10/8, 172.16/12, 192.168/16), link-local (169.254/16,
 * fe80::/10) or unique local (fc00::/7), or the IPv4-mapped form of one?
 *
 * An allow-list, unlike {@link isPublicIp}: anything else, unparseable
 * included, is `false`.
 */
export function isLocalIp(address: string): boolean {
  if (net.isIPv4(address)) return isLocalIpv4(address);
  if (!net.isIPv6(address)) return false;
  const groups = expandIpv6(address);
  if (!groups) return false;
  const v4 = mappedIpv4(groups);
  if (v4 !== null) return isLocalIpv4(v4);
  const first = groups[0]!;
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true; // ::1
  if ((first & 0xfe00) === 0xfc00) return true; // unique local, fc00::/7
  if ((first & 0xffc0) === 0xfe80) return true; // link-local, fe80::/10
  return false;
}

function ipv4Octets(address: string): [number, number, number, number] | null {
  const parts = address.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return null;
  }
  return parts as [number, number, number, number];
}

function isLocalIpv4(address: string): boolean {
  const octets = ipv4Octets(address);
  if (!octets) return false;
  const [a, b] = octets;
  if (a === 127) return true; // loopback
  if (a === 10) return true; // RFC 1918
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC 1918
  if (a === 192 && b === 168) return true; // RFC 1918
  if (a === 169 && b === 254) return true; // link-local
  return false;
}

function isPublicIpv4(address: string): boolean {
  const octets = ipv4Octets(address);
  if (!octets) return false;
  const [a, b] = octets;
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
  const v4 = mappedIpv4(groups);
  if (v4 !== null) return isPublicIpv4(v4);

  const first = groups[0]!;
  if (groups.every((g) => g === 0)) return false; // ::
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return false; // ::1
  if ((first & 0xfe00) === 0xfc00) return false; // unique local, fc00::/7
  if ((first & 0xffc0) === 0xfe80) return false; // link-local, fe80::/10
  if ((first & 0xffc0) === 0xfec0) return false; // site-local (deprecated)
  if ((first & 0xff00) === 0xff00) return false; // multicast
  return true;
}

/**
 * The IPv4 address an IPv4-mapped (`::ffff:a.b.c.d`) or IPv4-compatible
 * (`::a.b.c.d`, not `::` or `::1`) address carries, or null.
 */
function mappedIpv4(groups: number[]): string | null {
  const isMapped = groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff;
  const isCompat =
    groups.slice(0, 6).every((g) => g === 0) &&
    (groups[6] !== 0 || groups[7] !== 0) &&
    !(groups[6] === 0 && groups[7] === 1);
  if (!isMapped && !isCompat) return null;
  const hi = groups[6]!;
  const lo = groups[7]!;
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
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
