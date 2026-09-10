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
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, describe, it } from "node:test";

const repoRoot = new URL("../../", import.meta.url);

/**
 * Every .ts file under `dir`, at any depth.
 *
 * Recursive on purpose. A non-recursive walk fails *open*: both source trees are
 * flat today, so it looks complete, and the first `src/mail/` a later wave adds
 * takes everything inside it out of this guard with no test failure and no signal
 * of any kind. A duplicate-detector that can be switched off by creating a
 * directory is worse than none, because it reads as coverage.
 *
 * That argument applies to this function too, which is why `describe("tsFilesIn")`
 * below walks a temp directory that really does have a subdirectory in it:
 * against the flat trees this repository ships, dropping `recursive: true` breaks
 * nothing and every other test here stays green.
 *
 * `dir` is resolved against the repository root, so it is normally a relative
 * prefix like `"src/"` — but any absolute `file:` URL ending in `/` works too,
 * since `new URL()` ignores the base for those. The returned paths are that same
 * prefix plus a forward-slash-separated remainder, on every platform.
 */
function tsFilesIn(dir: string): string[] {
  const base = fileURLToPath(new URL(dir, repoRoot));
  return readdirSync(base, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => {
      const full = join(entry.parentPath, entry.name);
      return `${dir}${relative(base, full).split(sep).join("/")}`;
    })
    .sort();
}

function read(file: string): string {
  return readFileSync(new URL(file, repoRoot), "utf8").replace(/\r\n/g, "\n");
}

/**
 * The `export …` forms that bind a name locally.
 *
 * `export { name } from "…"` and `export type { name } from "…"` are deliberately
 * absent: they bind nothing locally, which is exactly the difference between
 * re-exporting the shared declaration and writing a second one.
 */
const EXPORTED_DECLARATION_PATTERNS = [
  /^export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm,
  /^export\s+(?:const|let|var|class|abstract\s+class|interface|enum)\s+([A-Za-z_$][\w$]*)/gm,
  /^export\s+type\s+([A-Za-z_$][\w$]*)\s*[=<]/gm,
] as const;

/** The same forms without the `export`, for declarations a module keeps to itself. */
const LOCAL_DECLARATION_PATTERNS = [
  /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm,
  /^(?:const|let|var|class|interface|enum)\s+([A-Za-z_$][\w$]*)/gm,
  /^type\s+([A-Za-z_$][\w$]*)\s*[=<]/gm,
] as const;

function namesMatching(source: string, patterns: readonly RegExp[]): Set<string> {
  const names = new Set<string>();
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (match[1] !== undefined) names.add(match[1]);
    }
  }
  return names;
}

/**
 * Names declared at the top level of a module, exported or not.
 *
 * The two tables are shared with {@link exportedNames} rather than spelled out
 * twice: this is the file whose entire subject is refusing a rule written in two
 * places, and it had the three `^export …` regexes character-for-character in
 * both functions.
 */
function declaredNames(source: string): Set<string> {
  return namesMatching(source, [...EXPORTED_DECLARATION_PATTERNS, ...LOCAL_DECLARATION_PATTERNS]);
}

/** The same, restricted to what a module actually exports. */
function exportedNames(source: string): Set<string> {
  return namesMatching(source, EXPORTED_DECLARATION_PATTERNS);
}

describe("tsFilesIn", () => {
  // A fixture with a subdirectory, which neither src/ nor oauth/src/ has. Without
  // it, `recursive: true` is unpinned: remove it and this whole file still passes.
  const fixture = mkdtempSync(join(tmpdir(), "shared-modules-walk-"));
  mkdirSync(join(fixture, "nested"));
  writeFileSync(join(fixture, "a.ts"), "export const a = 1;\n", "utf8");
  writeFileSync(join(fixture, "nested", "b.ts"), "export const b = 2;\n", "utf8");
  writeFileSync(join(fixture, "nested", "notes.md"), "not typescript\n", "utf8");
  const dir = pathToFileURL(join(fixture, "/")).href;

  after(() => rmSync(fixture, { recursive: true, force: true }));

  it("finds a .ts file inside a subdirectory, not just the top level", () => {
    assert.deepEqual(tsFilesIn(dir), [`${dir}a.ts`, `${dir}nested/b.ts`]);
  });

  it("separates the nested path with forward slashes on every platform", () => {
    // `relative()` yields backslashes on Windows; the guard below compares these
    // strings against literals like "src/autoconfig.ts", so the split/join is not
    // cosmetic.
    const nested = tsFilesIn(dir).find((file) => file.endsWith("b.ts"));
    assert.ok(nested, "the nested file is found at all");
    assert.ok(nested.endsWith("nested/b.ts"), `expected forward slashes, got ${nested}`);
    assert.ok(!nested.includes("\\"), `expected no backslashes, got ${nested}`);
  });
});

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

  it("exports the credential classifier #146 moved out of src/probe.ts", () => {
    // Named for the same reason as the list above: the generic guard below
    // only fires on a *second* copy, so a module that quietly lost its
    // classifier would leave it asserting over nothing at all. `src/probe.ts`
    // re-exports MAX_MESSAGE_LENGTH and CREDENTIAL_REJECTION_MESSAGE, which is
    // why every existing `import … from "./probe.js"` still resolves; the two
    // tool registries import the classifier from here directly.
    for (const name of [
      "isCredentialRejection",
      "classifyFailure",
      "describeFailure",
      "CREDENTIAL_REJECTION_MESSAGE",
      "MAX_MESSAGE_LENGTH",
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
