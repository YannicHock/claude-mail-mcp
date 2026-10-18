/**
 * The mail defects the v0.8 spec found (§9, F1–F4), and the BODYSTRUCTURE
 * groundwork the thread and attachment tools build on (§2.4, §3.1), against a
 * real GreenMail.
 *
 * A sibling of mail-server.test.ts rather than more tests in it: that file
 * threads one message through a fixed sequence of tools with accounts that keep
 * no Sent copy, and F1 needs an account that does. Each test here works in a
 * folder of its own (F2, F3, …), so none depends on what another left behind.
 *
 * Messages that the tools under test only read are put in place with a plain
 * IMAP APPEND, so their bytes are exactly the ones written here: a
 * quoted-printable body, a chosen internal date, a two-attachment layout.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { ImapFlow, type FetchMessageObject } from "imapflow";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { makeAccount, makeAccountsFile, makeTmpDir, cleanupTmpDir } from "../helpers/fixtures.js";
import { startMcpApp, type McpTestApp } from "../helpers/mcp-app.js";
import { isDockerAvailable, composeUp, composeDown, waitForGreenmailReady } from "../helpers/docker.js";
import { ensureMailboxes } from "../helpers/imap-setup.js";

const DOCKER_AVAILABLE = isDockerAvailable();
const SKIP: { skip: string } | Record<string, never> = DOCKER_AVAILABLE
  ? {}
  : { skip: "Docker is not available — skipping integration tests against GreenMail" };

const AUTH_TOKEN = "greenmail-defects-token";
const HOST = "127.0.0.1";
const IMAP_PORT = 3143;
const SMTP_PORT = 3025;

const USERS = {
  alice: { user: "alice", pass: "pw1" },
  bob: { user: "bob", pass: "pw2" },
} as const;

const FOLDERS = ["Drafts", "Sent", "F2", "F3", "F4", "M3", "Big"];

let dir: string | undefined;
let app: McpTestApp | undefined;
let client: Client | undefined;

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const result = (await client!.callTool({ name, arguments: args })) as CallToolResult;
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
async function withImap<T>(who: keyof typeof USERS, run: (imap: ImapFlow) => Promise<T>): Promise<T> {
  const imap = new ImapFlow({
    host: HOST,
    port: IMAP_PORT,
    secure: false,
    auth: USERS[who],
    logger: false,
  });
  await imap.connect();
  try {
    return await run(imap);
  } finally {
    await imap.logout().catch(() => {});
  }
}

async function appendRaw(
  who: keyof typeof USERS,
  mailbox: string,
  raw: string | Buffer,
  opts: { flags?: string[]; internalDate?: Date } = {}
): Promise<void> {
  await withImap(who, (imap) => imap.append(mailbox, raw, opts.flags ?? [], opts.internalDate));
}

/** Every message in `mailbox` whose source contains `needle`, raw. */
async function sourcesContaining(
  who: keyof typeof USERS,
  mailbox: string,
  needle: string
): Promise<string[]> {
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

/** The header block of a raw message, unfolded, as name → values. */
function headers(source: string): Map<string, string[]> {
  const end = source.indexOf("\r\n\r\n");
  const block = (end === -1 ? source : source.slice(0, end)).replace(/\r\n[ \t]+/g, " ");
  const map = new Map<string, string[]>();
  for (const line of block.split("\r\n")) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const list = map.get(name) ?? [];
    list.push(line.slice(colon + 1).trim());
    map.set(name, list);
  }
  return map;
}

function bodyOf(source: string): string {
  const end = source.indexOf("\r\n\r\n");
  return end === -1 ? "" : source.slice(end + 4);
}

/** A minimal RFC 5322 message with the given body headers and body. */
function rawMessage(opts: {
  subject: string;
  date?: string;
  contentType: string;
  encoding?: string;
  body: string;
}): string {
  return [
    `From: Carol <carol@example.com>`,
    `To: alice@example.com`,
    `Subject: ${opts.subject}`,
    `Date: ${opts.date ?? new Date().toUTCString()}`,
    `Message-ID: <${opts.subject.replace(/\W+/g, "-")}-${Date.now()}@example.com>`,
    `MIME-Version: 1.0`,
    `Content-Type: ${opts.contentType}`,
    ...(opts.encoding ? [`Content-Transfer-Encoding: ${opts.encoding}`] : []),
    ``,
    opts.body,
  ].join("\r\n");
}

async function compose(mail: ConstructorParameters<typeof MailComposer>[0]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    new MailComposer(mail).compile().build((err, message) => (err ? reject(err) : resolve(message)));
  });
}

interface Summary {
  uid: number;
  subject: string;
  date: string | null;
  preview: string | null;
}

before(async () => {
  if (!DOCKER_AVAILABLE) return;

  composeUp();
  await waitForGreenmailReady();

  await ensureMailboxes({ host: HOST, port: IMAP_PORT, ...USERS.alice }, FOLDERS);
  await ensureMailboxes({ host: HOST, port: IMAP_PORT, ...USERS.bob }, ["Drafts"]);

  dir = await makeTmpDir();
  const accountsFile = await makeAccountsFile(dir, [
    makeAccount({
      id: "alice",
      label: "Alice (GreenMail)",
      default: true,
      imap: { host: HOST, port: IMAP_PORT, ...USERS.alice, tls: false },
      smtp: { host: HOST, port: SMTP_PORT, ...USERS.alice, tls: false },
      mail: { defaultFrom: "alice@example.com", draftsFolder: "Drafts", sentFolder: "Sent" },
    }),
    makeAccount({
      id: "bob",
      label: "Bob (GreenMail)",
      default: false,
      imap: { host: HOST, port: IMAP_PORT, ...USERS.bob, tls: false },
      smtp: { host: HOST, port: SMTP_PORT, ...USERS.bob, tls: false },
      mail: { defaultFrom: "bob@example.com", draftsFolder: "Drafts", sentFolder: null },
    }),
  ]);
  app = await startMcpApp({ accountsFile, authToken: AUTH_TOKEN });

  client = new Client({ name: "mail-defects-test-client", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${app.url}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${AUTH_TOKEN}` } },
  });
  await client.connect(transport);
});

after(async () => {
  await client?.close().catch(() => {});
  await app?.close().catch(() => {});
  if (dir) await cleanupTmpDir(dir);
  if (DOCKER_AVAILABLE) composeDown();
});

const tag = `defects-${Date.now()}`;

// F1 (#239). Review focus 3: the Sent copy is the sent message.
test("F1: the Sent copy has the sent Message-ID and Date and keeps Bcc, which never went over SMTP", SKIP, async () => {
  const subject = `F1 ${tag}`;
  const result = (await callTool("send_message", {
    account: "alice",
    to: "alice@example.com",
    bcc: "bob@example.com",
    subject,
    text: "One message, sent and kept.",
    attachments: [{ filename: "a.txt", content_base64: Buffer.from("attached").toString("base64") }],
  })) as { messageId: string; saved_to_sent: boolean; accepted: string[] };
  assert.equal(result.saved_to_sent, true);
  assert.ok(result.accepted.includes("bob@example.com"), "the Bcc recipient was not in the envelope");

  const [copy] = await sourcesContaining("alice", "Sent", subject);
  const [delivered] = await sourcesContaining("alice", "INBOX", subject);
  const [blind] = await sourcesContaining("bob", "INBOX", subject);
  assert.ok(copy, "no Sent copy");
  assert.ok(delivered, "alice did not receive it");
  assert.ok(blind, "bob (Bcc) did not receive it");

  const copyHeaders = headers(copy!);
  const deliveredHeaders = headers(delivered!);

  // Same Message-ID: the answer's, the copy's and the delivered one's.
  assert.deepEqual(copyHeaders.get("message-id"), [result.messageId]);
  assert.deepEqual(deliveredHeaders.get("message-id"), [result.messageId]);
  // Same Date.
  assert.ok(copyHeaders.get("date"), "the copy has no Date");
  assert.deepEqual(copyHeaders.get("date"), deliveredHeaders.get("date"));
  // Bcc kept in the copy …
  assert.deepEqual(copyHeaders.get("bcc"), ["bob@example.com"]);
  // … and absent from what went over SMTP, for the To recipient and for the Bcc one.
  assert.equal(deliveredHeaders.get("bcc"), undefined, "the To recipient sees a Bcc header");
  assert.equal(headers(blind!).get("bcc"), undefined, "the Bcc recipient sees a Bcc header");
  // One composition: the MIME body (boundaries included) is byte for byte the
  // same. The final CRLF is the one SMTP's DATA terminator ("\r\n.\r\n")
  // shares with the message, which GreenMail does not store; APPEND keeps it.
  const trimmed = (s: string) => s.replace(/\r\n$/, "");
  assert.equal(trimmed(bodyOf(copy!)), trimmed(bodyOf(delivered!)));
});

// F2 (#240).
test("F2: list_messages unread_only and search_messages return the newest first, and the newest N", SKIP, async () => {
  for (const n of [1, 2, 3]) {
    await appendRaw(
      "alice",
      "F2",
      rawMessage({ subject: `F2 ${tag} #${n}`, contentType: "text/plain; charset=utf-8", body: `number ${n}` })
    );
  }

  const unread = (await callTool("list_messages", { mailbox: "F2", unread_only: true })) as { messages: Summary[] };
  assert.deepEqual(
    unread.messages.map((m) => m.subject),
    [`F2 ${tag} #3`, `F2 ${tag} #2`, `F2 ${tag} #1`]
  );
  const unreadTwo = (await callTool("list_messages", { mailbox: "F2", unread_only: true, limit: 2 })) as {
    messages: Summary[];
  };
  assert.deepEqual(
    unreadTwo.messages.map((m) => m.subject),
    [`F2 ${tag} #3`, `F2 ${tag} #2`]
  );

  const found = (await callTool("search_messages", { mailbox: "F2", subject: tag })) as { messages: Summary[] };
  assert.deepEqual(
    found.messages.map((m) => m.subject),
    [`F2 ${tag} #3`, `F2 ${tag} #2`, `F2 ${tag} #1`]
  );
  const foundTwo = (await callTool("search_messages", { mailbox: "F2", subject: tag, limit: 2 })) as {
    messages: Summary[];
  };
  assert.deepEqual(
    foundTwo.messages.map((m) => m.subject),
    [`F2 ${tag} #3`, `F2 ${tag} #2`]
  );
});

// F3 (#241).
test("F3: previews are decoded text, for quoted-printable, base64, a charset, alternative and HTML", SKIP, async () => {
  await appendRaw(
    "alice",
    "F3",
    rawMessage({
      subject: "qp",
      contentType: "text/plain; charset=utf-8",
      encoding: "quoted-printable",
      body: "Gr=C3=BC=C3=9Fe aus K=C3=B6ln",
    })
  );
  await appendRaw(
    "alice",
    "F3",
    rawMessage({
      subject: "b64",
      contentType: "text/plain; charset=utf-8",
      encoding: "base64",
      body: Buffer.from("Grüße aus Köln, in base64.").toString("base64"),
    })
  );
  await appendRaw(
    "alice",
    "F3",
    rawMessage({
      subject: "latin1",
      contentType: "text/plain; charset=iso-8859-1",
      encoding: "quoted-printable",
      body: "Gr=FC=DFe aus K=F6ln",
    })
  );
  await appendRaw(
    "alice",
    "F3",
    await compose({
      from: "carol@example.com",
      to: "alice@example.com",
      subject: "alternative",
      text: "Plain Grüße aus Köln",
      html: "<p>HTML Grüße</p>",
    })
  );
  await appendRaw(
    "alice",
    "F3",
    await compose({
      from: "carol@example.com",
      to: "alice@example.com",
      subject: "html only",
      html: "<html><head><style>p { color: red }</style></head><body><p>Hallo &amp; Gr&uuml;&szlig;e</p><p>aus K&ouml;ln</p></body></html>",
    })
  );

  const list = (await callTool("list_messages", { mailbox: "F3" })) as { messages: Summary[] };
  const preview = (subject: string) => list.messages.find((m) => m.subject === subject)?.preview;

  assert.equal(preview("qp"), "Grüße aus Köln");
  assert.equal(preview("b64"), "Grüße aus Köln, in base64.");
  assert.equal(preview("latin1"), "Grüße aus Köln");
  assert.equal(preview("alternative"), "Plain Grüße aus Köln");
  assert.equal(preview("html only"), "Hallo & Grüße aus Köln");
});

// F4 (#242).
test("F4: get_message's date is the Date header, as list_messages reports it; internalDate is its own field", SKIP, async () => {
  const internalDate = new Date("2024-01-02T03:04:05.000Z");
  await appendRaw(
    "alice",
    "F4",
    rawMessage({
      subject: `F4 ${tag}`,
      date: "Mon, 01 Jun 2020 10:00:00 +0200",
      contentType: "text/plain; charset=utf-8",
      body: "dated",
    }),
    { internalDate }
  );

  const list = (await callTool("list_messages", { mailbox: "F4" })) as { messages: Summary[] };
  const summary = list.messages.find((m) => m.subject === `F4 ${tag}`);
  assert.ok(summary);
  const detail = (await callTool("get_message", { mailbox: "F4", uid: summary!.uid })) as {
    date: string | null;
    internalDate: string | null;
  };
  assert.equal(detail.date, "2020-06-01T08:00:00.000Z");
  assert.equal(detail.date, summary!.date);
  assert.equal(detail.internalDate, internalDate.toISOString());
});

// Spec §2.4, §3.1: the M3 message.
test("get_message reports each attachment's part and its decoded size", SKIP, async () => {
  const blob = Buffer.alloc(300_000, 7);
  await appendRaw(
    "alice",
    "M3",
    await compose({
      from: "carol@example.com",
      to: "alice@example.com",
      subject: `M3 ${tag}`,
      text: "Two attachments.",
      attachments: [
        { filename: "notes.txt", content: "Some notes.\n", contentType: "text/plain" },
        { filename: "blob.bin", content: blob, contentType: "application/octet-stream" },
      ],
    })
  );
  const list = (await callTool("list_messages", { mailbox: "M3" })) as { messages: Summary[] };
  const uid = list.messages.find((m) => m.subject === `M3 ${tag}`)!.uid;
  const detail = (await callTool("get_message", { mailbox: "M3", uid })) as {
    bodyText: string | null;
    attachments: Array<{ filename: string | null; contentType: string; size: number; part: string }>;
  };
  assert.equal(detail.bodyText?.trim(), "Two attachments.");
  const byName = new Map(detail.attachments.map((a) => [a.filename, a]));
  assert.deepEqual(
    detail.attachments.map((a) => a.filename),
    ["notes.txt", "blob.bin"]
  );
  assert.equal(byName.get("notes.txt")?.part, "2");
  assert.equal(byName.get("notes.txt")?.contentType, "text/plain");
  assert.equal(byName.get("blob.bin")?.part, "3");
  assert.equal(byName.get("blob.bin")?.contentType, "application/octet-stream");
  // Decoded, not the 410,670 BODYSTRUCTURE reports. Not exactly 300,000 here:
  // GreenMail counts the part's 144 bytes of MIME header into its size, which
  // a server like Dovecot does not (test/unit/mail-parts.test.ts has the exact
  // case). Within 0.1 %.
  const size = byName.get("blob.bin")!.size;
  assert.ok(Math.abs(size - 300_000) <= 300, `blob.bin size ${size}, expected about 300,000`);
});

// Spec §3.1's last bullet: a large message is read by part.
test("get_message reads a message over 2 MB by part, without downloading its attachment", SKIP, async () => {
  const big = Buffer.alloc(3 * 1024 * 1024, 1);
  await appendRaw(
    "alice",
    "Big",
    await compose({
      from: "carol@example.com",
      to: "alice@example.com",
      subject: `Big ${tag}`,
      references: ["<root@example.com>", "<parent@example.com>"],
      inReplyTo: "<parent@example.com>",
      text: "Grüße, the text of a large message.",
      html: "<p>Grüße, the <b>HTML</b> of a large message.</p>",
      attachments: [{ filename: "big.bin", content: big, contentType: "application/octet-stream" }],
    })
  );

  // Watch what the connector asks the server for: no whole-message source.
  const { imap } = app!.pool.for("alice");
  const original = imap.withMailbox.bind(imap);
  const asked: unknown[] = [];
  imap.withMailbox = ((mailbox, fn) =>
    original(mailbox, (c) =>
      fn(
        new Proxy(c, {
          get(target, prop, receiver) {
            const value = Reflect.get(target, prop, receiver);
            if ((prop === "fetchOne" || prop === "fetch") && typeof value === "function") {
              return (...args: unknown[]) => {
                asked.push(args[1]);
                return value.apply(target, args);
              };
            }
            return typeof value === "function" ? value.bind(target) : value;
          },
        })
      )
    )) as typeof imap.withMailbox;

  try {
    const list = (await callTool("list_messages", { mailbox: "Big" })) as { messages: Summary[] };
    const uid = list.messages.find((m) => m.subject === `Big ${tag}`)!.uid;
    asked.length = 0;
    const detail = (await callTool("get_message", { mailbox: "Big", uid })) as {
      subject: string;
      from: string;
      references: string[];
      inReplyTo: string | null;
      bodyText: string | null;
      bodyHtml: string | null;
      attachments: Array<{ filename: string | null; size: number; part: string }>;
    };
    assert.equal(detail.subject, `Big ${tag}`);
    assert.match(detail.from, /carol@example\.com/);
    assert.deepEqual(detail.references, ["<root@example.com>", "<parent@example.com>"]);
    assert.equal(detail.inReplyTo, "<parent@example.com>");
    assert.equal(detail.bodyText?.trim(), "Grüße, the text of a large message.");
    assert.equal(detail.bodyHtml?.trim(), "<p>Grüße, the <b>HTML</b> of a large message.</p>");
    assert.equal(detail.attachments.length, 1);
    assert.equal(detail.attachments[0]!.filename, "big.bin");
    assert.equal(detail.attachments[0]!.size, big.length);
    assert.ok(asked.length > 0, "the proxy saw no fetch at all");
    for (const query of asked) {
      assert.ok(
        !(query && typeof query === "object" && "source" in query),
        `get_message fetched the whole source of a large message: ${JSON.stringify(query)}`
      );
    }
  } finally {
    imap.withMailbox = original;
  }
});
