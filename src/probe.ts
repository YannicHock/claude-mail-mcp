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

import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import { createDAVClient } from "tsdav";

import type { ImapCreds, SmtpCreds, CalDavCreds } from "./accounts.js";
import { withTimeout } from "./timeout.js";
import {
  classifyFailure,
  describeFailure,
  CREDENTIAL_REJECTION_MESSAGE,
} from "../shared/credential-failure.js";

export const PER_PROBE_TIMEOUT_MS = 10_000;
export const TOTAL_TIMEOUT_MS = 25_000;

/**
 * Both re-exported, not re-declared. The classification and the bound moved to
 * `shared/credential-failure.ts` in #146 so the MCP tools could reach them too:
 * they were private to this file, and `src/tools-mail.ts` reported imapflow's
 * generic `Command failed` for a rejected password as a result. Every existing
 * `import { … } from "./probe.js"` keeps working, and there is still exactly
 * one declaration — which `test/unit/shared-modules.test.ts` enforces.
 */
export {
  MAX_MESSAGE_LENGTH,
  CREDENTIAL_REJECTION_MESSAGE,
} from "../shared/credential-failure.js";

export interface ProbeInput {
  imap: ImapCreds;
  smtp: SmtpCreds;
  caldav?: CalDavCreds;
}

/**
 * One service's verdict.
 *
 * `credentialRejection` is {@link classifyFailure}'s answer, carried rather
 * than dropped: the settings routes refuse a save on a failed IMAP or SMTP
 * (#147) and the operator's next move depends entirely on which of the two
 * things happened. A rejected password is fixed by typing a different one; a
 * host that never answered is not, and telling an operator to check their
 * password when the server is down is the confusion #146 exists to prevent.
 *
 * Always present on a failure, never inferred from the message. The wire copy
 * in `shared/settings-api.ts` makes it optional so an older peer still parses;
 * here, inside one package, there is no such peer.
 */
export type ProbeResult = { ok: true } | { ok: false; message: string; credentialRejection: boolean };

export interface ProbeReport {
  imap: ProbeResult;
  smtp: ProbeResult;
  caldav: ProbeResult | null;
}

/**
 * Every failure in this module goes through {@link classifyFailure}, which is
 * the one place in the repository that decides whether a server refused a
 * login or was never reached. Nothing here re-derives that from a message.
 */
function toFailure(err: unknown): ProbeResult {
  const { credentialRejection, reason } = classifyFailure(err);
  return { ok: false, message: reason, credentialRejection };
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
 *
 * The `'error'` listener below is not diagnostics — it is what keeps this
 * function's "always resolves" contract from being a lie one tick later.
 * imapflow reports a connection lost mid-command *twice*: once by rejecting
 * the in-flight command (which is what `connect()` throws here, and what the
 * operator is told about), and again as an `'error'` event on the client
 * itself, emitted from its socket handlers after that rejection has already
 * been settled and reported. `ImapFlow` is an `EventEmitter`, and an emitter
 * with no `'error'` listener rethrows: Node has nowhere to deliver the second
 * report and raises it as an uncaught exception, killing the process. That is
 * reachable from the settings UI by anyone who can sign in, against any host
 * address they type, so the listener covers the client's whole lifetime rather
 * than only the awaited window. There is nothing to do with the event — the
 * failure it describes has already been returned — so it is deliberately a
 * no-op sink. See the mid-LOGIN-drop case in test/unit/probe.test.ts.
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
  client.on("error", () => {});
  try {
    await withTimeout(client.connect(), perProbeMs, "IMAP", () => client.close());
    return { ok: true };
  } catch (err) {
    // `classifyFailure`, via toFailure, is the fork this catch used to spell
    // out by hand: the fixed CREDENTIAL_REJECTION_MESSAGE when the server
    // answered and refused the login, the bounded description of the error for
    // everything else. Its `credentialRejection` flag is carried through to the
    // caller since #147 — the settings routes refuse a save on this outcome and
    // the operator is owed the difference between a wrong password and a host
    // that was never there.
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
 * The prefix a CalDAV failure carries when the pre-flight below reached the
 * server and was not refused, but tsdav's discovery failed anyway — a URL that
 * is up, answering, and simply not a calendar. Declared here rather than
 * beside CREDENTIAL_REJECTION_MESSAGE because it belongs to probeCalDav()
 * alone; the IMAP and SMTP probes have no equivalent second stage.
 *
 * It exists so that the CalDAV probe's three outcomes stay three outcomes.
 * Without it, "wrong password" and "not a CalDAV endpoint" both arrive as
 * tsdav's `cannot find principalUrl` and the operator cannot act on either.
 * Exported so the tests assert the classification rather than the wording.
 */
export const CALDAV_DISCOVERY_FAILURE_PREFIX =
  "the server answered, but CalDAV discovery failed: ";

/**
 * Ask the configured URL one plain HTTP question, with the operator's
 * credentials attached, and read the status code before tsdav ever runs.
 * Returns a credential rejection when the server refuses those credentials,
 * and `null` — "carry on" — for anything else. A server that cannot be
 * reached at all throws out of here, exactly as the request underneath does,
 * and stays a connectivity failure.
 *
 * Why a pre-flight at all. imapflow decorates its errors with what the server
 * said (see `isCredentialRejection` in shared/credential-failure.ts), so
 * probeImap() can classify after
 * the fact. tsdav cannot be classified after the fact: `createAccount()`
 * (node_modules/tsdav/dist/tsdav.cjs.js, ~line 1372) walks a list of candidate
 * root URLs — the discovered one, the configured `serverUrl`, and the origin's
 * `/` — and keeps only the *last* error, so the `401` from the URL the
 * operator actually typed is routinely overwritten by `cannot find
 * principalUrl` from a candidate they never configured. Verified against a
 * local endpoint answering `401` to everything: the failure that surfaced
 * named `http://host/`, not the configured path. Even on the runs where the
 * status does survive, it arrives as free-form prose, not as a field.
 *
 * Why `GET`, and why not more. This is the least CalDAV-aware request that
 * still reaches the server's authentication layer — plain HTTP, no `PROPFIND`,
 * no `Depth`, no XML. Issuing the discovery request ourselves would work too,
 * and would answer more cases (see below), but it would put a second copy of
 * this protocol's details in this repository, which is the thing tsdav is here
 * to avoid. The body is cancelled unread: nothing here needs it, and leaving
 * it dangling holds the connection open.
 *
 * What it deliberately does not answer:
 *
 *   - `403` is not treated as a rejection. It means the credentials were
 *     understood and the resource is still off limits, which is a different
 *     sentence than "wrong password" and would be a lie in this one.
 *   - A server that serves its landing page anonymously and only demands
 *     authentication deeper in still falls through to tsdav, and still reports
 *     whatever tsdav makes of it. That is the pre-fix behaviour, unchanged —
 *     this narrows the vague case, it does not claim to have removed it.
 *   - Basic is the only scheme offered, matching `authMethod: "Basic"` below.
 *     A server that wants Digest answers `401` and is reported as a rejection,
 *     which is the right answer for a probe that cannot speak Digest either.
 *
 * `signal` is the same AbortController the discovery phase gets, so the
 * pre-flight spends the same `perProbeMs` budget rather than adding to it.
 */
async function caldavPreflight(
  creds: CalDavCreds,
  signal: AbortSignal
): Promise<ProbeResult | null> {
  const basic = Buffer.from(`${creds.user}:${creds.pass}`, "utf8").toString("base64");
  const response = await fetch(creds.url, {
    method: "GET",
    headers: { Authorization: `Basic ${basic}` },
    signal,
  });
  try {
    await response.body?.cancel();
  } catch {
    // Best-effort: the body may already be gone, and it was never wanted.
  }

  if (response.status === 401) {
    // Same fixed string probeImap() reports, on purpose. The operator is being
    // told which of two things went wrong; which library was involved is not
    // part of the answer, and the server's own wording is neither dependable
    // nor guaranteed free of the credentials it is complaining about.
    return { ok: false, message: CREDENTIAL_REJECTION_MESSAGE, credentialRejection: true };
  }
  return null;
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
    return await withTimeout(
      (async (): Promise<ProbeResult> => {
        const rejected = await caldavPreflight(creds, controller.signal);
        if (rejected) return rejected;

        try {
          const client = await createDAVClient({
            serverUrl: creds.url,
            credentials: { username: creds.user, password: creds.pass },
            authMethod: "Basic",
            defaultAccountType: "caldav",
            fetchOptions: { signal: controller.signal },
          });
          await client.fetchCalendars();
        } catch (err) {
          // Our own deadline firing is not a discovery failure — it is the
          // timeout, and withTimeout is already rejecting with a message that
          // says so. Rethrowing keeps that the answer rather than dressing an
          // abort up as "the server answered".
          if (controller.signal.aborted) throw err;
          // Reached and not refused, but no calendar came back. `describeFailure()`
          // runs over the composed string, not just the library's half, so the
          // whole message stays inside MAX_MESSAGE_LENGTH.
          const detail = `${CALDAV_DISCOVERY_FAILURE_PREFIX}${describeFailure(err)}`;
          // Not a credential rejection: the pre-flight above is what answers
          // that question for CalDAV, and it already said no.
          return { ok: false, message: describeFailure(detail), credentialRejection: false };
        }
        return { ok: true };
      })(),
      perProbeMs,
      "CalDAV",
      () => controller.abort()
    );
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
