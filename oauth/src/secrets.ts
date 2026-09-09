/**
 * Secret material that generates itself on first boot.
 *
 * Three of this stack's four secrets — the connector's auth token, the OAuth
 * signing key and the settings signing key — are random bytes with no meaning
 * outside a single deployment. Requiring an operator to hand-roll them before
 * the first `docker compose up` bought nothing and cost a crash loop: `600` is
 * the intuitive mode for a secret, and the service that did not write the file
 * cannot read it. So they are generated here instead, at a mode and group both
 * images agree on — see {@link GENERATED_SECRET_MODE}.
 *
 * The rule, and it is the whole of the design:
 *
 *   **A present file wins. An absent one is generated.**
 *
 * Existing deployments mount all four secrets as read-only Docker file-secrets.
 * If generation ever took priority over a present file — or if an existence
 * check misfired — a running instance would come back up with a fresh
 * `AUTH_TOKEN` and every connected Claude client would break at once. Precedence
 * is what makes this safe to ship to an instance that is already running, which
 * is why it is stated as a rule here and pinned by its own tests.
 *
 * The password hash is deliberately *not* generated: it is the one secret with a
 * meaning outside the deployment, and the setup wizard sets it through
 * `OperatorRecord`.
 *
 * This module is duplicated verbatim as `src/secrets.ts` in the connector
 * package — the two services are separate npm packages with no shared workspace,
 * the same way `readSecret()` here and `secret()` there already mirror each
 * other. Change one, change the other: the two must derive byte-identical values
 * from the same file or the settings assertion stops verifying.
 */

import { randomBytes } from "node:crypto";
import { chmodSync, chownSync, linkSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import type { Logger } from "./logger.js";

/**
 * Mode for a generated secret file: readable by its owner and by the shared
 * group, and by nobody else.
 *
 * The two images run as *different* non-root users — uid 100/gid 101 for the
 * connector, uid 102/gid 103 for the OAuth layer — and both read the same
 * `auth_token` and `settings_signing_key`. `600` is the documented trap:
 * whichever service wrote the file would be the only one able to read it, and
 * the other would crash-loop on EACCES with nothing in `docker compose logs` but
 * a permission error. `644` would work and is what a first draft of this used,
 * but it makes every secret readable to every user on the host, and the
 * directory would have to be world-writable for both uids to create files in
 * it — which would let any local user plant an `auth_token.txt` before first
 * boot and have this code adopt it, precedence rule and all.
 *
 * So both images join one shared group instead. See {@link SHARED_SECRET_GID}.
 */
export const GENERATED_SECRET_MODE = 0o640;

/**
 * The group both container images' runtime users belong to (`mailsecrets`).
 *
 * Pinned identically in Dockerfile, oauth/Dockerfile and here. That is three
 * copies of one number, so a unit test reads the two Dockerfiles and compares
 * them against this constant: if they ever disagree, one service starts
 * crash-looping on EACCES against a file the other just created, which is a
 * miserable thing to debug and an easy thing to check.
 *
 * A setgid `secrets/` directory (mode 2770, group 105) is what the deployment
 * documents, and is enough on its own. This constant exists so the guarantee
 * does not *depend* on the operator having remembered the setgid bit — see
 * {@link adoptSharedGroup}.
 */
export const SHARED_SECRET_GID = 105;

/**
 * 48 random bytes, matching the `openssl rand -base64 48` the docs used to ask
 * for by hand. Base64url rather than base64 so the value survives being pasted
 * into a URL, a shell, or a `.env` line without quoting.
 */
const GENERATED_SECRET_BYTES = 48;

/** Where a resolved secret came from. Reported per secret at startup. */
export type SecretSource =
  /** Read from the path in `NAME_FILE`. */
  | "file"
  /** Taken from the inline `NAME`; no `NAME_FILE` was configured. */
  | "environment"
  /** Taken from the inline `NAME` and written to `NAME_FILE`, which was absent. */
  | "seeded"
  /** Not supplied anywhere; generated and written to `NAME_FILE`. */
  | "generated";

export interface ResolvedSecret {
  /** Undefined only when neither `NAME` nor `NAME_FILE` was configured. */
  value: string | undefined;
  /** Undefined for the same case; there is nothing to report. */
  source: SecretSource | undefined;
  /** The `NAME_FILE` path, when one was configured. */
  path: string | null;
}

/** One line's worth of "where did this secret come from", for the startup log. */
export interface SecretReportEntry {
  name: string;
  source: SecretSource;
  path: string | null;
}

/**
 * Thrown for a secret that cannot be read or created. Callers map it onto their
 * own configuration error type so the message reaches the operator as a plain
 * line in `docker compose logs` rather than a stack trace.
 */
export class SecretError extends Error {}

type Env = Record<string, string | undefined>;

export interface ResolveOptions {
  /**
   * Whether an absent `NAME_FILE` may be created. False for
   * `AUTH_PASSWORD_HASH`, which is never generated — a missing password hash is
   * a misconfiguration, not something this process can invent.
   */
  generate: boolean;
}

/**
 * Resolve one secret, in this order:
 *
 *  1. `NAME_FILE` is set and the file is there — read it. Always wins.
 *  2. `NAME_FILE` is set, the file is absent, `NAME` is set — use the inline
 *     value and *write it to the file*. Seeding rather than merely using it is
 *     what keeps the two services agreeing: an operator upgrading from a
 *     `.env`-only Option A install has `AUTH_TOKEN` inline and no file, and if
 *     the OAuth layer then generated its own the proxy would 401 every request.
 *  3. `NAME_FILE` is set, the file is absent, nothing inline — generate.
 *  4. No `NAME_FILE` — the inline `NAME`, or nothing.
 *
 * A `NAME_FILE` that exists but cannot be read stays fatal, as it always was: a
 * typo in a secret mount must stop the service, not silently downgrade it. Only
 * ENOENT reaches the generation branch, and a failure to create the file is
 * fatal too — a secret this process could not persist is one the other service
 * will not see.
 */
export function resolveSecret(
  env: Env,
  name: string,
  options: ResolveOptions = { generate: true }
): ResolvedSecret {
  const path = trimmed(env[`${name}_FILE`]);
  const inline = trimmed(env[name]);

  if (path === undefined) {
    return {
      value: inline,
      source: inline === undefined ? undefined : "environment",
      path: null,
    };
  }

  const existing = readIfPresent(path, name);
  if (existing !== undefined) return { value: existing, source: "file", path };

  if (!options.generate) {
    throw new SecretError(
      `Cannot read ${name}_FILE at ${path}: ENOENT: no such file or directory. ` +
        `This secret is never generated — supply it, or unset ${name}_FILE.`
    );
  }

  const created = createExclusively(path, inline ?? generateSecret(), name);
  // `raced` means another process created the file between the read above and
  // the link below — at first boot both services generate the shared secrets
  // concurrently. Whoever lost reports "file", because that is what it is now
  // holding, and both end up with the same bytes.
  if (created.raced) return { value: created.value, source: "file", path };
  return {
    value: created.value,
    source: inline === undefined ? "generated" : "seeded",
    path,
  };
}

/** 48 random bytes, base64url. Exported for this package's own tests. */
export function generateSecret(): string {
  return randomBytes(GENERATED_SECRET_BYTES).toString("base64url");
}

/**
 * One `info` line per secret, naming the source.
 *
 * Never the value, and never for a secret that was not configured at all. An
 * operator debugging a mismatched token needs to know which of the two services
 * generated it and which read it; that is the entire purpose of these lines.
 */
export function logSecretReport(report: SecretReportEntry[], log: Logger): void {
  for (const entry of report) {
    log("info", "secret resolved", {
      secret: entry.name,
      source: entry.source,
      ...(entry.path === null ? {} : { path: entry.path }),
    });
  }
}

function trimmed(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const cleaned = value.trim();
  return cleaned === "" ? undefined : cleaned;
}

function readIfPresent(path: string, name: string): string | undefined {
  try {
    return readFileSync(path, "utf8").trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new SecretError(`Cannot read ${name}_FILE at ${path}: ${describe(err)}`);
  }
}

/**
 * Write the secret to a temp file in the same directory and hard-link it into
 * place, which fails rather than clobbers if the target already exists.
 *
 * `open(..., "wx")` would also refuse to overwrite, but it leaves a window where
 * the file exists and is still empty; the other service, starting at the same
 * moment, would read nothing and derive a different key. Linking a fully written
 * file closes that window — the path either does not exist or holds the complete
 * value, never anything in between.
 *
 * Exported only so the EEXIST branch — the one a first boot of both services at
 * once actually takes — can be exercised without racing two real processes.
 */
export function createExclusively(
  path: string,
  value: string,
  name: string
): { value: string; raced: boolean } {
  const temp = join(dirname(path), `.${basename(path)}.${randomBytes(8).toString("hex")}.tmp`);
  try {
    // Trailing newline so `cat`, `openssl rand -base64 48 > file` and this
    // module all produce the same shape. Every reader trims.
    writeFileSync(temp, `${value}\n`, { encoding: "utf8", mode: GENERATED_SECRET_MODE });
    // writeFileSync's mode is masked by the process umask, which in a container
    // is whatever the base image set. Say it again explicitly.
    chmodSync(temp, GENERATED_SECRET_MODE);
    adoptSharedGroup(temp);
    try {
      linkSync(temp, path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      return { value: readFileSync(path, "utf8").trim(), raced: true };
    }
    return { value, raced: false };
  } catch (err) {
    if (err instanceof SecretError) throw err;
    throw new SecretError(
      `Cannot create ${name}_FILE at ${path}: ${describe(err)}. ` +
        `The directory must be group-owned by gid ${SHARED_SECRET_GID} and mode 2770, ` +
        `so both services can create files in it: ` +
        `chgrp ${SHARED_SECRET_GID} secrets && chmod 2770 secrets — see docs/DEPLOYMENT.md.`
    );
  } finally {
    try {
      unlinkSync(temp);
    } catch {
      // Never created, or already gone. Either way there is nothing to clean up
      // and nothing worth failing startup over.
    }
  }
}

/**
 * Give the file away to the shared group, when this process is in it.
 *
 * A setgid `secrets/` directory already does this — a file created there
 * inherits the directory's group rather than the creator's — and that is what
 * docs/DEPLOYMENT.md asks for. But `chmod 0770` without the setgid bit is an
 * easy thing to type, and it would leave the connector's file in gid 101 at mode
 * 640, which uid 102 cannot read: exactly the crash loop this whole change
 * exists to remove, reintroduced by one missing digit. So the guarantee is made
 * here as well, where nobody has to remember it.
 *
 * Deliberately best-effort. Outside a container — the systemd deployment, a
 * developer's checkout, this repository's own tests — gid 105 means something
 * else or nothing at all, and the process is not a member, so nothing happens.
 * POSIX only: `getgroups`/`chown` do not apply on Windows, where the tests run
 * too.
 */
function adoptSharedGroup(path: string): void {
  if (process.platform === "win32") return;
  try {
    if (process.getgroups?.().includes(SHARED_SECRET_GID) !== true) return;
    chownSync(path, process.getuid?.() ?? -1, SHARED_SECRET_GID);
  } catch {
    // Not a member after all, or a filesystem that will not have it. The setgid
    // directory is the documented path; this was only the belt to its braces.
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
