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
 * Also here, because every reader of a part needs it and it is just as pure:
 * turning a part's raw (transfer-encoded) bytes into its text.
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
  /** Upper bound of the size once the transfer encoding is undone; see {@link decodedSize}. */
  decodedSize: number;
}

/**
 * The part ids a reader shows as the message's text and its HTML, each in the
 * order the message carries them. Usually one of each at most; Apple Mail's
 * "text, photo, text" has two text parts, and its HTML version two HTML parts.
 */
export interface BodyPartIds {
  text: string[];
  html: string[];
}

/**
 * Upper bound of the decoded size of a part whose BODYSTRUCTURE size is
 * `encodedSize`.
 *
 * Base64: × 3/4, rounded up, line breaks and all. That overshoots by the line
 * breaks, about 2.5 % for the usual 76-character lines (nodemailer writes
 * 300,000 bytes as 410,526, which gives 307,895), but it never undershoots,
 * which is what a size check ahead of a truncating download needs (spec §2.6,
 * M4). Every other encoding is reported as it is: quoted-printable only ever
 * shrinks when decoded, so its encoded size is an upper bound too.
 *
 * GreenMail counts a part's own MIME header into its size (410,670 for the
 * part above); that only makes the bound looser.
 */
export function decodedSize(encodedSize: number, encoding: string): number {
  if (encodedSize <= 0) return 0;
  if (encoding.toLowerCase() !== "base64") return encodedSize;
  return Math.ceil((encodedSize * 3) / 4);
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

/** The types mailparser reads as text (with `keepDeliveryStatus` off, its default). */
const BODY_TYPES = new Set(["text/plain", "text/html", "message/delivery-status"]);

/**
 * mailparser's rule for a leaf that is text, not an attachment: a body type
 * with no disposition or `inline`. Any other disposition is an attachment; a
 * file name does not matter.
 */
function isBodyLeaf(part: Part): boolean {
  return BODY_TYPES.has(part.type) && (part.disposition === null || part.disposition === "inline");
}

/** A body leaf, and the `multipart/alternative` it is one of the versions of. */
export interface BodyLeaf extends Part {
  /**
   * Part id of the nearest `multipart/alternative` above this leaf (`""` when
   * that is the message's root), or null when the leaf is in none: then it is
   * not a version of something else but a piece of the body in its own right.
   */
  alternative: string | null;
}

/**
 * The leaves a reader shows as the message's body, in document order, by
 * mailparser's rule, so `get_message` reads a message the same whole (through
 * mailparser) and by part:
 *
 * - every child of every multipart is walked, so the text after an inline
 *   photo (Apple Mail), a mailing list's plain footer after an HTML post, and
 *   a bounce's delivery status are body;
 * - a leaf is body when it is `text/plain`, `text/html` or
 *   `message/delivery-status` with no disposition or `inline`; any other
 *   disposition makes it an attachment, and a file name does not matter.
 *   A `text/calendar` is never body: the invitation reader reads it as a leaf
 *   of its own (M7).
 *
 * One difference is kept on purpose: an attached `message/rfc822` is one leaf
 * here, while mailparser descends into an inline one and shows its text.
 */
export function bodyLeaves(structure: MessageStructureObject): BodyLeaf[] {
  const found: BodyLeaf[] = [];
  const walk = (node: MessageStructureObject, alternative: string | null): void => {
    if (isMultipart(node)) {
      const inner = node.type.toLowerCase() === "multipart/alternative" ? (node.part ?? "") : alternative;
      for (const child of node.childNodes ?? []) walk(child, inner);
      return;
    }
    const part = toPart(node, "1");
    if (isBodyLeaf(part)) found.push({ ...part, alternative });
  };
  walk(structure, null);
  return found;
}

/**
 * The ids of {@link bodyLeaves}, split into HTML and the rest (plain text and
 * delivery status, which read as text), each in document order.
 */
export function bodyParts(structure: MessageStructureObject): BodyPartIds {
  const found: BodyPartIds = { text: [], html: [] };
  for (const leaf of bodyLeaves(structure)) {
    if (leaf.type === "text/html") found.html.push(leaf.part);
    else found.text.push(leaf.part);
  }
  return found;
}

/**
 * The leaves `get_message` lists as attachments: every leaf that is not body,
 * which covers inline images and, for an invitation, the `text/calendar`
 * alternative (M7); plus every body leaf with a file name, which is read as
 * text and still listed so it can be fetched as the file it is.
 */
export function attachmentParts(structure: MessageStructureObject): Part[] {
  const bodies = new Set(bodyLeaves(structure).map((leaf) => leaf.part));
  return leafParts(structure).filter((p) => !bodies.has(p.part) || p.filename !== null);
}

/**
 * The leaf a list preview reads: the first body leaf in document order, so an
 * HTML post with a plain footer previews the post. When that leaf is one
 * version in an alternative, the plain-text version of the same alternative
 * is preferred.
 */
export function previewPart(structure: MessageStructureObject): Part | null {
  const leaves = bodyLeaves(structure);
  const first = leaves[0];
  if (!first) return null;
  if (first.alternative === null || first.type === "text/plain") return first;
  return leaves.find((l) => l.alternative === first.alternative && l.type === "text/plain") ?? first;
}

function decodeQuotedPrintable(input: string, partial: boolean): Buffer {
  // Soft line breaks go first; a cut-off escape at the very end of a partial
  // fetch is dropped.
  let text = input.replace(/=\r?\n/g, "");
  if (partial) text = text.replace(/=[0-9A-Fa-f]?$/, "");
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
 * `partial` is for a fetch cut off after a few kilobytes (the list previews):
 * an escape or a multi-byte character cut in two at the end is dropped rather
 * than shown as `=C3` or U+FFFD. A complete part keeps every byte it has. A
 * charset Node does not know is read as UTF-8, so an odd label costs accuracy
 * in one text, not the whole call.
 */
export function decodeText(
  raw: Buffer,
  encoding: string,
  charset: string | undefined,
  opts: { partial?: boolean } = {}
): string {
  const partial = opts.partial ?? false;
  const transfer = encoding.toLowerCase();
  const bytes =
    transfer === "quoted-printable"
      ? decodeQuotedPrintable(raw.toString("latin1"), partial)
      : transfer === "base64"
        ? decodeBase64(raw.toString("latin1"))
        : raw;
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder((charset ?? "utf-8").trim() || "utf-8");
  } catch {
    decoder = new TextDecoder("utf-8");
  }
  const text = decoder.decode(bytes);
  return partial ? text.replace(/�+$/, "") : text;
}

/**
 * The text of `part` from the bytes a FETCH returned for it, by the part's own
 * transfer encoding and charset. `binary`: the server answered with FETCH
 * BINARY and has already undone the transfer encoding. `partial`: the bytes are
 * the start of the part only (see {@link decodeText}).
 */
export function decodePart(
  part: Part,
  bytes: Buffer,
  opts: { binary?: boolean; partial?: boolean } = {}
): string {
  return decodeText(bytes, opts.binary ? "binary" : part.encoding, part.params.charset, {
    partial: opts.partial,
  });
}

