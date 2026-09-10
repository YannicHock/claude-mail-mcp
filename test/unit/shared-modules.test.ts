/**
 * The one guard that replaces four drift tests.
 *
 * Until #126 the two packages mirrored six modules by hand and protected them
 * four different ways: three whole-file comparators that stripped the header
 * comment (secrets.ts, settings-api.ts, canonical-url.ts, the last of them also
 * rewriting one import), one comparator that pulled two declarations out with a
 * regex (the settings header set), and — for `trustProxyHops` and `escapeHtml` —
 * nothing at all. Those four were four readings of the same intent, and the two
 * unpinned pairs were the evidence that the pattern was applied when a wave
 * happened to notice a shared rule and skipped when it did not.
 *
 * shared/ is compiled into both images now, so "the copies match" is not an
 * invariant any more; there are no copies. What matters going forward is the
 * other question, the one nothing used to ask: **did a second copy appear?**
 *
 * So this test reads every symbol `shared/` exports and fails if `src/` or
 * `oauth/src/` *declares* one of the same names. Re-exporting is fine and is how
 * both packages keep their existing import sites — `export { escapeHtml } from
 * "../shared/escape-html.js"` in src/settings-pages.ts, `export type { Logger }
 * from "../../shared/log.js"` in oauth/src/logger.ts. Writing the body again is
 * what this refuses.
 *
 * Source text rather than imports, for the reason the old comparators used it:
 * `src/` and `oauth/src/` are separate npm packages with separate
 * `node_modules`, and nothing under `test/` may import across that line.
 *
 * If a new shared export collides with a name a package legitimately uses for
 * something unrelated, the fix is to rename one of them. Two declarations of
 * `pageHeaders` in this repository have never once meant two different things.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

const repoRoot = new URL("../../", import.meta.url);

function tsFilesIn(dir: string): string[] {
  return readdirSync(new URL(dir, repoRoot), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => `${dir}${entry.name}`)
    .sort();
}

function read(relative: string): string {
  return readFileSync(new URL(relative, repoRoot), "utf8").replace(/\r\n/g, "\n");
}

/**
 * Names declared at the top level of a module.
 *
 * `export { name } from "…"` and `export type { name } from "…"` are deliberately
 * not matched: they bind nothing locally, which is exactly the difference
 * between re-exporting the shared declaration and writing a second one.
 */
function declaredNames(source: string): Set<string> {
  const names = new Set<string>();
  const patterns = [
    /^export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm,
    /^export\s+(?:const|let|var|class|abstract\s+class|interface|enum)\s+([A-Za-z_$][\w$]*)/gm,
    /^export\s+type\s+([A-Za-z_$][\w$]*)\s*[=<]/gm,
    /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm,
    /^(?:const|let|var|class|interface|enum)\s+([A-Za-z_$][\w$]*)/gm,
    /^type\s+([A-Za-z_$][\w$]*)\s*[=<]/gm,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (match[1] !== undefined) names.add(match[1]);
    }
  }
  return names;
}

/** The same, restricted to what a module actually exports. */
function exportedNames(source: string): Set<string> {
  const names = new Set<string>();
  const patterns = [
    /^export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm,
    /^export\s+(?:const|let|var|class|abstract\s+class|interface|enum)\s+([A-Za-z_$][\w$]*)/gm,
    /^export\s+type\s+([A-Za-z_$][\w$]*)\s*[=<]/gm,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (match[1] !== undefined) names.add(match[1]);
    }
  }
  return names;
}

const sharedFiles = tsFilesIn("shared/");

describe("shared/", () => {
  it("is not empty, so a broken glob cannot pass this file silently", () => {
    assert.ok(sharedFiles.length >= 6, `expected the shared modules, found ${sharedFiles.length}`);
  });

  const sharedExports = new Map<string, string>();
  for (const file of sharedFiles) {
    for (const name of exportedNames(read(file))) {
      sharedExports.set(name, file);
    }
  }

  it("exports the six duplicates #126 consolidated", () => {
    // Named explicitly: a rename that quietly emptied one of these modules would
    // otherwise leave the guard below asserting over a shorter list and passing.
    for (const name of [
      "resolveSecret",
      "MAILBOX_FIELDS",
      "normalisePublicUrl",
      "pageHeaders",
      "SETTINGS_CSP",
      "trustProxyHops",
      "escapeHtml",
      "Logger",
    ]) {
      assert.ok(sharedExports.has(name), `shared/ no longer exports ${name}`);
    }
  });

  /**
   * The one deliberate exception, written down rather than tolerated silently.
   *
   * src/autoconfig.ts declares its own structurally-identical `SuggestedServer`,
   * `SuggestedCalDav`, `SuggestionSource` and `MailboxSuggestion`. That is not a
   * copy that drifted in: settings-routes.ts hands the lookup's answer straight
   * over as the wire contract's, and two independent declarations are what make
   * a field added to one of them a compile error at that hand-off rather than a
   * field that goes quietly missing on the way across. Collapsing them would
   * delete that check, which is a design question (#6's neighbourhood) and not
   * part of the move.
   *
   * Anything else lands here only by being argued for in a review.
   */
  const deliberateMirrors = new Map<string, ReadonlySet<string>>([
    [
      "src/autoconfig.ts",
      new Set(["SuggestedServer", "SuggestedCalDav", "SuggestionSource", "MailboxSuggestion"]),
    ],
  ]);

  for (const dir of ["src/", "oauth/src/"]) {
    it(`is not copied back into ${dir}`, () => {
      const offences: string[] = [];
      for (const file of tsFilesIn(dir)) {
        for (const name of declaredNames(read(file))) {
          const home = sharedExports.get(name);
          if (home !== undefined && !deliberateMirrors.get(file)?.has(name)) {
            offences.push(`${file} declares ${name}, which ${home} already exports`);
          }
        }
      }
      assert.deepEqual(
        offences,
        [],
        `a second copy of a shared declaration has appeared:\n  ${offences.join("\n  ")}\n` +
          `Import it from shared/ — or re-export it, which is what the packages do ` +
          `for the names their own modules have always been imported under.`
      );
    });
  }
});
