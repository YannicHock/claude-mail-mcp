/**
 * One-off IMAP mailbox setup for the GreenMail integration suite.
 *
 * A fresh GreenMail user only has INBOX (see greenmail-findings.md #4) —
 * the application itself never creates mailboxes (create_draft and
 * move_message both assume the target folder already exists), so the test
 * setup has to create Drafts/Archive/etc. once up front, the same way a
 * real mail provider would have pre-provisioned them.
 */

import { ImapFlow } from "imapflow";

export interface GreenmailImapAuth {
  host: string;
  port: number;
  user: string;
  pass: string;
}

/**
 * Connect and log in, retrying on failure. This absorbs a startup race
 * that plain port-readiness checks (see test/helpers/docker.ts) don't
 * cover: GreenMail's `-Dgreenmail.users=...` accounts aren't necessarily
 * registered yet at the moment the IMAP listener starts completing
 * handshakes, so the very first LOGIN attempt right after the container
 * comes up can fail with "Invalid login/password" even though the
 * credentials are correct and will work a few hundred milliseconds later.
 */
async function connectWithRetry(auth: GreenmailImapAuth, timeoutMs = 30_000): Promise<ImapFlow> {
  const start = Date.now();
  let lastErr: unknown;
  while (Date.now() - start < timeoutMs) {
    const client = new ImapFlow({
      host: auth.host,
      port: auth.port,
      secure: false,
      auth: { user: auth.user, pass: auth.pass },
      logger: false,
    });
    try {
      await client.connect();
      return client;
    } catch (err) {
      lastErr = err;
      await client.logout().catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(
    `Could not log in to GreenMail as "${auth.user}" within ${timeoutMs}ms: ${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }`
  );
}

/** Create each mailbox in `mailboxes` if it doesn't already exist. */
export async function ensureMailboxes(
  auth: GreenmailImapAuth,
  mailboxes: string[]
): Promise<void> {
  const client = await connectWithRetry(auth);
  try {
    for (const mailbox of mailboxes) {
      try {
        await client.mailboxCreate(mailbox);
      } catch (err) {
        // Idempotent by design: a fresh container never hits this branch,
        // but re-running against an already-provisioned one would.
        const message = err instanceof Error ? err.message : String(err);
        if (!/exist/i.test(message)) throw err;
      }
    }
  } finally {
    await client.logout().catch(() => {});
  }
}
