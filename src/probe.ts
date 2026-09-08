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
 *
 * `onTimeout`, when given, runs synchronously the moment the timer fires —
 * before the rejection — so a caller holding a client/socket tied to `promise`
 * can force it closed immediately. Racing a promise never cancels it: on its
 * own this function only stops *watching* the loser, it does not touch
 * whatever is still running underneath. See probeImap()/probeSmtp() for why
 * that distinction matters here.
 */
async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
  onTimeout?: () => void
): Promise<T> {
  let timer!: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout?.();
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
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

/**
 * `perProbeMs` is enforced twice here, deliberately:
 *
 * 1. As imapflow's own `connectionTimeout`/`greetingTimeout`. Without this,
 *    our `withTimeout()` wrapper only stops *waiting* on `connect()` at
 *    `perProbeMs` — it does not cancel it. imapflow's own default
 *    `connectionTimeout` is 90 seconds (connection-deadline.js) and its
 *    connect/greeting timers are deliberately ref'd ("keep the process
 *    alive, because a caller is waiting on connect() to settle" —
 *    imap-flow.js), so an unresponsive host would otherwise leave a live
 *    socket and a ref'd timer running for up to another ~80s past the point
 *    we already told the operator it failed.
 * 2. As `withTimeout`'s own `onTimeout` callback, which force-closes the
 *    client the instant *our* timer fires. This is belt and suspenders on
 *    top of (1): `client.close()` ("Closes TCP connection without notifying
 *    the server", imap-flow.d.ts) is synchronous and always available, so
 *    there is no reason to depend on the two deadlines racing in our favor.
 */
async function probeImap(creds: ImapCreds, perProbeMs: number): Promise<ProbeResult> {
  const client = new ImapFlow({
    host: creds.host,
    port: creds.port,
    secure: creds.tls,
    auth: { user: creds.user, pass: creds.pass },
    logger: false,
    connectionTimeout: perProbeMs,
    greetingTimeout: perProbeMs,
  });
  try {
    await withTimeout(client.connect(), perProbeMs, "IMAP", () => client.close());
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
      // Best-effort: on a timeout the socket was already force-closed above
      // by withTimeout's onTimeout; on any other failure the connection may
      // never have reached a state where LOGOUT means anything.
    }
  }
}

/**
 * Unlike imapflow's ImapFlow, nodemailer's plain (non-pooled) SMTPTransport
 * gives us no external handle to force-close mid-`verify()`: reading
 * node_modules/nodemailer/dist/cjs/smtp-transport/index.js shows verify()
 * builds its SMTPConnection as a local variable inside its own closure, never
 * stored on the transport, so `transporter.close()` (SMTPTransport#close)
 * cannot reach it — that method only clears OAuth2 listeners and emits
 * 'close'. The connectionTimeout/greetingTimeout/socketTimeout options below
 * are therefore not "belt and suspenders" here the way imapflow's are: they
 * are the *only* lever that tears the in-flight connection down, via the
 * library's own internal handling (verify()'s local `connection.once('error',
 * ...)` handler calls `connection.close()` itself once one of these deadlines
 * fires). nodemailer's own defaults are 2 minutes / 30s / 10 minutes,
 * likewise ref'd, so leaving them unset would strand a live socket for
 * minutes past the point this function has already reported failure.
 */
async function probeSmtp(creds: SmtpCreds, perProbeMs: number): Promise<ProbeResult> {
  const transporter = nodemailer.createTransport({
    host: creds.host,
    port: creds.port,
    secure: creds.tls,
    auth: { user: creds.user, pass: creds.pass },
    connectionTimeout: perProbeMs,
    greetingTimeout: perProbeMs,
    socketTimeout: perProbeMs,
  });
  try {
    await withTimeout(transporter.verify(), perProbeMs, "SMTP");
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
 *
 * Always resolves with a `ProbeReport`, never rejects — including if the
 * outer `totalMs` bound itself fires. That bound is a backstop over the
 * three per-probe ones above (which already resolve, never reject, at or
 * before `perProbeMs`), so in practice it should be close to unreachable;
 * but a `Promise<ProbeReport>` that can still reject on one particular edge
 * is a landmine for whatever calls this next, so that edge is handled the
 * same way a per-probe failure is rather than left as a special case a
 * caller has to remember.
 */
export async function probeAccount(
  input: ProbeInput,
  opts: { perProbeMs?: number; totalMs?: number } = {}
): Promise<ProbeReport> {
  const perProbeMs = opts.perProbeMs ?? PER_PROBE_TIMEOUT_MS;
  const totalMs = opts.totalMs ?? TOTAL_TIMEOUT_MS;

  const runAll = async (): Promise<ProbeReport> => {
    const [imap, smtp, caldav] = await Promise.all([
      probeImap(input.imap, perProbeMs).catch(toFailure),
      probeSmtp(input.smtp, perProbeMs).catch(toFailure),
      input.caldav
        ? withTimeout(probeCalDav(input.caldav), perProbeMs, "CalDAV").catch(toFailure)
        : Promise.resolve(null),
    ]);
    return { imap, smtp, caldav };
  };

  try {
    return await withTimeout(runAll(), totalMs, "connection test");
  } catch (err) {
    return {
      imap: toFailure(err),
      smtp: toFailure(err),
      caldav: input.caldav ? toFailure(err) : null,
    };
  }
}
