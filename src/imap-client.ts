/**
 * IMAP client wrapper around imapflow.
 *
 * Holds a single long-lived connection that auto-reconnects on demand.
 * Each operation acquires a mailbox lock so concurrent tool calls don't
 * collide on the IMAP `SELECT` state.
 *
 * Tool handlers stay thin: they call high-level methods here, get back
 * plain JSON-shaped objects, and don't see imapflow internals.
 *
 * v0.8: every operation on a selected mailbox goes through `withMailbox()`,
 * the one place a mailbox is connected to and locked, so code outside this
 * class (threads, attachments) can run its own FETCH under the same rule.
 * Which parts a message has, which of them is its text and how large each is
 * once decoded is src/mail-parts.ts's business, read from BODYSTRUCTURE.
 */

import {
  ImapFlow,
  ImapFlowOptions,
  FetchMessageObject,
  MessageStructureObject,
} from "imapflow";
import { simpleParser, ParsedMail } from "mailparser";
import { convert as htmlToText } from "html-to-text";

import {
  imapTlsOptions,
  localMailAddress,
  startTlsError,
  type LocalAddressCheck,
  type MailTlsTestOptions,
} from "./mail-tls.js";
import {
  attachmentParts,
  bodyParts,
  decodePart,
  leafParts,
  previewPart,
  type Part,
} from "./mail-parts.js";
import { addrText, isoDate } from "./mail-envelope.js";

export interface ImapAuth {
  host: string;
  port: number;
  user: string;
  pass: string;
  secure: boolean;
}

export interface MailboxSummary {
  path: string;
  name: string;
  delimiter: string;
  flags: string[];
  specialUse?: string;
  subscribed: boolean;
  listed: boolean;
}

export interface MessageSummary {
  uid: number;
  seq: number;
  flags: string[];
  /** The Date header, in every tool (F4, #242). */
  date: string | null;
  subject: string | null;
  from: string | null;
  to: string | null;
  cc: string | null;
  size: number | null;
  preview: string | null;
}

export interface MessageDetail extends MessageSummary {
  /**
   * The server's INTERNALDATE: when the message arrived in this mailbox. `date`
   * is the Date header, as in the list tools, and falls back to this when the
   * message has none (F4, #242).
   */
  internalDate: string | null;
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  bodyText: string | null;
  bodyHtml: string | null;
  attachments: AttachmentSummary[];
}

/** One attachment of a message, from its BODYSTRUCTURE (spec §2.4, §3.1). */
export interface AttachmentSummary {
  filename: string | null;
  contentType: string;
  /**
   * Decoded size in bytes, an upper-bound estimate from BODYSTRUCTURE
   * (src/mail-parts.ts `decodedSize`): never below the real size, up to about
   * 3 % above it for base64.
   */
  size: number;
  contentId: string | null;
  /**
   * IMAP part id ("2", "1.2"): what an attachment download asks for. Null only
   * when the server sent no BODYSTRUCTURE, and the list is mailparser's.
   */
  part: string | null;
}

export interface SearchCriteria {
  from?: string;
  to?: string;
  subject?: string;
  body?: string;
  since?: string; // YYYY-MM-DD
  before?: string; // YYYY-MM-DD
  unread?: boolean;
  flagged?: boolean;
}

/**
 * Above this size (RFC822.SIZE, the whole message) `get_message` reads a
 * message by part, its header block and its body parts only, instead of
 * downloading all of it to show its text (spec §3.1): a 40 MB message with one
 * attachment no longer costs 40 MB.
 */
export const WHOLE_MESSAGE_MAX_BYTES = 2 * 1024 * 1024;

/**
 * How much of a body part a list preview fetches. A preview is 200
 * characters; HTML gets more room because a style block can come first.
 */
const PREVIEW_FETCH_BYTES = { text: 4 * 1024, html: 16 * 1024 };
const PREVIEW_CHARS = 200;

/** What a call waiting on a connect is told when close() abandoned it. */
export const CLOSED_WHILE_CONNECTING = "the IMAP connection was closed while it was being opened";

export class ImapClient {
  private client: ImapFlow | null = null;
  private connecting: Promise<ImapFlow> | null = null;
  /** Bumped by close(), so a connect that outlives it knows not to be kept. */
  private generation = 0;
  private readonly host: string;
  private readonly secure: boolean;
  /** Everything but the host and TLS, which src/mail-tls.ts decides per connect. */
  private readonly opts: Omit<ImapFlowOptions, "host" | "secure">;
  private readonly localAddress: LocalAddressCheck;

  constructor(auth: ImapAuth, options: MailTlsTestOptions = {}) {
    this.host = auth.host;
    this.secure = auth.secure;
    this.opts = {
      port: auth.port,
      auth: { user: auth.user, pass: auth.pass },
      logger: false,
    };
    this.localAddress = options.localAddress ?? localMailAddress;
  }

  /**
   * One connect at a time, shared by every caller that arrives while it runs.
   * A connect that fails is forgotten, so the next call tries again: a network
   * blip, a lookup that timed out or a STARTTLS refusal must not leave every
   * IMAP tool for the account failing on the same rejected promise until the
   * connector restarts.
   */
  private async ensureConnected(): Promise<ImapFlow> {
    if (this.client && this.client.usable) return this.client;
    if (this.connecting) return this.connecting;
    const attempt = this.connect();
    this.connecting = attempt;
    try {
      return await attempt;
    } finally {
      if (this.connecting === attempt) this.connecting = null;
    }
  }

  private async connect(): Promise<ImapFlow> {
    const generation = this.generation;
    // Host and TLS per connect, by src/mail-tls.ts (#220).
    const tls = await imapTlsOptions(this.host, this.secure, this.localAddress);
    if (this.generation !== generation) throw new Error(CLOSED_WHILE_CONNECTING);
    const client = new ImapFlow({ ...this.opts, ...tls });
    client.on("error", () => {
      // Mark unusable so next call reconnects.
      if (this.client === client) this.client = null;
    });
    try {
      await client.connect();
    } catch (err) {
      // Closes the socket without a word to the server, which may never have
      // reached a state where LOGOUT means anything.
      client.close();
      throw startTlsError(err);
    }
    if (this.generation !== generation) {
      // close() was called while this connect was in flight. Keeping the
      // connection would hand the next call one its owner closed, or leak it.
      try {
        await client.logout();
      } catch {
        // best effort
      }
      throw new Error(CLOSED_WHILE_CONNECTING);
    }
    this.client = client;
    return client;
  }

  /**
   * Also abandons a connect still in flight: it finds the generation changed
   * when it completes, and logs out instead of becoming the connection.
   */
  async close(): Promise<void> {
    this.generation += 1;
    this.connecting = null;
    if (this.client) {
      const c = this.client;
      this.client = null;
      try {
        await c.logout();
      } catch {
        // best effort
      }
    }
  }

  /**
   * Connect, lock `mailbox`, run `fn` with the connection, release the lock.
   *
   * Every operation on a selected mailbox goes through here, and code outside
   * this class (threads, attachments) builds on it rather than on a second
   * copy of the connect-and-lock rule. `fn` must not keep the client past its
   * promise: the lock, and with it the selected mailbox, is gone once that
   * settles.
   */
  async withMailbox<T>(mailbox: string, fn: (client: ImapFlow) => Promise<T>): Promise<T> {
    const client = await this.ensureConnected();
    const lock = await client.getMailboxLock(mailbox);
    try {
      return await fn(client);
    } finally {
      lock.release();
    }
  }

  async listMailboxes(): Promise<MailboxSummary[]> {
    const client = await this.ensureConnected();
    const list = await client.list();
    return list.map((m) => ({
      path: m.path,
      name: m.name,
      delimiter: m.delimiter ?? "/",
      flags: Array.from(m.flags ?? []),
      specialUse: m.specialUse ?? undefined,
      subscribed: Boolean(m.subscribed),
      listed: Boolean(m.listed),
    }));
  }

  async listMessages(
    mailbox: string,
    opts: { limit?: number; unreadOnly?: boolean } = {}
  ): Promise<MessageSummary[]> {
    return this.withMailbox(mailbox, async (client) => {
      const status = await client.status(mailbox, { messages: true });
      const total = status.messages ?? 0;
      if (total === 0) return [];
      const limit = Math.min(opts.limit ?? 25, 200);

      if (opts.unreadOnly) {
        const found = await client.search({ seen: false }, { uid: true });
        const uids = newestUids(found, limit);
        if (uids.length === 0) return [];
        return await this.fetchSummaries(client, uids.join(","), true);
      }
      // Fetch the newest `limit` by sequence number.
      const from = Math.max(1, total - limit + 1);
      return await this.fetchSummaries(client, `${from}:*`, false);
    });
  }

  async searchMessages(
    mailbox: string,
    criteria: SearchCriteria,
    limit = 25
  ): Promise<MessageSummary[]> {
    return this.withMailbox(mailbox, async (client) => {
      const query: Record<string, unknown> = {};
      if (criteria.from) query.from = criteria.from;
      if (criteria.to) query.to = criteria.to;
      if (criteria.subject) query.subject = criteria.subject;
      if (criteria.body) query.body = criteria.body;
      if (criteria.since) query.since = new Date(criteria.since);
      if (criteria.before) query.before = new Date(criteria.before);
      if (criteria.unread === true) query.seen = false;
      if (criteria.unread === false) query.seen = true;
      if (criteria.flagged === true) query.flagged = true;
      if (criteria.flagged === false) query.unflagged = true;

      const found = await client.search(query, { uid: true });
      const uids = newestUids(found, Math.min(limit, 200));
      if (uids.length === 0) return [];
      return await this.fetchSummaries(client, uids.join(","), true);
    });
  }

  async getMessage(mailbox: string, uid: number): Promise<MessageDetail> {
    return this.withMailbox(mailbox, async (client) => {
      const meta = await client.fetchOne(
        `${uid}`,
        { envelope: true, flags: true, internalDate: true, size: true, bodyStructure: true },
        { uid: true }
      );
      if (!meta) {
        throw new Error(`Message UID ${uid} not found in ${mailbox}`);
      }
      const structure = meta.bodyStructure;
      const size = meta.size ?? null;
      const content =
        structure && size !== null && size > WHOLE_MESSAGE_MAX_BYTES
          ? await readByPart(client, uid, mailbox, structure)
          : await readWhole(client, uid, mailbox);
      const parsed = content.parsed;
      const internalDate = isoDate(meta.internalDate);

      return {
        uid: meta.uid,
        seq: meta.seq,
        flags: Array.from(meta.flags ?? []),
        // The Date header, as list_messages reports it (F4, #242).
        date: isoDate(meta.envelope?.date) ?? internalDate,
        internalDate,
        subject: parsed.subject ?? null,
        from: parsed.from?.text ?? null,
        to: Array.isArray(parsed.to)
          ? parsed.to.map((a) => a.text).join(", ")
          : parsed.to?.text ?? null,
        cc: Array.isArray(parsed.cc)
          ? parsed.cc.map((a) => a.text).join(", ")
          : parsed.cc?.text ?? null,
        size,
        // Normalised as the list previews are.
        preview: content.bodyText ? previewOf(content.bodyText) : null,
        messageId: parsed.messageId ?? null,
        inReplyTo: parsed.inReplyTo ?? null,
        references: Array.isArray(parsed.references)
          ? parsed.references
          : parsed.references
            ? [parsed.references]
            : [],
        bodyText: content.bodyText,
        bodyHtml: content.bodyHtml,
        attachments: structure
          ? attachmentParts(structure).map(toAttachmentSummary)
          : // No BODYSTRUCTURE from the server: mailparser's list, without part ids.
            (parsed.attachments ?? []).map((a) => ({
              filename: a.filename ?? null,
              contentType: a.contentType,
              size: a.size,
              contentId: a.cid ?? null,
              part: null,
            })),
      };
    });
  }

  async markRead(
    mailbox: string,
    uid: number,
    read: boolean
  ): Promise<void> {
    await this.withMailbox(mailbox, async (client) => {
      if (read) {
        await client.messageFlagsAdd(`${uid}`, ["\\Seen"], { uid: true });
      } else {
        await client.messageFlagsRemove(`${uid}`, ["\\Seen"], { uid: true });
      }
    });
  }

  async moveMessage(
    sourceMailbox: string,
    uid: number,
    destinationMailbox: string
  ): Promise<void> {
    await this.withMailbox(sourceMailbox, async (client) => {
      await client.messageMove(`${uid}`, destinationMailbox, { uid: true });
    });
  }

  async deleteMessage(mailbox: string, uid: number): Promise<void> {
    await this.withMailbox(mailbox, async (client) => {
      await client.messageDelete(`${uid}`, { uid: true });
    });
  }

  /**
   * Append a raw RFC 822 message to a folder — used for drafts and for
   * keeping a copy of sent messages. APPEND needs no selected mailbox, so it
   * takes no lock.
   */
  async append(
    mailbox: string,
    raw: string | Buffer,
    flags: string[]
  ): Promise<void> {
    const client = await this.ensureConnected();
    await client.append(mailbox, raw, flags);
  }

  /**
   * Summaries for `range`, newest first, with decoded previews.
   *
   * Two steps. The first FETCH reads the envelopes and BODYSTRUCTURE; the
   * second reads the first few kilobytes of each message's text part (else its
   * HTML), one FETCH per distinct part id, so a page of ordinary messages costs
   * two or three round trips. The bytes are decoded here, transfer encoding
   * and charset, because the server sends them as stored (F3, #241).
   *
   * Sorted by UID after the fetch: a server answers a FETCH in mailbox order,
   * whatever order the UIDs were asked in (F2, #240).
   */
  private async fetchSummaries(
    client: ImapFlow,
    range: string,
    byUid: boolean
  ): Promise<MessageSummary[]> {
    const fetched: Array<{ msg: FetchMessageObject; part: Part | null }> = [];
    const fetchOpts = {
      envelope: true,
      flags: true,
      internalDate: true,
      size: true,
      bodyStructure: true,
    };
    for await (const msg of client.fetch(range, fetchOpts, { uid: byUid })) {
      fetched.push({ msg, part: msg.bodyStructure ? previewPart(msg.bodyStructure) : null });
    }

    const groups = new Map<string, { part: string; maxLength: number; uids: number[] }>();
    for (const { msg, part } of fetched) {
      if (!part) continue;
      const maxLength = part.type === "text/html" ? PREVIEW_FETCH_BYTES.html : PREVIEW_FETCH_BYTES.text;
      const key = `${part.part}:${maxLength}`;
      const group = groups.get(key) ?? { part: part.part, maxLength, uids: [] };
      group.uids.push(msg.uid);
      groups.set(key, group);
    }
    const raw = new Map<number, { bytes: Buffer; binary: boolean }>();
    for (const group of groups.values()) {
      const query = { bodyParts: [{ key: group.part, start: 0, maxLength: group.maxLength }] };
      for await (const msg of client.fetch(group.uids.join(","), query, { uid: true })) {
        const bytes = msg.bodyParts?.values().next().value;
        if (!bytes) continue;
        // A server that answered with FETCH BINARY has undone the transfer encoding.
        raw.set(msg.uid, { bytes, binary: (msg.binaryParts?.size ?? 0) > 0 });
      }
    }

    return fetched
      .map(({ msg, part }) => {
        const got = raw.get(msg.uid);
        const preview =
          part && got ? previewOf(asText(part, decodePart(part, got.bytes, { binary: got.binary, partial: true }))) : null;
        return summarize(msg, preview);
      })
      .sort((a, b) => b.uid - a.uid);
  }
}

/**
 * The decoded text of each of `parts` of message `uid`, by part id, in one
 * FETCH, each by its own transfer encoding and charset (src/mail-parts.ts
 * `decodePart`). Runs inside {@link ImapClient.withMailbox}. `get_message`'s
 * by-part read uses it for the bodies; the invitation reader can use it for a
 * `text/calendar` leaf the same way on either path.
 */
export async function fetchPartTexts(
  client: ImapFlow,
  uid: number,
  parts: Part[]
): Promise<Map<string, string>> {
  const texts = new Map<string, string>();
  if (parts.length === 0) return texts;
  const msg = await client.fetchOne(`${uid}`, { bodyParts: parts.map((p) => p.part) }, { uid: true });
  if (!msg) throw new Error(`Message UID ${uid} not found`);
  for (const part of parts) {
    const bytes = partBytes(msg, part.part);
    if (!bytes) continue;
    texts.set(part.part, decodePart(part, bytes, { binary: msg.binaryParts?.has(part.part) ?? false }));
  }
  return texts;
}

/** The newest `limit` of a SEARCH result, whatever order the server listed them in. */
function newestUids(found: number[] | false | undefined, limit: number): number[] {
  const uids = Array.isArray(found) ? [...found].sort((a, b) => a - b) : [];
  return uids.slice(-limit);
}

/** A body part's text as a reader sees it: HTML reduced to text the way mailparser does it. */
function asText(part: Part, text: string): string {
  return part.type === "text/html" ? htmlToText(text) : text;
}

/** The 200-character, whitespace-collapsed preview every tool reports. */
function previewOf(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, PREVIEW_CHARS);
}

function toAttachmentSummary(part: Part): AttachmentSummary {
  return {
    filename: part.filename,
    contentType: part.type,
    size: part.decodedSize,
    contentId: part.contentId,
    part: part.part,
  };
}

interface MessageContent {
  /** The headers (and, read whole, the attachments) as mailparser reads them, on both paths. */
  parsed: ParsedMail;
  bodyText: string | null;
  bodyHtml: string | null;
}

/** The whole message, parsed: what get_message has always done. */
async function readWhole(client: ImapFlow, uid: number, mailbox: string): Promise<MessageContent> {
  const msg = await client.fetchOne(`${uid}`, { source: true }, { uid: true });
  if (!msg || !msg.source) {
    throw new Error(`Message UID ${uid} not found in ${mailbox}`);
  }
  const parsed = await simpleParser(msg.source);
  return {
    parsed,
    bodyText: parsed.text ?? null,
    bodyHtml: typeof parsed.html === "string" ? parsed.html : null,
  };
}

/**
 * A large message by part: its header block, and its body parts, decoded by
 * what BODYSTRUCTURE says of them (transfer encoding, charset) and joined the
 * way mailparser joins them for a message read whole: text parts with "\n",
 * HTML parts with "<br/>\n", line ends as "\n", and the HTML reduced to text
 * by the same `html-to-text` when there is no plain text. Attachments are
 * never fetched; their sizes come from BODYSTRUCTURE.
 *
 * Not imapflow's `download`: it learns a part's encoding from a second fetch
 * of the part's MIME header, and GreenMail's answer to that left a
 * quoted-printable body undecoded. BODYSTRUCTURE is already in hand.
 */
async function readByPart(
  client: ImapFlow,
  uid: number,
  mailbox: string,
  structure: MessageStructureObject
): Promise<MessageContent> {
  const head = await client.fetchOne(`${uid}`, { headers: true }, { uid: true });
  if (!head) {
    throw new Error(`Message UID ${uid} not found in ${mailbox}`);
  }
  const parsed = await simpleParser(Buffer.concat([head.headers ?? Buffer.alloc(0), Buffer.from("\r\n")]));
  const ids = bodyParts(structure);
  const leaves = leafParts(structure);
  const wanted = [...ids.text, ...ids.html]
    .map((id) => leaves.find((p) => p.part === id))
    .filter((p): p is Part => p !== undefined);
  const texts = await fetchPartTexts(client, uid, wanted);
  const joined = (list: string[], separator: string): string | null => {
    const found = list
      .map((id) => texts.get(id))
      .filter((t): t is string => t !== undefined)
      .map((t) => t.replace(/\r?\n/g, "\n"));
    return found.length > 0 ? found.join(separator) : null;
  };
  const bodyHtml = joined(ids.html, "<br/>\n");
  const bodyText = joined(ids.text, "\n") ?? (bodyHtml !== null ? htmlToText(bodyHtml) : null);
  return { parsed, bodyText, bodyHtml };
}

/** A fetched body part by id; imapflow keys the map by the section as the server echoed it. */
function partBytes(msg: FetchMessageObject, part: string): Buffer | undefined {
  if (!msg.bodyParts) return undefined;
  const wanted = part.toLowerCase();
  for (const [key, value] of msg.bodyParts) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

function summarize(msg: FetchMessageObject, preview: string | null): MessageSummary {
  const env = msg.envelope;
  return {
    uid: msg.uid,
    seq: msg.seq,
    flags: Array.from(msg.flags ?? []),
    date: isoDate(env?.date),
    subject: env?.subject ?? null,
    from: addrText(env?.from),
    to: addrText(env?.to),
    cc: addrText(env?.cc),
    size: msg.size ?? null,
    preview,
  };
}
