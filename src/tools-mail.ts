/**
 * Mail tool registry.
 *
 * v0.2: every tool accepts an optional `account` parameter selecting which
 * configured mailbox to act on. Omitted = the default account. The pool
 * lazy-instantiates IMAP/SMTP clients per account.
 *
 * Destructive operations (delete_message) document irreversibility in their
 * description so Claude.ai surfaces a confirmation step in the UI.
 *
 * v0.7.1 (#146): every call that reaches a mailbox runs inside
 * `reportingFailures()`, so a failure names the account and says whether the
 * server rejected the credentials or was never reached — and leaves one `warn`
 * line saying the same. `pool.for()` stays outside that wrapper on purpose: an
 * unknown account id is the caller's mistake, not a mailbox that failed.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ClientPool } from "./client-pool.js";
import { AccountsStore } from "./accounts.js";
import { reportingFailures, logToolFailure } from "./tool-errors.js";

function asJson(value: unknown): { content: { type: "text"; text: string }[] } {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

const recipientSchema = z.union([z.string(), z.array(z.string()).min(1)]);

const accountSchema = z
  .string()
  .optional()
  .describe(
    "Account ID (from list_accounts) to act on. Omit to use the default account."
  );

export function registerMailTools(
  server: McpServer,
  pool: ClientPool,
  store: AccountsStore
): void {
  server.registerTool(
    "list_accounts",
    {
      description:
        "List all configured mailbox accounts on this connector. Returns id, label, default flag, From-address and CalDAV-enabled flag — never credentials. Use the `id` value as the `account` parameter on other tools.",
      inputSchema: {},
    },
    async () => {
      const summaries = store.publicSummaries();
      return asJson({
        count: summaries.length,
        accounts: summaries,
        note:
          summaries.length === 0
            ? "No accounts configured yet. Add one under /settings/mailboxes on this deployment's public URL."
            : undefined,
      });
    }
  );

  server.registerTool(
    "list_folders",
    {
      description:
        "List all IMAP mailboxes (folders) on the configured account. Returns path, name, flags and special-use attribute (e.g. \\Sent, \\Drafts, \\Trash) — useful for picking the right `mailbox` parameter for other tools.",
      inputSchema: {
        account: accountSchema,
      },
    },
    async ({ account }) => {
      const { imap, id } = pool.for(account);
      return asJson(
        await reportingFailures(pool, "list_folders", id, () => imap.listMailboxes())
      );
    }
  );

  server.registerTool(
    "list_messages",
    {
      description:
        "List the newest messages in a mailbox (newest first). Returns headers + a short preview, NOT the full body — use get_message for the body.",
      inputSchema: {
        mailbox: z
          .string()
          .describe("IMAP folder path (e.g. 'INBOX', 'Sent', 'Archive/2026')"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe("Max messages to return (default 25)"),
        unread_only: z
          .boolean()
          .optional()
          .describe("Return only unread messages"),
        account: accountSchema,
      },
    },
    async ({ mailbox, limit, unread_only, account }) => {
      const { imap, id } = pool.for(account);
      const list = await reportingFailures(pool, "list_messages", id, () =>
        imap.listMessages(mailbox, { limit, unreadOnly: unread_only })
      );
      return asJson({ mailbox, account: id, count: list.length, messages: list });
    }
  );

  server.registerTool(
    "search_messages",
    {
      description:
        "Server-side IMAP SEARCH across one mailbox. Combine any criteria (AND-style). Dates must be ISO YYYY-MM-DD. Returns headers + short preview — use get_message for the body.",
      inputSchema: {
        mailbox: z.string().describe("IMAP folder path to search in"),
        from: z.string().optional().describe("Substring match in From: header"),
        to: z.string().optional().describe("Substring match in To: header"),
        subject: z.string().optional().describe("Substring match in Subject:"),
        body: z
          .string()
          .optional()
          .describe("Substring match in the message body"),
        since: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe("Match messages on/after this date (YYYY-MM-DD)"),
        before: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe("Match messages strictly before this date (YYYY-MM-DD)"),
        unread: z
          .boolean()
          .optional()
          .describe("true = unread only, false = read only"),
        flagged: z
          .boolean()
          .optional()
          .describe("true = flagged only, false = unflagged only"),
        limit: z.number().int().min(1).max(200).optional(),
        account: accountSchema,
      },
    },
    async ({ mailbox, limit, account, ...criteria }) => {
      const { imap, id } = pool.for(account);
      const list = await reportingFailures(pool, "search_messages", id, () =>
        imap.searchMessages(mailbox, criteria, limit ?? 25)
      );
      return asJson({ mailbox, account: id, count: list.length, messages: list });
    }
  );

  server.registerTool(
    "get_message",
    {
      description:
        "Fetch one message by UID. Returns headers, full text+HTML body, attachment metadata (filenames + content types, NOT raw bytes), and threading IDs (Message-ID, In-Reply-To, References) for replies.",
      inputSchema: {
        mailbox: z.string().describe("IMAP folder the message lives in"),
        uid: z
          .number()
          .int()
          .positive()
          .describe("Message UID as returned by list_messages/search_messages"),
        account: accountSchema,
      },
    },
    async ({ mailbox, uid, account }) => {
      const { imap, id } = pool.for(account);
      return asJson(
        await reportingFailures(pool, "get_message", id, () => imap.getMessage(mailbox, uid))
      );
    }
  );

  server.registerTool(
    "send_message",
    {
      description:
        "Send an email via SMTP. WRITE OPERATION — the message goes out immediately. Use create_draft instead if you want to review before sending. Saves a copy in the Sent folder if configured. For replies, pass in_reply_to + references from the original get_message result.",
      inputSchema: {
        to: recipientSchema.describe(
          "Recipient(s). String or array of email addresses."
        ),
        subject: z.string().min(1).describe("Subject line"),
        text: z.string().optional().describe("Plain-text body"),
        html: z.string().optional().describe("HTML body"),
        cc: recipientSchema.optional(),
        bcc: recipientSchema.optional(),
        reply_to: z.string().optional().describe("Reply-To header"),
        in_reply_to: z
          .string()
          .optional()
          .describe("Message-ID being replied to (for threading)"),
        references: z
          .array(z.string())
          .optional()
          .describe("References header values (for threading)"),
        attachments: z
          .array(
            z.object({
              filename: z.string(),
              content_base64: z.string(),
              content_type: z.string().optional(),
            })
          )
          .optional(),
        account: accountSchema,
      },
    },
    async (args) => {
      if (!args.text && !args.html) {
        throw new Error("Provide at least one of `text` or `html`.");
      }
      const { smtp, imap, sentFolder, id } = pool.for(args.account);
      const result = await reportingFailures(pool, "send_message", id, () =>
        smtp.send({
          to: args.to,
          cc: args.cc,
          bcc: args.bcc,
          subject: args.subject,
          text: args.text,
          html: args.html,
          replyTo: args.reply_to,
          inReplyTo: args.in_reply_to,
          references: args.references,
          attachments: args.attachments?.map((a) => ({
            filename: a.filename,
            contentBase64: a.content_base64,
            contentType: a.content_type,
          })),
        })
      );
      // Best-effort copy to Sent folder.
      let savedToSent = false;
      if (sentFolder) {
        try {
          const raw = await smtp.buildRawSource({
            to: args.to,
            cc: args.cc,
            bcc: args.bcc,
            subject: args.subject,
            text: args.text,
            html: args.html,
            replyTo: args.reply_to,
            inReplyTo: args.in_reply_to,
            references: args.references,
            attachments: args.attachments?.map((a) => ({
              filename: a.filename,
              contentBase64: a.content_base64,
              contentType: a.content_type,
            })),
          });
          await imap.append(sentFolder, raw, ["\\Seen"]);
          savedToSent = true;
        } catch (err) {
          // Sent-folder copy is best effort; the actual send already succeeded,
          // so this must not fail the call. It must not be silent either — this
          // is the bare `catch {}` #146 was filed against, and an IMAP password
          // the server refuses shows up here while SMTP keeps working. One warn
          // line, the classified reason, the account named, `saved_to_sent:
          // false` in the answer as before.
          logToolFailure(pool, "send_message", id, err, { stage: "save_to_sent" });
        }
      }
      return asJson({ ...result, saved_to_sent: savedToSent });
    }
  );

  server.registerTool(
    "create_draft",
    {
      description:
        "Build an RFC-822 message and APPEND it to the Drafts folder. Does NOT send. Use for compose-and-review flows where the user wants to edit in their mail client before sending.",
      inputSchema: {
        to: recipientSchema,
        subject: z.string().min(1),
        text: z.string().optional(),
        html: z.string().optional(),
        cc: recipientSchema.optional(),
        bcc: recipientSchema.optional(),
        in_reply_to: z.string().optional(),
        references: z.array(z.string()).optional(),
        account: accountSchema,
      },
    },
    async (args) => {
      if (!args.text && !args.html) {
        throw new Error("Provide at least one of `text` or `html`.");
      }
      const { smtp, imap, draftsFolder, id } = pool.for(args.account);
      const raw = await smtp.buildRawSource({
        to: args.to,
        cc: args.cc,
        bcc: args.bcc,
        subject: args.subject,
        text: args.text,
        html: args.html,
        inReplyTo: args.in_reply_to,
        references: args.references,
      });
      await reportingFailures(pool, "create_draft", id, () =>
        imap.append(draftsFolder, raw, ["\\Draft", "\\Seen"])
      );
      return asJson({
        success: true,
        folder: draftsFolder,
        bytes: raw.length,
      });
    }
  );

  server.registerTool(
    "mark_read",
    {
      description:
        "Set or clear the \\Seen flag on a message. WRITE OPERATION but easily reversible.",
      inputSchema: {
        mailbox: z.string(),
        uid: z.number().int().positive(),
        read: z.boolean().describe("true = mark as read, false = mark unread"),
        account: accountSchema,
      },
    },
    async ({ mailbox, uid, read, account }) => {
      const { imap, id } = pool.for(account);
      await reportingFailures(pool, "mark_read", id, () => imap.markRead(mailbox, uid, read));
      return asJson({ success: true, mailbox, uid, read });
    }
  );

  server.registerTool(
    "move_message",
    {
      description:
        "Move a message from one mailbox to another (e.g. Inbox → Archive). WRITE OPERATION.",
      inputSchema: {
        source_mailbox: z.string(),
        uid: z.number().int().positive(),
        destination_mailbox: z.string(),
        account: accountSchema,
      },
    },
    async ({ source_mailbox, uid, destination_mailbox, account }) => {
      const { imap, id } = pool.for(account);
      await reportingFailures(pool, "move_message", id, () =>
        imap.moveMessage(source_mailbox, uid, destination_mailbox)
      );
      return asJson({
        success: true,
        from: source_mailbox,
        to: destination_mailbox,
        uid,
      });
    }
  );

  server.registerTool(
    "delete_message",
    {
      description:
        "Delete a message. DESTRUCTIVE — most IMAP servers move it to Trash but some EXPUNGE immediately. Prefer move_message to a Trash folder for reversibility.",
      inputSchema: {
        mailbox: z.string(),
        uid: z.number().int().positive(),
        account: accountSchema,
      },
    },
    async ({ mailbox, uid, account }) => {
      const { imap, id } = pool.for(account);
      await reportingFailures(pool, "delete_message", id, () =>
        imap.deleteMessage(mailbox, uid)
      );
      return asJson({ success: true, mailbox, uid });
    }
  );
}
