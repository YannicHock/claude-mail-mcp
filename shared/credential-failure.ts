/**
 * One answer to "was that the password, or was that the network?", for every
 * caller in this repository that has to tell an operator which.
 *
 * It lived inside `src/probe.ts` from #3 until #146, private to the connection
 * test. That was the wrong home the moment a second caller needed it: the MCP
 * tools failed against a mailbox whose password a server had rejected and said
 * `Command failed`, which reads like a connectivity problem, because the rule
 * that could have told them otherwise was twenty lines away behind a `function`
 * with no `export`. It is here now, and `src/probe.ts`, `src/tools-mail.ts` and
 * `src/tools-calendar.ts` all read this one copy.
 *
 * It is not beside `withTimeout` as #146's design sketch expected, because
 * `src/timeout.ts` has not moved: `src/autoconfig.ts` imports it and that file
 * belongs to another change in flight. Nothing here depends on that; the two
 * helpers are neighbours in intent, not in code.
 *
 * **This module imports nothing.** `shared/` is compiled into both images
 * (#126) and the OAuth package does not depend on imapflow, so an
 * `import { AuthenticationFailure } from "imapflow"` here would break that
 * package's build for a class the OAuth layer will never see. Everything below
 * therefore reads imapflow's error *shape* rather than its types — which the
 * bulk of the classification already did, because the ordinary wrong-password
 * case was never an instance of that class in the first place.
 */

/**
 * The bound every message derived from an error is held to, whatever produced
 * it. A server is free to answer a failed login with as much prose as it likes,
 * and none of it belongs in a settings page, a tool answer or a log line at
 * full length.
 */
export const MAX_MESSAGE_LENGTH = 200;

/**
 * The one message reported when the server was reached and answered, and what
 * it answered was "not with those credentials". Deliberately a fixed string
 * rather than the server's own text: the operator needs to know which of the
 * two things went wrong, and the server's wording is neither dependable nor
 * guaranteed free of the credentials it is complaining about.
 *
 * Exported so callers and tests assert the classification rather than a copy of
 * the wording.
 */
export const CREDENTIAL_REJECTION_MESSAGE = "the server rejected these credentials";

/**
 * Turn an error into a message safe to show an operator: no credentials,
 * bounded length. Never interpolates the error object — only `err.message`,
 * whitespace-collapsed and truncated. The object itself routinely carries the
 * connection options, credentials included, on some other property.
 */
export function describeFailure(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const collapsed = raw.replace(/\s+/g, " ").trim();
  return collapsed.length > MAX_MESSAGE_LENGTH
    ? `${collapsed.slice(0, MAX_MESSAGE_LENGTH)}…`
    : collapsed;
}

/**
 * The fields imapflow decorates an IMAP command failure with. None of them are
 * on `Error`, and imapflow's published types describe them only on the
 * `AuthenticationFailure` subclass, so they are declared here and read
 * defensively — every one of them is checked before it is trusted.
 */
interface ImapCommandError {
  /** Set by imapflow's LOGIN/AUTHENTICATE handlers on any error escaping the
   * authentication step (`dist/esm/commands/login.js`, `authenticate.js`), and
   * set unconditionally by the `AuthenticationFailure` constructor. */
  authenticationFailed?: unknown;
  /** `"NO"` or `"BAD"` — present only when the server actually answered with a
   * tagged rejection (`settleRequest()` in `dist/esm/imap-flow.js`). */
  responseStatus?: unknown;
  /** The RFC 5530 response code, e.g. `AUTHENTICATIONFAILED`, for servers that
   * send one. GreenMail does not; Dovecot does. */
  serverResponseCode?: unknown;
}

/**
 * imapflow's own `AuthenticationFailure`, recognised without importing it.
 *
 * `instanceof` is not available here — see the module header — so the
 * prototype chain is walked by constructor name instead. That is a weaker
 * check than `instanceof` and it is deliberately not the *only* one: the class
 * always sets `authenticationFailed: true` (`dist/esm/errors.js`), so anything
 * this misses that a server actually rejected still reaches the field checks
 * below. What this clause adds is the narrow set imapflow decides on its own
 * without a tagged response to point at — login disabled, no password
 * configured, Exchange's authenticate-then-fail-NAMESPACE quirk.
 *
 * The chain is walked rather than reading `err.constructor.name` once so a
 * subclass of imapflow's class still matches. `Error.prototype` ends the walk:
 * nothing at or above it can be the class being looked for.
 */
function isAuthenticationFailureClass(err: Error): boolean {
  let proto: object | null = Object.getPrototypeOf(err) as object | null;
  while (proto !== null && proto !== Error.prototype) {
    if ((proto as { constructor?: { name?: string } }).constructor?.name === "AuthenticationFailure") {
      return true;
    }
    proto = Object.getPrototypeOf(proto) as object | null;
  }
  return false;
}

/**
 * True when the server was reached, answered, and refused the login.
 *
 * imapflow throws its `AuthenticationFailure` class only in narrow cases it
 * decides on its own. The ordinary wrong-password case — a server answering
 * `LOGIN` with a tagged `NO` — is not one of them: imapflow raises a plain
 * `Error("Command failed")` and hangs the interesting detail off it as
 * properties. Reporting `err.message` there tells the operator "Command
 * failed", which reads like a connectivity problem and is exactly the
 * confusion this classification exists to prevent. Verified against GreenMail,
 * which yields `authenticationFailed: true`, `responseStatus: "NO"`,
 * `responseText: "LOGIN failed. Invalid login/password for user id alice"` and
 * no `serverResponseCode` at all.
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
 * claim {@link CREDENTIAL_REJECTION_MESSAGE} makes. `serverResponseCode` is
 * checked as well for the servers that do send RFC 5530's
 * `AUTHENTICATIONFAILED`, so the classification does not rest solely on
 * internal imapflow bookkeeping.
 */
export function isCredentialRejection(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (isAuthenticationFailureClass(err)) return true;

  const fields = err as Error & ImapCommandError;
  if (fields.serverResponseCode === "AUTHENTICATIONFAILED") return true;

  const status =
    typeof fields.responseStatus === "string" ? fields.responseStatus.toUpperCase() : "";
  return fields.authenticationFailed === true && (status === "NO" || status === "BAD");
}

/** What {@link classifyFailure} decided about one error. */
export interface FailureClassification {
  /** True when the server answered and refused these credentials. */
  credentialRejection: boolean;
  /**
   * The reason to report — {@link CREDENTIAL_REJECTION_MESSAGE} for a
   * rejection, the bounded description of the error otherwise. Safe for a tool
   * answer, a settings page and a log line alike.
   */
  reason: string;
}

/**
 * The two questions every caller asks together: was this the credentials, and
 * what do I tell the operator? Answering them in one place is what keeps the
 * probe, the mail tools and the calendar tools from drifting into three
 * slightly different accounts of the same failure.
 */
export function classifyFailure(err: unknown): FailureClassification {
  return isCredentialRejection(err)
    ? { credentialRejection: true, reason: CREDENTIAL_REJECTION_MESSAGE }
    : { credentialRejection: false, reason: describeFailure(err) };
}
