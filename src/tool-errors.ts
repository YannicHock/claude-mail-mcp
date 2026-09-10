/**
 * What an MCP tool says, and what it writes to the log, when the mailbox
 * behind it fails.
 *
 * #146: a Gmail mailbox on a live three-account instance had a password Google
 * would not accept over IMAP, and every tool call against it answered
 * `Command failed` — imapflow's generic wording for a tagged `NO` — while the
 * server log said nothing whatsoever. The operator had two accounts working
 * beside it and no way, from either surface, to learn which one had failed or
 * why.
 *
 * So every failure that leaves a tool now goes through here, and answers three
 * questions it used to answer none of:
 *
 *   - **which mailbox** — the resolved account id, never `(default)`, because
 *     a multi-account instance saying "the server rejected these credentials"
 *     without naming one has told the operator nothing they can act on;
 *   - **which of the two things went wrong** — `classifyFailure()` in
 *     shared/credential-failure.ts, the same rule the connection test has used
 *     since #3. A rejected password reads as a rejection; a host that is not
 *     there still reads as connectivity;
 *   - **and it says it once, in the log too**, at `warn`.
 *
 * Nothing here ever touches a credential. The reason is either the fixed
 * `CREDENTIAL_REJECTION_MESSAGE` or `describeFailure()`'s whitespace-collapsed,
 * `MAX_MESSAGE_LENGTH`-bounded reading of `err.message` — never the error
 * object, which routinely carries the connection options and the password with
 * them.
 */

import type { ClientPool } from "./client-pool.js";
import { classifyFailure } from "../shared/credential-failure.js";

/**
 * The message every tool failure is logged under. One fixed string, so an
 * operator can grep for it and a log pipeline can alert on it; everything that
 * differs between two failures is in the structured fields beside it.
 */
export const TOOL_FAILURE_EVENT = "mail tool call failed";

/**
 * Log one `warn` line for `err` and return the error to throw in its place.
 *
 * Split from {@link reportingFailures} for the one caller that must not
 * rethrow: `send_message`'s best-effort copy to the Sent folder, where the
 * send itself already succeeded and the failure is worth a line but not worth
 * failing the call over. That `catch` is the bare `catch {}` #146 was filed
 * against.
 */
export function logToolFailure(
  pool: ClientPool,
  tool: string,
  account: string,
  err: unknown,
  extra: Record<string, unknown> = {}
): Error {
  const { credentialRejection, reason } = classifyFailure(err);
  pool.log("warn", TOOL_FAILURE_EVENT, {
    account,
    tool,
    reason,
    credential_rejection: credentialRejection,
    ...extra,
  });
  // `cause` keeps the original for anything that wants to inspect it in
  // process; it is not what reaches the client, which sees only `message`.
  return new Error(`Account "${account}": ${reason}`, { cause: err });
}

/**
 * Run one mailbox operation, and if it fails, leave exactly one `warn` line
 * and throw an error that names the account and the classified reason.
 *
 * Wrap the network call, not the whole handler: argument validation and
 * `AccountsStore.resolve()`'s "no such account" already say something true and
 * specific, and neither is a mailbox that failed. Rewriting those as connection
 * failures would blame a server nothing ever spoke to, and would put a `warn`
 * line in the log for a caller's typo.
 */
export async function reportingFailures<T>(
  pool: ClientPool,
  tool: string,
  account: string,
  run: () => Promise<T>
): Promise<T> {
  try {
    return await run();
  } catch (err) {
    throw logToolFailure(pool, tool, account, err);
  }
}
