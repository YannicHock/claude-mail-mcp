/**
 * Dependencies whose version is pinned to another package's, on purpose.
 *
 * `html-to-text` turns HTML into `get_message`'s `bodyText` on two paths: inside
 * mailparser for a message read whole, and in src/imap-client.ts for one read
 * by part (over 2 MB) and for the list previews. Both must be the same version,
 * or one message reads differently depending on its size. So the connector's
 * pin must equal what mailparser asks for, and a mailparser upgrade that moves
 * it fails here until the pin follows.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

function manifest(path: string): { version?: string; dependencies?: Record<string, string> } {
  return JSON.parse(readFileSync(path, "utf8"));
}

test("mailparser still has the textToHtml instance method the by-part read borrows", async () => {
  // src/imap-client.ts renders plain text as HTML with mailparser's own,
  // undeclared `textToHtml`, so a message reads the same over and under 2 MB.
  const { MailParser } = await import("mailparser");
  const parser = new MailParser() as unknown as { textToHtml?: unknown };
  assert.equal(typeof parser.textToHtml, "function");
});

test("html-to-text is pinned to exactly the version mailparser depends on", () => {
  const ours = manifest(require.resolve("../../package.json")).dependencies?.["html-to-text"];
  const mailparsers = manifest(require.resolve("mailparser/package.json")).dependencies?.["html-to-text"];
  assert.ok(ours, "package.json does not depend on html-to-text");
  assert.ok(mailparsers, "mailparser no longer depends on html-to-text");
  assert.match(ours!, /^\d+\.\d+\.\d+$/, `the pin must be an exact version, got ${ours}`);
  assert.equal(ours, mailparsers);
  const installed = manifest(require.resolve("html-to-text/package.json")).version;
  assert.equal(installed, ours, "the installed html-to-text is not the pinned one");
});
