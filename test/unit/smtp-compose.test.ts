/**
 * Composing a message, offline (src/smtp-client.ts, v0.8 F1 and the iMIP
 * groundwork). What goes over SMTP is checked against GreenMail in
 * test/integration/mail-defects.test.ts; these hold the parts that need no
 * server: the submitted bytes and the Sent copy are one composition apart from
 * the Bcc header, the envelope still reaches the Bcc recipients, a draft has
 * no Bcc, and `calendar` builds the shape mail clients read as an invitation
 * (spec M6).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { SmtpClient } from "../../src/smtp-client.js";

const smtp = new SmtpClient(
  { host: "smtp.example.invalid", port: 465, user: "u", pass: "p", secure: true },
  { from: "alice@example.invalid" }
);

function headerBlock(raw: Buffer): string {
  const text = raw.toString("latin1");
  return text.slice(0, text.indexOf("\r\n\r\n"));
}

test("composeForSending: the copy is the submitted message plus its Bcc header, nothing else", async () => {
  const { submitted, copy, envelope, messageId } = await smtp.composeForSending({
    to: "carol@example.invalid",
    cc: "dave@example.invalid",
    bcc: ["bob@example.invalid", "eve@example.invalid"],
    subject: "one composition",
    text: "Body text.",
    html: "<p>Body text.</p>",
    attachments: [{ filename: "a.bin", contentBase64: Buffer.alloc(5000, 1).toString("base64") }],
  });

  assert.doesNotMatch(headerBlock(submitted), /^bcc\s*:/im, "the submitted message carries a Bcc header");
  assert.match(headerBlock(copy), /^Bcc: bob@example\.invalid, eve@example\.invalid\r?$/m);
  // Take the one Bcc header out of the copy: what is left is the submitted bytes exactly.
  const copyText = copy.toString("latin1");
  assert.equal(copyText.replace(/^Bcc: [^\r\n]*\r\n/m, ""), submitted.toString("latin1"));

  assert.deepEqual(envelope, {
    from: "alice@example.invalid",
    to: ["carol@example.invalid", "dave@example.invalid", "bob@example.invalid", "eve@example.invalid"],
  });
  assert.match(headerBlock(submitted), new RegExp(`^Message-ID: ${messageId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\r?$`, "m"));
});

test("buildRawSource: a draft carries no Bcc header", async () => {
  const raw = await smtp.buildRawSource({
    to: "carol@example.invalid",
    bcc: "bob@example.invalid",
    subject: "draft",
    text: "t",
  });
  assert.doesNotMatch(headerBlock(raw), /^bcc\s*:/im);
});

test("calendar becomes nodemailer's icalEvent: a text/calendar alternative with the method, and invite.ics", async () => {
  const ics = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//test//EN",
    "METHOD:REQUEST",
    "BEGIN:VEVENT",
    "UID:imip-1@example.invalid",
    "DTSTAMP:20261018T100000Z",
    "DTSTART:20261020T100000Z",
    "SUMMARY:Meeting",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
  const raw = (
    await smtp.buildRawSource({
      to: "bob@example.invalid",
      subject: "Invitation",
      text: "You are invited.",
      calendar: { method: "REQUEST", content: ics },
    })
  ).toString("utf8");
  assert.match(raw, /Content-Type: multipart\/mixed/);
  assert.match(raw, /Content-Type: multipart\/alternative/);
  assert.match(raw, /Content-Type: text\/calendar; charset=utf-8; method=REQUEST/);
  assert.match(raw, /Content-Type: application\/ics; name=invite\.ics/);
});
