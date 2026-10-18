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
  isStartTlsUnavailable,
  STARTTLS_REQUIRED_MESSAGE,
  type LocalAddressCheck,
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

export interface SmtpClientOptions {
  /** Where a local host is reached in plaintext, or null (#220). Tests only. */
  localAddress?: LocalAddressCheck;
}

export class SmtpClient {
  private readonly auth: SmtpAuth;
  private readonly defaults: SmtpDefaults;
  private readonly localAddress: LocalAddressCheck;

  constructor(auth: SmtpAuth, defaults: SmtpDefaults, options: SmtpClientOptions = {}) {
    this.auth = auth;
    this.defaults = defaults;
    this.localAddress = options.localAddress ?? localMailAddress;
  }

  /**
   * A transport per send. The plain (non-pooled) transport opens a connection
   * per message anyway, so nothing is lost, and what `secure: false` means is
   * decided at the moment the password would be sent: STARTTLS or nothing on
   * a host that is not local (#220, src/mail-tls.ts). `tls` carries the host
   * too: a local name is connected to at the address it was checked at.
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
      // nodemailer's own "Error upgrading connection with STARTTLS" says what, not why.
      throw isStartTlsUnavailable(err) ? new Error(STARTTLS_REQUIRED_MESSAGE) : err;
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
