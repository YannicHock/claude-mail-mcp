/**
 * Composing a message, offline (src/smtp-client.ts, v0.8 F1 and the iMIP
 * groundwork). What goes over SMTP is checked against GreenMail in
 * test/integration/mail-defects.test.ts; these hold the parts that need no
 * server: the Bcc header leaves the submitted bytes and nothing else does, a
 * fixed Message-ID and Date are the ones written, and `calendar` builds the
 * shape mail clients read as an invitation (spec M6).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { SmtpClient, withoutBcc } from "../../src/smtp-client.js";

const smtp = new SmtpClient(
  { host: "smtp.example.invalid", port: 465, user: "u", pass: "p", secure: true },
  { from: "alice@example.invalid" }
);

test("withoutBcc removes the Bcc header, folded lines included, and nothing else", () => {
  const raw = Buffer.from(
    [
      "From: alice@example.invalid",
      "To: carol@example.invalid",
      "Bcc: bob@example.invalid,",
      " dave@example.invalid",
      "Subject: hi",
      "",
      "Bcc: this line is body text.",
      "",
    ].join("\r\n"),
    "latin1"
  );
  assert.equal(
    withoutBcc(raw).toString("latin1"),
    [
      "From: alice@example.invalid",
      "To: carol@example.invalid",
      "Subject: hi",
      "",
      "Bcc: this line is body text.",
      "",
    ].join("\r\n")
  );
});

test("withoutBcc returns a message without Bcc unchanged, and handles Bcc as the first header", () => {
  const plain = Buffer.from("To: a@x\r\nSubject: s\r\n\r\nbody", "latin1");
  assert.equal(withoutBcc(plain), plain);
  const first = Buffer.from("Bcc: b@x\r\nTo: a@x\r\n\r\nbody", "latin1");
  assert.equal(withoutBcc(first).toString("latin1"), "To: a@x\r\n\r\nbody");
});

test("buildRawSource writes a fixed Message-ID and Date, and the Bcc header only when asked to keep it", async () => {
  const date = new Date("2026-10-18T10:00:00.000Z");
  const raw = (
    await smtp.buildRawSource({
      to: "carol@example.invalid",
      bcc: "bob@example.invalid",
      subject: "fixed",
      text: "t",
      messageId: "<fixed-id@example.invalid>",
      date,
    })
  ).toString("utf8");
  assert.match(raw, /^Message-ID: <fixed-id@example\.invalid>\r$/m);
  assert.match(raw, /^Date: Sun, 18 Oct 2026 10:00:00 \+0000\r$/m);
  // A draft is not a sent copy: nodemailer leaves Bcc out unless told otherwise.
  assert.doesNotMatch(raw, /^Bcc:/im);
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
