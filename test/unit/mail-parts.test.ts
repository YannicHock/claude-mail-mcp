/**
 * The BODYSTRUCTURE walk (src/mail-parts.ts), over hand-written structures in
 * imapflow's shape. M3 and M6 are the two layouts the v0.8 spec measured
 * (§0.1): a message with two attachments, and an invitation as nodemailer's
 * `icalEvent` builds it. The others are the layouts where "the body is the
 * first part" is wrong: Apple Mail's text, photo, text, and its HTML version.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { MessageStructureObject } from "imapflow";

import {
  attachmentParts,
  bodyLeaves,
  bodyParts,
  decodePart,
  decodeText,
  decodedSize,
  leafParts,
  previewPart,
  type Part,
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

/** Apple Mail's "text, photo, text": the second text is body too. */
const TEXT_PHOTO_TEXT: MessageStructureObject = {
  type: "multipart/mixed",
  childNodes: [
    { part: "1", type: "text/plain", parameters: { charset: "us-ascii" }, encoding: "7bit", size: 20 },
    {
      part: "2",
      type: "image/jpeg",
      parameters: { name: "photo.jpg" },
      encoding: "base64",
      size: 7800,
      disposition: "inline",
      dispositionParameters: { filename: "photo.jpg" },
    },
    { part: "3", type: "text/plain", parameters: { charset: "us-ascii" }, encoding: "7bit", size: 20 },
  ],
};

/** Apple Mail's HTML version: alternative [text/plain, mixed [html, image, html]]. */
const APPLE_HTML: MessageStructureObject = {
  type: "multipart/alternative",
  childNodes: [
    { part: "1", type: "text/plain", parameters: { charset: "utf-8" }, encoding: "quoted-printable", size: 60 },
    {
      part: "2",
      type: "multipart/mixed",
      childNodes: [
        { part: "2.1", type: "text/html", parameters: { charset: "utf-8" }, encoding: "quoted-printable", size: 200 },
        {
          part: "2.2",
          type: "image/png",
          parameters: { name: "photo.png" },
          encoding: "base64",
          size: 780,
          disposition: "inline",
          dispositionParameters: { filename: "photo.png" },
        },
        { part: "2.3", type: "text/html", parameters: { charset: "utf-8" }, encoding: "quoted-printable", size: 120 },
      ],
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
  assert.ok(blob.decodedSize >= 300_000, "the decoded size must not undershoot");
  assert.equal(leaves[0]!.params.charset, "utf-8");
});

test("bodyParts and attachmentParts: M3's body is part 1, the other two are attachments", () => {
  assert.deepEqual(bodyParts(M3), { text: ["1"], html: [] });
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
  assert.deepEqual(bodyParts(M6), { text: ["1.1"], html: [] });
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

test("text, photo, text: both texts are body, in order, and only the photo is an attachment", () => {
  assert.deepEqual(bodyParts(TEXT_PHOTO_TEXT), { text: ["1", "3"], html: [] });
  assert.deepEqual(
    attachmentParts(TEXT_PHOTO_TEXT).map((p) => p.part),
    ["2"]
  );
  assert.equal(previewPart(TEXT_PHOTO_TEXT)?.part, "1");
});

test("Apple HTML: the plain alternative and both HTML parts are body, the image is an attachment", () => {
  assert.deepEqual(bodyParts(APPLE_HTML), { text: ["1"], html: ["2.1", "2.3"] });
  assert.deepEqual(
    attachmentParts(APPLE_HTML).map((p) => p.part),
    ["2.2"]
  );
});

test("inside mixed, a text/calendar, an attachment-disposition text and a named text are not body", () => {
  const structure: MessageStructureObject = {
    type: "multipart/mixed",
    childNodes: [
      {
        part: "1",
        type: "text/plain",
        encoding: "7bit",
        size: 10,
        disposition: "inline",
        dispositionParameters: { filename: "readme.txt" },
      },
      { part: "2", type: "text/plain", encoding: "7bit", size: 10 },
      { part: "3", type: "text/calendar", parameters: { method: "REQUEST" }, encoding: "7bit", size: 300 },
      { part: "4", type: "text/plain", encoding: "7bit", size: 10, disposition: "attachment" },
      { part: "5", type: "text/html", parameters: { name: "page.html" }, encoding: "7bit", size: 10 },
    ],
  };
  assert.deepEqual(bodyParts(structure), { text: ["2"], html: [] });
  assert.deepEqual(
    attachmentParts(structure).map((p) => p.part),
    ["1", "3", "4", "5"]
  );
});

test("a single-part message is part 1, and its body", () => {
  const plain: MessageStructureObject = { type: "text/plain", parameters: { charset: "us-ascii" }, encoding: "7bit", size: 5 };
  assert.deepEqual(
    leafParts(plain).map((p) => p.part),
    ["1"]
  );
  assert.deepEqual(bodyParts(plain), { text: ["1"], html: [] });
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
  assert.deepEqual(bodyParts(structure), { text: ["1"], html: ["2.1"] });
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
  assert.deepEqual(bodyParts(structure), { text: [], html: [] });
  assert.deepEqual(
    attachmentParts(structure).map((p) => [p.part, p.type]),
    [
      ["1", "text/plain"],
      ["2", "message/rfc822"],
    ]
  );
});

test("decodedSize: an upper bound for base64 (× 3/4, rounded up); anything else as is", () => {
  assert.equal(decodedSize(410_526, "base64"), 307_895);
  assert.equal(decodedSize(4, "base64"), 3);
  assert.equal(decodedSize(1234, "quoted-printable"), 1234);
  assert.equal(decodedSize(1234, "7bit"), 1234);
  assert.equal(decodedSize(0, "base64"), 0);
  // Never below the real size, wrapped or not, whatever the padding.
  for (const n of [1, 2, 3, 56, 57, 58, 1000, 300_000]) {
    const unwrapped = Buffer.alloc(n, 9).toString("base64");
    const wrapped = unwrapped.replace(/.{76}/g, "$&\r\n").replace(/\r\n$/, "");
    assert.ok(decodedSize(unwrapped.length, "base64") >= n, `unwrapped ${n}`);
    assert.ok(decodedSize(wrapped.length, "base64") >= n, `wrapped ${n}`);
  }
});

test("decodeText: quoted-printable, base64 and a charset; a cut-off fetch drops its dangling tail", () => {
  assert.equal(decodeText(Buffer.from("Gr=C3=BC=C3=9Fe aus K=C3=B6ln"), "quoted-printable", "utf-8"), "Grüße aus Köln");
  assert.equal(decodeText(Buffer.from("soft=\r\nbreak"), "quoted-printable", "utf-8"), "softbreak");
  assert.equal(decodeText(Buffer.from("Gr=FC=DFe"), "quoted-printable", "iso-8859-1"), "Grüße");
  assert.equal(
    decodeText(Buffer.from(Buffer.from("Grüße aus Köln").toString("base64")), "base64", "utf-8"),
    "Grüße aus Köln"
  );
  // A partial fetch cuts wherever it cuts: no dangling escape, no replacement character.
  assert.equal(decodeText(Buffer.from("Gr=C3=BC=C3"), "quoted-printable", "utf-8", { partial: true }), "Grü");
  assert.equal(decodeText(Buffer.from("Gr=C3=BC=C"), "quoted-printable", "utf-8", { partial: true }), "Grü");
  assert.equal(decodeText(Buffer.from("R3LDvMOfZSBhdX"), "base64", "utf-8", { partial: true }), "Grüße a");
  // A complete part keeps what it has: a broken last byte is shown, not hidden.
  assert.equal(decodeText(Buffer.from("Gr=C3=BC=C3"), "quoted-printable", "utf-8"), "Grü�");
  // An unknown charset falls back to UTF-8 rather than failing the list.
  assert.equal(decodeText(Buffer.from("plain"), "7bit", "x-unknown-charset"), "plain");
});

test("decodePart: by the part's own encoding and charset, or as is when the server sent it BINARY", () => {
  const part: Part = leafParts({
    type: "text/plain",
    parameters: { charset: "iso-8859-1" },
    encoding: "quoted-printable",
    size: 9,
  })[0]!;
  assert.equal(decodePart(part, Buffer.from("Gr=FC=DFe")), "Grüße");
  assert.equal(decodePart(part, Buffer.from([0x47, 0x72, 0xfc, 0xdf, 0x65]), { binary: true }), "Grüße");
  assert.equal(decodePart(part, Buffer.from("Gr=FC=D"), { partial: true }), "Grü");
});

/** A Mailman footer on an HTML-only post: mixed [text/html, text/plain]. */
const HTML_FOOTER: MessageStructureObject = {
  type: "multipart/mixed",
  childNodes: [
    { part: "1", type: "text/html", parameters: { charset: "utf-8" }, encoding: "7bit", size: 200 },
    { part: "2", type: "text/plain", parameters: { charset: "us-ascii" }, encoding: "7bit", size: 80 },
  ],
};

test("mixed [html, text footer]: body leaves in document order, and the preview is the post, not the footer", () => {
  assert.deepEqual(
    bodyLeaves(HTML_FOOTER).map((p) => [p.part, p.type, p.alternative]),
    [
      ["1", "text/html", null],
      ["2", "text/plain", null],
    ]
  );
  assert.equal(previewPart(HTML_FOOTER)?.part, "1");
});

test("mixed [text, html, text]: the preview is the first leaf", () => {
  const structure: MessageStructureObject = {
    type: "multipart/mixed",
    childNodes: [
      { part: "1", type: "text/plain", encoding: "7bit", size: 10 },
      { part: "2", type: "text/html", encoding: "7bit", size: 10 },
      { part: "3", type: "text/plain", encoding: "7bit", size: 10 },
    ],
  };
  assert.deepEqual(
    bodyLeaves(structure).map((p) => p.part),
    ["1", "2", "3"]
  );
  assert.equal(previewPart(structure)?.part, "1");
});

test("inside an alternative the preview still prefers the plain text, whatever its position", () => {
  const structure: MessageStructureObject = {
    type: "multipart/alternative",
    childNodes: [
      { part: "1", type: "text/html", encoding: "7bit", size: 10 },
      { part: "2", type: "text/plain", encoding: "7bit", size: 10 },
    ],
  };
  assert.deepEqual(
    bodyLeaves(structure).map((p) => [p.part, p.alternative]),
    [
      ["1", ""],
      ["2", ""],
    ]
  );
  assert.equal(previewPart(structure)?.part, "2");
  // Apple HTML: the leaves under the inner mixed still belong to the outer alternative.
  assert.deepEqual(
    bodyLeaves(APPLE_HTML).map((p) => [p.part, p.alternative]),
    [
      ["1", ""],
      ["2.1", ""],
      ["2.3", ""],
    ]
  );
});
