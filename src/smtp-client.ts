/**
 * SMTP client wrapper around nodemailer.
 *
 * Sends RFC-5322 messages and, for create_draft, returns the raw message
 * source so the IMAP client can APPEND it to the Drafts folder.
 *
 * v0.8 (F1, #239): `sendAndCompose()` composes a message once and sends those
 * bytes, so the copy kept in Sent is the message that went out: the same
 * Message-ID, the same Date, the same MIME boundaries, plus the Bcc header that
 * only the sender's copy may carry.
 */

import nodemailer, { Transporter, SendMailOptions } from "nodemailer";
import type MimeNode from "nodemailer/lib/mime-node/index.js";

import {
  smtpTlsOptions,
  localMailAddress,
  startTlsError,
  type LocalAddressCheck,
  type MailTlsTestOptions,
} from "./mail-tls.js";

export interface SmtpAuth {
  host: string;
  port: number;
  user: string;
  pass: string;
  secure: boolean;
}

export interface SmtpDefaults {
  from: string;
  fromName?: string;
}

export interface OutgoingMessage {
  to: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  subject: string;
  text?: string;
  html?: string;
  replyTo?: string;
  inReplyTo?: string;
  references?: string[];
  attachments?: Array<{
    filename: string;
    contentBase64: string;
    contentType?: string;
  }>;
  /**
   * A fixed Message-ID (with its angle brackets). Omitted, nodemailer makes one
   * up, and two compositions of one message get two different ones (F1).
   */
  messageId?: string;
  /** A fixed Date header. Omitted, the time of composition. */
  date?: Date;
  /**
   * An iTIP object (RFC 5546) to carry as nodemailer's `icalEvent`: a
   * `text/calendar; method=…` alternative plus an `invite.ics` attachment, the
   * shape mail clients recognise as an invitation (spec M6). `method` is the
   * iTIP method (`REQUEST`, `REPLY`, `CANCEL`); `content` the VCALENDAR text,
   * which must carry the same `METHOD`.
   */
  calendar?: { method: string; content: string };
}

export interface SendResult {
  messageId: string;
  accepted: string[];
  rejected: string[];
  /**
   * The server's final SMTP reply, when there was one.
   *
   * Optional because nodemailer types it that way from version 10 on, and its own
   * types replaced the `@types/nodemailer` package that used to claim it was always
   * present. Not every transport produces a reply line, so the honest mapping is to
   * pass the absence through rather than substitute an empty string — the field is
   * surfaced to the model, and an empty reply reads as a reply that was empty.
   */
  response?: string;
}

export class SmtpClient {
  private readonly auth: SmtpAuth;
  private readonly defaults: SmtpDefaults;
  private readonly localAddress: LocalAddressCheck;

  constructor(auth: SmtpAuth, defaults: SmtpDefaults, options: MailTlsTestOptions = {}) {
    this.auth = auth;
    this.defaults = defaults;
    this.localAddress = options.localAddress ?? localMailAddress;
  }

  /**
   * A transport per send: the plain (non-pooled) transport opens a connection
   * per message anyway. Host and TLS by src/mail-tls.ts (#220).
   */
  private async transporter(): Promise<Transporter> {
    const tls = await smtpTlsOptions(this.auth.host, this.auth.secure, this.localAddress);
    return nodemailer.createTransport({
      port: this.auth.port,
      ...tls,
      auth: { user: this.auth.user, pass: this.auth.pass },
    });
  }

  /**
   * Compose `msg` once, send it, and return the bytes to keep as the Sent copy.
   *
   * The message is built a single time with its Bcc header kept. What goes over
   * SMTP is those bytes with the Bcc header taken out, to the envelope the
   * composition derived (To, Cc and Bcc), so no recipient sees who was blind
   * copied. What comes back as `raw` is the composition as built: byte for byte
   * the submitted message plus that one header (F1, #239). `result.messageId`
   * is the Message-ID in both.
   */
  async sendAndCompose(msg: OutgoingMessage): Promise<{ result: SendResult; raw: Buffer }> {
    const node = await this.compile(msg);
    node.keepBcc = true;
    const { from, to } = node.getEnvelope();
    const envelope = { from: from || this.defaults.from, to };
    const messageId = node.messageId();
    const raw = await buildNode(node);
    const transporter = await this.transporter();
    try {
      const info = await transporter.sendMail({ envelope, raw: withoutBcc(raw) });
      return {
        result: {
          // nodemailer reports a Message-ID of its own for a raw message; the
          // one that went out is the composition's.
          messageId,
          accepted: (info.accepted ?? []).map(String),
          rejected: (info.rejected ?? []).map(String),
          response: info.response,
        },
        raw,
      };
    } catch (err) {
      throw startTlsError(err);
    } finally {
      transporter.close();
    }
  }

  async send(msg: OutgoingMessage): Promise<SendResult> {
    const mail = this.toMailOptions(msg);
    const transporter = await this.transporter();
    try {
      const info = await transporter.sendMail(mail);
      return {
        messageId: info.messageId,
        accepted: (info.accepted ?? []).map(String),
        rejected: (info.rejected ?? []).map(String),
        response: info.response,
      };
    } catch (err) {
      throw startTlsError(err);
    } finally {
      transporter.close();
    }
  }

  /**
   * Build raw RFC 822 source via nodemailer's own composer, without using
   * the SMTP transport. Used by create_draft (APPEND to Drafts folder) and
   * by the "save copy to Sent folder" step after send().
   */
  async buildRawSource(msg: OutgoingMessage): Promise<Buffer> {
    return await buildNode(await this.compile(msg));
  }

  /** The message as nodemailer's composer lays it out, not yet serialised. */
  private async compile(msg: OutgoingMessage): Promise<MimeNode> {
    // Lazy import to keep startup light.
    const { default: MailComposer } = await import(
      "nodemailer/lib/mail-composer/index.js"
    );
    return new MailComposer(this.toMailOptions(msg)).compile();
  }

  private toMailOptions(msg: OutgoingMessage): SendMailOptions {
    const from = this.defaults.fromName
      ? `"${this.defaults.fromName.replace(/"/g, '\\"')}" <${this.defaults.from}>`
      : this.defaults.from;
    const opts: SendMailOptions = {
      from,
      to: msg.to,
      subject: msg.subject,
    };
    if (msg.cc) opts.cc = msg.cc;
    if (msg.bcc) opts.bcc = msg.bcc;
    if (msg.text) opts.text = msg.text;
    if (msg.html) opts.html = msg.html;
    if (msg.replyTo) opts.replyTo = msg.replyTo;
    if (msg.inReplyTo) opts.inReplyTo = msg.inReplyTo;
    if (msg.references) opts.references = msg.references;
    if (msg.messageId) opts.messageId = msg.messageId;
    if (msg.date) opts.date = msg.date;
    if (msg.calendar) {
      opts.icalEvent = { method: msg.calendar.method, content: msg.calendar.content };
    }
    if (msg.attachments && msg.attachments.length > 0) {
      opts.attachments = msg.attachments.map((a) => ({
        filename: a.filename,
        content: Buffer.from(a.contentBase64, "base64"),
        contentType: a.contentType,
      }));
    }
    return opts;
  }
}

function buildNode(node: MimeNode): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    node.build((err, message) => {
      if (err) reject(err);
      else resolve(message);
    });
  });
}

/**
 * `raw` with its Bcc header removed, folded continuation lines included, and
 * every other byte untouched. Only the header block is looked at: a "Bcc:" in
 * the body is text.
 */
export function withoutBcc(raw: Buffer): Buffer {
  const text = raw.toString("latin1");
  const blank = text.indexOf("\r\n\r\n");
  const headerEnd = blank === -1 ? text.length : blank + 2;
  const lines = text.slice(0, headerEnd).split(/(?<=\r\n)/);
  const kept: string[] = [];
  let inBcc = false;
  for (const line of lines) {
    const continuation = line.startsWith(" ") || line.startsWith("\t");
    if (!continuation) inBcc = /^bcc:/i.test(line);
    if (!inBcc) kept.push(line);
  }
  if (kept.length === lines.length) return raw;
  return Buffer.concat([Buffer.from(kept.join(""), "latin1"), raw.subarray(headerEnd)]);
}
