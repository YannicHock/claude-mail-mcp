/**
 * The BODYSTRUCTURE walk (src/mail-parts.ts), over hand-written structures in
 * imapflow's shape. M3 and M6 are the two layouts the v0.8 spec measured
 * (§0.1): a message with two attachments, and an invitation as nodemailer's
 * `icalEvent` builds it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { MessageStructureObject } from "imapflow";

import {
  attachmentParts,
  bodyParts,
  decodeText,
  decodedSize,
  htmlToText,
  leafParts,
} from "../../src/mail-parts.js";

/**
 * M3: body, notes.txt, blob.bin (300,000 bytes, base64 in 76-character lines).
 * 410,526 is what nodemailer writes for the part's body. (GreenMail reports
 * 410,670: it counts the part's 144 bytes of MIME header in, see the
 * integration test.)
 */
const M3: MessageStructureObject = {
  type: "multipart/mixed",
  parameters: { boundary: "--_NmP-1" },
  childNodes: [
    { part: "1", type: "text/plain", parameters: { charset: "utf-8" }, encoding: "7bit", size: 16, lineCount: 1 },
    {
      part: "2",
      type: "text/plain",
      parameters: { charset: "utf-8", name: "notes.txt" },
      encoding: "7bit",
      size: 12,
      lineCount: 1,
      disposition: "attachment",
      dispositionParameters: { filename: "notes.txt" },
    },
    {
      part: "3",
      type: "application/octet-stream",
      parameters: { name: "blob.bin" },
      encoding: "base64",
      size: 410_526,
      disposition: "attachment",
      dispositionParameters: { filename: "blob.bin" },
    },
  ],
};

/** M6: multipart/mixed → alternative (1.1 text/plain, 1.2 text/calendar) + 2 invite.ics. */
const M6: MessageStructureObject = {
  type: "multipart/mixed",
  childNodes: [
    {
      part: "1",
      type: "multipart/alternative",
      childNodes: [
        { part: "1.1", type: "text/plain", parameters: { charset: "utf-8" }, encoding: "7bit", size: 40, lineCount: 2 },
        {
          part: "1.2",
          type: "text/calendar",
          parameters: { charset: "utf-8", method: "REQUEST" },
          encoding: "7bit",
          size: 600,
          lineCount: 20,
        },
      ],
    },
    {
      part: "2",
      type: "application/ics",
      parameters: { name: "invite.ics" },
      encoding: "base64",
      size: 820,
      disposition: "attachment",
      dispositionParameters: { filename: "invite.ics" },
    },
  ],
};

test("leafParts: M3's part ids, types, filenames and sizes", () => {
  const leaves = leafParts(M3);
  assert.deepEqual(
    leaves.map((p) => [p.part, p.type, p.filename, p.disposition]),
    [
      ["1", "text/plain", null, null],
      ["2", "text/plain", "notes.txt", "attachment"],
      ["3", "application/octet-stream", "blob.bin", "attachment"],
    ]
  );
  const blob = leaves[2]!;
  assert.equal(blob.encoding, "base64");
  assert.equal(blob.encodedSize, 410_526);
  assert.equal(blob.decodedSize, 300_000);
  assert.equal(leaves[0]!.params.charset, "utf-8");
});

test("bodyParts and attachmentParts: M3's body is part 1, the other two are attachments", () => {
  assert.deepEqual(bodyParts(M3), { text: "1" });
  assert.deepEqual(
    attachmentParts(M3).map((p) => p.part),
    ["2", "3"]
  );
});

test("M6: the body is 1.1, the text/calendar alternative 1.2 is listed as an attachment, beside invite.ics", () => {
  assert.deepEqual(
    leafParts(M6).map((p) => p.part),
    ["1.1", "1.2", "2"]
  );
  assert.deepEqual(bodyParts(M6), { text: "1.1" });
  const attachments = attachmentParts(M6);
  assert.deepEqual(
    attachments.map((p) => [p.part, p.type, p.filename]),
    [
      ["1.2", "text/calendar", null],
      ["2", "application/ics", "invite.ics"],
    ]
  );
  assert.equal(attachments[0]!.params.method, "REQUEST");
});

test("a single-part message is part 1, and its body", () => {
  const plain: MessageStructureObject = { type: "text/plain", parameters: { charset: "us-ascii" }, encoding: "7bit", size: 5 };
  assert.deepEqual(
    leafParts(plain).map((p) => p.part),
    ["1"]
  );
  assert.deepEqual(bodyParts(plain), { text: "1" });
  assert.deepEqual(attachmentParts(plain), []);
});

test("alternative with text and HTML inside related: both bodies, the inline image an attachment", () => {
  const structure: MessageStructureObject = {
    type: "multipart/alternative",
    childNodes: [
      { part: "1", type: "text/plain", encoding: "quoted-printable", size: 100 },
      {
        part: "2",
        type: "multipart/related",
        childNodes: [
          { part: "2.1", type: "text/html", encoding: "quoted-printable", size: 300 },
          { part: "2.2", type: "image/png", encoding: "base64", size: 78, id: "<logo@x>", disposition: "inline" },
        ],
      },
    ],
  };
  assert.deepEqual(bodyParts(structure), { text: "1", html: "2.1" });
  const attachments = attachmentParts(structure);
  assert.deepEqual(
    attachments.map((p) => [p.part, p.contentId]),
    [["2.2", "logo@x"]]
  );
});

test("a text part that is an attachment is not a body; an attached message is one leaf", () => {
  const structure: MessageStructureObject = {
    type: "multipart/mixed",
    childNodes: [
      { part: "1", type: "text/plain", encoding: "7bit", size: 10, disposition: "attachment", dispositionParameters: { filename: "a.txt" } },
      {
        part: "2",
        type: "message/rfc822",
        size: 500,
        childNodes: [{ part: "2", type: "text/plain", size: 100 }],
      },
    ],
  };
  assert.deepEqual(bodyParts(structure), {});
  assert.deepEqual(
    attachmentParts(structure).map((p) => [p.part, p.type]),
    [
      ["1", "text/plain"],
      ["2", "message/rfc822"],
    ]
  );
});

test("decodedSize: base64 without its line breaks × 3/4, rounded down; anything else as is", () => {
  // 300,000 bytes → 400,000 characters in 5,264 lines of up to 76, with a CRLF between them.
  assert.equal(decodedSize(410_526, "base64"), 300_000);
  // Unwrapped base64 (no line breaks at all) stays within the estimate's margin.
  assert.ok(Math.abs(decodedSize(400_000, "base64") - 300_000) / 300_000 < 0.03);
  // One full line and one short one: 76 + CRLF + 4 characters, 60 bytes.
  assert.equal(decodedSize(82, "base64"), 60);
  assert.equal(decodedSize(4, "base64"), 3); // "AAAA"
  assert.equal(decodedSize(1234, "quoted-printable"), 1234);
  assert.equal(decodedSize(1234, "7bit"), 1234);
  assert.equal(decodedSize(0, "base64"), 0);
});

test("decodeText: quoted-printable, base64 and a charset, also cut off mid-sequence", () => {
  assert.equal(decodeText(Buffer.from("Gr=C3=BC=C3=9Fe aus K=C3=B6ln"), "quoted-printable", "utf-8"), "Grüße aus Köln");
  assert.equal(decodeText(Buffer.from("soft=\r\nbreak"), "quoted-printable", "utf-8"), "softbreak");
  assert.equal(decodeText(Buffer.from("Gr=FC=DFe"), "quoted-printable", "iso-8859-1"), "Grüße");
  assert.equal(
    decodeText(Buffer.from(Buffer.from("Grüße aus Köln").toString("base64")), "base64", "utf-8"),
    "Grüße aus Köln"
  );
  // A partial fetch cuts wherever it cuts: no dangling escape, no replacement character.
  assert.equal(decodeText(Buffer.from("Gr=C3=BC=C3"), "quoted-printable", "utf-8"), "Grü");
  assert.equal(decodeText(Buffer.from("Gr=C3=BC=C"), "quoted-printable", "utf-8"), "Grü");
  assert.equal(decodeText(Buffer.from("R3LDvMOfZSBhdX"), "base64", "utf-8"), "Grüße a");
  // An unknown charset falls back to UTF-8 rather than failing the list.
  assert.equal(decodeText(Buffer.from("plain"), "7bit", "x-unknown-charset"), "plain");
});

test("htmlToText: tags, style and script dropped, entities decoded, whitespace collapsed", () => {
  assert.equal(
    htmlToText(
      "<html><head><style>p{color:red}</style><script>x()</script></head><body><p>Hallo &amp; Gr&uuml;&szlig;e</p><p>aus&nbsp;K&#246;ln &#x2013; ok</p></body></html>"
    ),
    "Hallo & Grüße aus Köln – ok"
  );
  // Cut off inside a style block or a tag: nothing of it leaks.
  assert.equal(htmlToText("<p>before</p><style>p { color"), "before");
  assert.equal(htmlToText("<p>before</p><a href=\"x"), "before");
});
