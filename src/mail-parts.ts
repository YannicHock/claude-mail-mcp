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

/** A `text/plain` or `text/html` leaf a reader shows inline: no attachment disposition, no name. */
function isBodyLeaf(part: Part): boolean {
  return (
    (part.type === "text/plain" || part.type === "text/html") &&
    part.disposition !== "attachment" &&
    part.filename === null
  );
}

/**
 * The parts a reader shows as the message's text and HTML, in order.
 *
 * - `multipart/alternative` and `multipart/mixed`: every branch is looked
 *   into, so the text after an inline photo (Apple Mail, mailing-list
 *   footers) is body, not an attachment.
 * - Any other multipart (`related`, `signed`, `report`, …): only its first
 *   part, its root; the rest is what that root refers to or is signed with.
 * - A leaf is body when it is `text/plain` or `text/html`, not an
 *   attachment by disposition, and carries no file name. A `text/calendar` is
 *   never body: the invitation reader reads it as a leaf of its own (M7).
 */
export function bodyParts(structure: MessageStructureObject): BodyPartIds {
  const found: BodyPartIds = { text: [], html: [] };
  const walk = (node: MessageStructureObject): void => {
    if (isMultipart(node)) {
      const children = node.childNodes ?? [];
      const subtype = node.type.toLowerCase();
      if (subtype === "multipart/alternative" || subtype === "multipart/mixed") {
        for (const child of children) walk(child);
      } else if (children[0]) {
        walk(children[0]);
      }
      return;
    }
    const part = toPart(node, "1");
    if (!isBodyLeaf(part)) return;
    if (part.type === "text/plain") found.text.push(part.part);
    else found.html.push(part.part);
  };
  walk(structure);
  return found;
}

/**
 * Every leaf that is not one of {@link bodyParts}: the message's attachments,
 * inline images and, for an invitation, the `text/calendar` alternative (M7).
 */
export function attachmentParts(structure: MessageStructureObject): Part[] {
  const ids = bodyParts(structure);
  const bodies = new Set([...ids.text, ...ids.html]);
  return leafParts(structure).filter((p) => !bodies.has(p.part));
}

/** The leaf a list preview reads: the first plain-text body part, else the first HTML one. */
export function previewPart(structure: MessageStructureObject): Part | null {
  const ids = bodyParts(structure);
  const id = ids.text[0] ?? ids.html[0];
  if (!id) return null;
  return leafParts(structure).find((p) => p.part === id) ?? null;
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
