/**
 * SMTP client wrapper around nodemailer.
 *
 * Sends RFC-5322 messages and, for create_draft, returns the raw message
 * source so the IMAP client can APPEND it to the Drafts folder.
 */

import nodemailer, { Transporter, SendMailOptions } from "nodemailer";

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
    const mail = this.toMailOptions(msg);
    // Lazy import to keep startup light.
    const { default: MailComposer } = await import(
      "nodemailer/lib/mail-composer/index.js"
    );
    const composer = new MailComposer(mail);
    return await new Promise<Buffer>((resolve, reject) => {
      composer.compile().build((err, message) => {
        if (err) reject(err);
        else resolve(message);
      });
    });
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
