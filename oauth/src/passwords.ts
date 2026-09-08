/**
 * Operator password hashing, using scrypt from `node:crypto`.
 *
 * Why not bcrypt or argon2: both would add a dependency, and the argon2 bindings
 * need a native build that `node:22-alpine` cannot do without adding a toolchain
 * to the image. scrypt is memory-hard, ships with Node, and this service verifies
 * one password at interactive rates — there is no throughput argument for anything
 * faster. The hash is produced by `npm run hash-password` and pasted into a mounted
 * secret; nothing here ever writes it.
 *
 * Format: `scrypt$N$r$p$<salt base64url>$<hash base64url>`, self-describing so the
 * cost parameters can be raised later without invalidating existing hashes.
 */

import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number }
) => Promise<Buffer>;

/** Cost parameters for newly generated hashes. */
export const DEFAULT_PARAMS = { N: 2 ** 16, r: 8, p: 1 } as const;

const KEY_LENGTH = 32;
const SALT_LENGTH = 16;

/**
 * Node's default `maxmem` is 32 MiB, which N=2^16, r=8 exceeds (128 * N * r is
 * 64 MiB). Passed explicitly with headroom so raising N later does not turn into
 * an opaque "Invalid scrypt params" at startup.
 */
function maxmemFor(N: number, r: number): number {
  return Math.max(32 * 1024 * 1024, 256 * N * r);
}

export interface ScryptParams {
  N: number;
  r: number;
  p: number;
}

interface ParsedHash extends ScryptParams {
  salt: Buffer;
  hash: Buffer;
}

/** Hash a password for storage. Returns the full `scrypt$...` encoded string. */
export async function hashPassword(
  password: string,
  params: ScryptParams = DEFAULT_PARAMS
): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const derived = await scrypt(password.normalize("NFKC"), salt, KEY_LENGTH, {
    ...params,
    maxmem: maxmemFor(params.N, params.r),
  });
  return [
    "scrypt",
    params.N,
    params.r,
    params.p,
    salt.toString("base64url"),
    derived.toString("base64url"),
  ].join("$");
}

/**
 * Parse an encoded hash. Returns null for anything malformed rather than throwing,
 * so a corrupt secret file becomes a startup validation error with a useful message
 * instead of a stack trace on the first login attempt.
 */
export function parseHash(encoded: string): ParsedHash | null {
  const parts = encoded.trim().split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return null;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!isPositiveInteger(N) || !isPositiveInteger(r) || !isPositiveInteger(p)) {
    return null;
  }
  // N must be a power of two greater than 1, or scrypt rejects it at call time.
  if (N < 2 || (N & (N - 1)) !== 0) return null;

  const salt = Buffer.from(parts[4], "base64url");
  const hash = Buffer.from(parts[5], "base64url");
  if (salt.length === 0 || hash.length === 0) return null;

  return { N, r, p, salt, hash };
}

/** True when `encoded` is a hash this module can verify against. */
export function isValidHashFormat(encoded: string): boolean {
  return parseHash(encoded) !== null;
}

/**
 * Verify a password against an encoded hash in constant time with respect to the
 * hash contents. Returns false — never throws — for a malformed hash.
 */
export async function verifyPassword(
  password: string,
  encoded: string
): Promise<boolean> {
  const parsed = parseHash(encoded);
  if (!parsed) return false;

  let derived: Buffer;
  try {
    derived = await scrypt(
      password.normalize("NFKC"),
      parsed.salt,
      parsed.hash.length,
      {
        N: parsed.N,
        r: parsed.r,
        p: parsed.p,
        maxmem: maxmemFor(parsed.N, parsed.r),
      }
    );
  } catch {
    return false;
  }
  if (derived.length !== parsed.hash.length) return false;
  return timingSafeEqual(derived, parsed.hash);
}

/**
 * Compare two strings without leaking their contents through timing. Used for the
 * username, so that a wrong username and a wrong password cost the same.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) {
    // Still do a comparison so the early return does not become the signal.
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}
