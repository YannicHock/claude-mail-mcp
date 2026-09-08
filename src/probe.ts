/**
 * One-shot connection tests for credentials that have not been saved yet.
 *
 * Deliberately not built on ClientPool. The pool exists to keep connections warm for
 * configured accounts; running a test through it would cache credentials the operator
 * may be about to discard, and a failed test would poison the pool for an account
 * that still works. Everything here is created for one probe and torn down.
 *
 * Every probe is bounded twice — per probe and in total — because the host on the
 * other end is whatever the operator typed. An unreachable address must fail the form
 * submission quickly, not hold a request open until the proxy gives up on it.
 */

import { ImapFlow, AuthenticationFailure } from "imapflow";
import nodemailer from "nodemailer";
import { createDAVClient } from "tsdav";

import type { ImapCreds, SmtpCreds, CalDavCreds } from "./accounts.js";

export const PER_PROBE_TIMEOUT_MS = 10_000;
export const TOTAL_TIMEOUT_MS = 25_000;
export const MAX_MESSAGE_LENGTH = 200;

export interface ProbeInput {
  imap: ImapCreds;
  smtp: SmtpCreds;
  caldav?: CalDavCreds;
}

export type ProbeResult = { ok: true } | { ok: false; message: string };

export interface ProbeReport {
  imap: ProbeResult;
  smtp: ProbeResult;
  caldav: ProbeResult | null;
}

/**
 * Race `promise` against a `ms`-millisecond timer, rejecting with a message that
 * names which probe timed out. The timer is always cleared, win or lose, so a
 * fast-resolving probe never leaves a dangling handle behind.
 */
async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer!: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Turn an error into a message safe to hand back to the settings UI: no
 * credentials, bounded length. Never interpolates the password or the raw
 * error object — only `err.message`, whitespace-collapsed and truncated.
 */
function describe(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const collapsed = raw.replace(/\s+/g, " ").trim();
  return collapsed.length > MAX_MESSAGE_LENGTH
    ? `${collapsed.slice(0, MAX_MESSAGE_LENGTH)}…`
    : collapsed;
}

function toFailure(err: unknown): ProbeResult {
  return { ok: false, message: describe(err) };
}

async function probeImap(creds: ImapCreds): Promise<ProbeResult> {
  const client = new ImapFlow({
    host: creds.host,
    port: creds.port,
    secure: creds.tls,
    auth: { user: creds.user, pass: creds.pass },
    logger: false,
  });
  try {
    await client.connect();
    return { ok: true };
  } catch (err) {
    if (err instanceof AuthenticationFailure) {
      return { ok: false, message: "the server rejected these credentials" };
    }
    return toFailure(err);
  } finally {
    try {
      await client.logout();
    } catch {
      // Best-effort: the socket may never have reached a state where LOGOUT
      // is meaningful (e.g. the connect() above never completed).
    }
  }
}

async function probeSmtp(creds: SmtpCreds): Promise<ProbeResult> {
  const transporter = nodemailer.createTransport({
    host: creds.host,
    port: creds.port,
    secure: creds.tls,
    auth: { user: creds.user, pass: creds.pass },
  });
  try {
    await transporter.verify();
    return { ok: true };
  } catch (err) {
    return toFailure(err);
  } finally {
    transporter.close();
  }
}

async function probeCalDav(creds: CalDavCreds): Promise<ProbeResult> {
  try {
    const client = await createDAVClient({
      serverUrl: creds.url,
      credentials: { username: creds.user, password: creds.pass },
      authMethod: "Basic",
      defaultAccountType: "caldav",
    });
    await client.fetchCalendars();
    return { ok: true };
  } catch (err) {
    return toFailure(err);
  }
}

/**
 * Test a set of not-yet-saved credentials. IMAP, SMTP and (if configured) CalDAV
 * are probed concurrently, each bounded by `perProbeMs`, with the whole call
 * additionally bounded by `totalMs`. CalDAV is skipped (report field `null`)
 * when no `caldav` input is given — there is nothing to test.
 */
export async function probeAccount(
  input: ProbeInput,
  opts: { perProbeMs?: number; totalMs?: number } = {}
): Promise<ProbeReport> {
  const perProbeMs = opts.perProbeMs ?? PER_PROBE_TIMEOUT_MS;
  const totalMs = opts.totalMs ?? TOTAL_TIMEOUT_MS;

  const runAll = async (): Promise<ProbeReport> => {
    const [imap, smtp, caldav] = await Promise.all([
      withTimeout(probeImap(input.imap), perProbeMs, "IMAP").catch(toFailure),
      withTimeout(probeSmtp(input.smtp), perProbeMs, "SMTP").catch(toFailure),
      input.caldav
        ? withTimeout(probeCalDav(input.caldav), perProbeMs, "CalDAV").catch(toFailure)
        : Promise.resolve(null),
    ]);
    return { imap, smtp, caldav };
  };

  return withTimeout(runAll(), totalMs, "connection test");
}
