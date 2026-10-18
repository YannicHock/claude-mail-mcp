/**
 * The BODYSTRUCTURE walk, pure (v0.8, spec §2.4 and §3.1).
 *
 * `get_message`, the list previews and, from v0.8's attachment and invitation
 * work on, `get_attachment` and the iMIP reader all need the same three
 * answers about a message they have not downloaded: which leaf parts it has
 * and under which IMAP part id, which of them a reader shows as the message's
 * text, and how large each one is once decoded. Those answers live here, over
 * imapflow's `MessageStructureObject`, so no network class carries them.
 *
 * Also here, because the previews need them and they are just as pure: decoding
 * a (possibly cut-off) transfer-encoded text part into a string, and reducing
 * HTML to text.
 */

import type { MessageStructureObject } from "imapflow";

/** One leaf of a message's MIME tree. */
export interface Part {
  /** IMAP part id ("1", "1.2"); a single-part message's only part is "1". */
  part: string;
  /** Lower-case `type/subtype`. */
  type: string;
  /** Content-Type parameters (`charset`, `name`, `method`, …), keys lower-case. */
  params: Record<string, string>;
  /** `attachment`, `inline`, or null when the part declares none. */
  disposition: string | null;
  /** From the disposition's `filename`, else the type's `name`. */
  filename: string | null;
  /** Content-ID without its angle brackets. */
  contentId: string | null;
  /** Lower-case Content-Transfer-Encoding; `7bit` when the part declares none. */
  encoding: string;
  /** Size on the wire, as BODYSTRUCTURE reports it (M3: the encoded size). */
  encodedSize: number;
  /** Estimated size once the transfer encoding is undone; see {@link decodedSize}. */
  decodedSize: number;
}

/** The part ids a reader shows as the message's text and its HTML. */
export interface BodyPartIds {
  text?: string;
  html?: string;
}

/** RFC 2045 §6.8: encoded lines are at most 76 characters, plus CRLF. */
const BASE64_LINE = 76 + 2;

/**
 * Estimated decoded size of a part whose BODYSTRUCTURE size is `encodedSize`.
 *
 * Base64: the line breaks taken off, then × 3/4, rounded down. Lines of the
 * RFC 2045 maximum, 76 characters, are assumed, which is what composers write:
 * nodemailer encodes 300,000 bytes as 400,000 characters in 5,264 lines, 5,263
 * CRLFs between them (the one before the boundary belongs to the boundary),
 * 410,526 bytes in all. Base64 written without line breaks comes out up to
 * 2.5 % low, and padding is not visible from the structure, so the result can
 * be two bytes high. Every other encoding is reported as it is:
 * quoted-printable only ever shrinks when decoded, so its encoded size is an
 * upper bound, which is what a size check needs.
 *
 * GreenMail counts a part's own MIME header into its size (410,670 for the
 * part above), so against it the estimate is about a hundred bytes high.
 */
export function decodedSize(encodedSize: number, encoding: string): number {
  if (encodedSize <= 0) return 0;
  if (encoding.toLowerCase() !== "base64") return encodedSize;
  const breaks = Math.floor(encodedSize / BASE64_LINE);
  return Math.floor(((encodedSize - 2 * breaks) * 3) / 4);
}

function isMultipart(node: MessageStructureObject): boolean {
  return node.type.toLowerCase().startsWith("multipart/");
}

function toPart(node: MessageStructureObject, fallbackId: string): Part {
  const params = node.parameters ?? {};
  const dispositionParams = node.dispositionParameters ?? {};
  const encoding = (node.encoding ?? "7bit").toLowerCase();
  const encodedSize = node.size ?? 0;
  const contentId = node.id ? node.id.trim().replace(/^<|>$/g, "") : null;
  return {
    part: node.part ?? fallbackId,
    type: node.type.toLowerCase(),
    params,
    disposition: node.disposition ? node.disposition.toLowerCase() : null,
    filename: dispositionParams.filename ?? params.name ?? null,
    contentId: contentId || null,
    encoding,
    encodedSize,
    decodedSize: decodedSize(encodedSize, encoding),
  };
}

/**
 * Every leaf part, depth first, in the order the message carries them. An
 * attached message (`message/rfc822`) is one leaf: its insides belong to it.
 */
export function leafParts(structure: MessageStructureObject): Part[] {
  const out: Part[] = [];
  const walk = (node: MessageStructureObject): void => {
    if (isMultipart(node)) {
      for (const child of node.childNodes ?? []) walk(child);
      return;
    }
    out.push(toPart(node, "1"));
  };
  walk(structure);
  return out;
}

/**
 * The parts a reader shows as the message's text and HTML: the first
 * `text/plain` and the first `text/html` that are not attachments, looking into
 * every branch of a `multipart/alternative` but only into the first part of any
 * other multipart (the root of `related`, the body of `mixed`). The rest of a
 * `mixed` message is what was attached to it.
 */
export function bodyParts(structure: MessageStructureObject): BodyPartIds {
  const found: BodyPartIds = {};
  const walk = (node: MessageStructureObject): void => {
    if (isMultipart(node)) {
      const children = node.childNodes ?? [];
      if (node.type.toLowerCase() === "multipart/alternative") {
        for (const child of children) walk(child);
      } else if (children[0]) {
        walk(children[0]);
      }
      return;
    }
    const part = toPart(node, "1");
    if (part.disposition === "attachment") return;
    if (part.type === "text/plain" && !found.text) found.text = part.part;
    else if (part.type === "text/html" && !found.html) found.html = part.part;
  };
  walk(structure);
  return found;
}

/**
 * Every leaf that is not one of {@link bodyParts}: the message's attachments,
 * inline images and, for an invitation, the `text/calendar` alternative (M7).
 */
export function attachmentParts(structure: MessageStructureObject): Part[] {
  const bodies = new Set(Object.values(bodyParts(structure)));
  return leafParts(structure).filter((p) => !bodies.has(p.part));
}

/** The leaf a list preview reads: the plain text, else the HTML. */
export function previewPart(structure: MessageStructureObject): Part | null {
  const ids = bodyParts(structure);
  const id = ids.text ?? ids.html;
  if (!id) return null;
  return leafParts(structure).find((p) => p.part === id) ?? null;
}

function decodeQuotedPrintable(input: string): Buffer {
  // Soft line breaks go first; a cut-off escape at the very end is dropped.
  const text = input.replace(/=\r?\n/g, "").replace(/=[0-9A-Fa-f]?$/, "");
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    if (ch === 0x3d /* = */ && /^[0-9A-Fa-f]{2}$/.test(text.slice(i + 1, i + 3))) {
      bytes.push(parseInt(text.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(ch & 0xff);
    }
  }
  return Buffer.from(bytes);
}

function decodeBase64(input: string): Buffer {
  const clean = input.replace(/[^A-Za-z0-9+/=]/g, "");
  // A partial fetch ends wherever it ends: decode whole quadruples only.
  return Buffer.from(clean.slice(0, clean.length - (clean.length % 4)), "base64");
}

/**
 * The text of a part from its raw (transfer-encoded) bytes, in its charset.
 *
 * Built for previews, which fetch only the first few kilobytes of a part: an
 * escape or a multi-byte character cut off at the end is dropped rather than
 * shown as `=C3` or U+FFFD. A charset Node does not know is read as UTF-8,
 * so an odd label costs accuracy in one preview, not the whole list.
 */
export function decodeText(raw: Buffer, encoding: string, charset: string | undefined): string {
  const transfer = encoding.toLowerCase();
  const bytes =
    transfer === "quoted-printable"
      ? decodeQuotedPrintable(raw.toString("latin1"))
      : transfer === "base64"
        ? decodeBase64(raw.toString("latin1"))
        : raw;
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder((charset ?? "utf-8").trim() || "utf-8");
  } catch {
    decoder = new TextDecoder("utf-8");
  }
  return decoder.decode(bytes).replace(/�+$/, "");
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  auml: "ä",
  ouml: "ö",
  uuml: "ü",
  Auml: "Ä",
  Ouml: "Ö",
  Uuml: "Ü",
  szlig: "ß",
  eacute: "é",
  egrave: "è",
  agrave: "à",
  ccedil: "ç",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  laquo: "«",
  raquo: "»",
  bdquo: "„",
  ldquo: "“",
  rdquo: "”",
  lsquo: "‘",
  rsquo: "’",
  euro: "€",
  copy: "©",
  reg: "®",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    return NAMED_ENTITIES[body] ?? whole;
  });
}

/**
 * HTML reduced to its text, whitespace collapsed: enough for a preview, not a
 * renderer. Style, script and head are dropped with their contents; so is a
 * tag or block cut off at the end of a partial fetch.
 */
export function htmlToText(html: string): string {
  const text = html
    .replace(/<!--[\s\S]*?(-->|$)/g, " ")
    .replace(/<(style|script|head|title)\b[\s\S]*?(<\/\1\s*>|$)/gi, " ")
    .replace(/<[^>]*(>|$)/g, " ");
  return decodeEntities(text).replace(/\s+/g, " ").trim();
}
