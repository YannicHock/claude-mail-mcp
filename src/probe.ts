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

/**
 * The one message a probe reports when the server was reached and answered,
 * and what it answered was "not with those credentials". Exported so the
 * tests assert the classification rather than a copy of the wording.
 */
export const CREDENTIAL_REJECTION_MESSAGE = "the server rejected these credentials";

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
 * The fields imapflow decorates an IMAP command failure with. None of them
 * are on `Error`, and imapflow's published types describe them only on the
 * `AuthenticationFailure` subclass, so they are declared here and read
 * defensively — every one of them is checked before it is trusted.
 */
interface ImapCommandError {
  /** Set by imapflow's LOGIN/AUTHENTICATE handlers on any error escaping the
   * authentication step (`dist/esm/commands/login.js`, `authenticate.js`). */
  authenticationFailed?: unknown;
  /** `"NO"` or `"BAD"` — present only when the server actually answered with a
   * tagged rejection (`settleRequest()` in `dist/esm/imap-flow.js`). */
  responseStatus?: unknown;
  /** The RFC 5530 response code, e.g. `AUTHENTICATIONFAILED`, for servers that
   * send one. GreenMail does not; Dovecot does. */
  serverResponseCode?: unknown;
}

/**
 * True when the IMAP server was reached, answered, and refused the login.
 *
 * imapflow throws its `AuthenticationFailure` class only in narrow cases it
 * decides on its own (login disabled, no password configured, Exchange's
 * authenticate-then-fail-NAMESPACE quirk). The ordinary wrong-password case —
 * a server answering `LOGIN` with a tagged `NO` — is not one of them: imapflow
 * raises a plain `Error("Command failed")` and hangs the interesting detail off
 * it as properties. Reporting `err.message` there tells the operator "Command
 * failed", which reads like a connectivity problem and is exactly the confusion
 * this classification exists to prevent. Verified against GreenMail, which
 * yields `authenticationFailed: true`, `responseStatus: "NO"`, `responseText:
 * "LOGIN failed. Invalid login/password for user id alice"` and no
 * `serverResponseCode` at all.
 *
 * Both halves of the final check matter, and neither is redundant:
 *
 *   - `authenticationFailed` alone is too broad. imapflow's LOGIN handler tags
 *     it onto *anything* thrown out of the authentication step, including a
 *     socket that dies mid-command — a connectivity failure that must keep
 *     reading as one.
 *   - `responseStatus` alone is too broad in the other direction: a tagged
 *     `NO`/`BAD` says the server refused a command, not that it refused these
 *     credentials.
 *
 * Together they are precisely "the server rejected the login", which is the
 * claim the message makes. `serverResponseCode` is checked as well for the
 * servers that do send RFC 5530's `AUTHENTICATIONFAILED`, so the classification
 * does not rest solely on internal imapflow bookkeeping.
 */
function isCredentialRejection(err: unknown): boolean {
  if (err instanceof AuthenticationFailure) return true;
  if (!(err instanceof Error)) return false;

  const fields = err as Error & ImapCommandError;
  if (fields.serverResponseCode === "AUTHENTICATIONFAILED") return true;

  const status =
    typeof fields.responseStatus === "string" ? fields.responseStatus.toUpperCase() : "";
  return fields.authenticationFailed === true && (status === "NO" || status === "BAD");
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
    if (isCredentialRejection(err)) {
      // Deliberately a fixed string rather than the server's own text: the
      // operator needs to know which of the two things went wrong, and the
      // server's wording is neither dependable nor guaranteed free of the
      // credentials it is complaining about.
      return { ok: false, message: CREDENTIAL_REJECTION_MESSAGE };
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

/**
 * tsdav has no timeout option of its own to configure the way imapflow and
 * nodemailer do above — it goes straight through the platform `fetch()`,
 * which has no default timeout at all. Left alone, `withTimeout()` here
 * would only stop *watching* a stuck `createDAVClient()`/`fetchCalendars()`
 * call at `perProbeMs`; the request underneath would keep running against
 * the host's own OS-level TCP retry budget, which can run well past a
 * minute against a black-holed address.
 *
 * The fix is an `AbortController` threaded through `fetchOptions`, tied to
 * `withTimeout`'s `onTimeout` callback the same way probeImap() ties its
 * client's `close()` to it. Confirmed from tsdav's bundled source
 * (node_modules/tsdav/dist/tsdav.cjs.js) that this actually reaches the
 * network call, not just the type surface:
 *   - `davRequest()` (~line 233) spreads `fetchOptions` (with `signal`
 *     intact — only `headers` is stripped out of it) straight into the
 *     `fetch(url, {...})` call.
 *   - `createDAVClient()` (~line 1626) stores our `fetchOptions` as
 *     `defaultFetchOptions` and passes it to the initial account/PROPFIND
 *     discovery it does internally — the phase most likely to be the one
 *     that hangs, since it runs before we ever get to call fetchCalendars().
 *   - `defaultParam()` (~line 1515), which is what `client.fetchCalendars`
 *     actually is, merges that same `defaultFetchOptions` in as the default
 *     for every subsequent call unless the caller overrides it — so calling
 *     `client.fetchCalendars()` with no arguments here still carries the
 *     same `signal` forward, with nothing further to wire up.
 *
 * One controller, one `abort()` call, covers both phases with a single
 * deadline; no separate per-call signal is needed.
 *
 * This bounds what actually matters — the probe *result* — at `perProbeMs`:
 * `abort()` rejects the pending `fetch()` immediately, same as imapflow's
 * `close()` does for `connect()`. What it does *not* do, unlike
 * `client.close()`, is synchronously free the underlying OS socket: a
 * standalone repro against a black-holed address
 * (fetch(url, { signal }) + controller.abort() at various delays, checking
 * process._getActiveHandles() right after the rejection) showed live
 * `Socket` handles still present immediately after `abort()` rejects the
 * promise, and the process not exiting for a further ~9-10s regardless of
 * whether the abort fired at 300ms, 1.5s or 5s — a fixed tail tied to the
 * underlying connect attempt's own lifecycle, not to when we cancel our
 * logical request. There is no lever in Node's built-in `fetch()` to shorten
 * that without a custom dispatcher (the standalone `undici` package's
 * `Agent`), which would be a new runtime dependency this module doesn't
 * take. Unlike the pre-fix bug this whole module exists to prevent, that
 * tail is bounded and inert: nothing is left waiting on it (the operator's
 * form submission already has its answer), it self-clears without further
 * action, and it does not compound across repeated resubmissions the way an
 * un-configured 90s/120s imapflow/nodemailer default would have.
 */
async function probeCalDav(creds: CalDavCreds, perProbeMs: number): Promise<ProbeResult> {
  const controller = new AbortController();
  try {
    await withTimeout(
      (async () => {
        const client = await createDAVClient({
          serverUrl: creds.url,
          credentials: { username: creds.user, password: creds.pass },
          authMethod: "Basic",
          defaultAccountType: "caldav",
          fetchOptions: { signal: controller.signal },
        });
        await client.fetchCalendars();
      })(),
      perProbeMs,
      "CalDAV",
      () => controller.abort()
    );
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
        ? probeCalDav(input.caldav, perProbeMs).catch(toFailure)
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
