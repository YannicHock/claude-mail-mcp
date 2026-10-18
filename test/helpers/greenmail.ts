/**
 * What the GreenMail-backed integration files share: the two users, an MCP
 * client against the in-process app, a tool call that unwraps the JSON answer,
 * and a short IMAP session of the test's own for putting messages in place and
 * reading their raw bytes back.
 *
 * Lifecycle (compose up/down, readiness) stays in test/helpers/docker.ts, and
 * creating folders in test/helpers/imap-setup.ts.
 */

import { ImapFlow, type FetchMessageObject } from "imapflow";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export const GREENMAIL_HOST = "127.0.0.1";
export const GREENMAIL_IMAP_PORT = 3143;
export const GREENMAIL_SMTP_PORT = 3025;

/** The users docker-compose.test.yml creates. Log in with the local part. */
export const GREENMAIL_USERS = {
  alice: { user: "alice", pass: "pw1" },
  bob: { user: "bob", pass: "pw2" },
} as const;

export type GreenmailUser = keyof typeof GREENMAIL_USERS;

/** An MCP client connected to the app at `appUrl`, with the Bearer token. */
export async function connectMcpClient(appUrl: string, authToken: string, name: string): Promise<Client> {
  const client = new Client({ name, version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${appUrl}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${authToken}` } },
  });
  await client.connect(transport);
  return client;
}

/** Call a tool and parse its JSON text answer; an error result throws. */
export async function callTool(client: Client, name: string, args: Record<string, unknown>): Promise<unknown> {
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
  if (result.isError) {
    throw new Error(`Tool "${name}" returned an error result: ${JSON.stringify(result)}`);
  }
  const first = result.content[0];
  if (!first || first.type !== "text") {
    throw new Error(`Tool "${name}" returned no text content: ${JSON.stringify(result)}`);
  }
  return JSON.parse(first.text);
}

/** A short-lived IMAP session of the test's own, beside the connector's. */
export async function withImap<T>(who: GreenmailUser, run: (imap: ImapFlow) => Promise<T>): Promise<T> {
  const imap = new ImapFlow({
    host: GREENMAIL_HOST,
    port: GREENMAIL_IMAP_PORT,
    secure: false,
    auth: GREENMAIL_USERS[who],
    logger: false,
  });
  await imap.connect();
  try {
    return await run(imap);
  } finally {
    await imap.logout().catch(() => {});
  }
}

/** APPEND exactly these bytes, with optional flags and internal date. */
export async function appendRaw(
  who: GreenmailUser,
  mailbox: string,
  raw: string | Buffer,
  opts: { flags?: string[]; internalDate?: Date } = {}
): Promise<void> {
  await withImap(who, (imap) => imap.append(mailbox, raw, opts.flags ?? [], opts.internalDate));
}

/** The raw source of every message in `mailbox` that contains `needle`. */
export async function sourcesContaining(who: GreenmailUser, mailbox: string, needle: string): Promise<string[]> {
  return withImap(who, async (imap) => {
    const lock = await imap.getMailboxLock(mailbox);
    try {
      const out: string[] = [];
      for await (const msg of imap.fetch("1:*", { source: true }) as AsyncIterable<FetchMessageObject>) {
        const text = (msg.source as Buffer).toString("utf8");
        if (text.includes(needle)) out.push(text);
      }
      return out;
    } finally {
      lock.release();
    }
  });
}
