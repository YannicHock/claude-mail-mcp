/**
 * That both packages' typecheck-only test projects actually contain test/.
 *
 * `npm run typecheck:test` is the only thing in this repository that typechecks
 * the test suites at all — the tests themselves run under `tsx`, which strips
 * types without checking them. And `tsc` reports success over an empty file list,
 * so a project that has been emptied by accident is indistinguishable from a
 * clean one: the command prints nothing and exits 0 either way. That happened
 * once already, between #126 and the line this file guards, and it went
 * unnoticed because there was nothing to notice.
 *
 * The trap is that `exclude` is **not** merged across `extends`. It comes from
 * whichever config declares it last, so the moment a parent tsconfig.json gains
 * a `"test"` entry, or the child drops its own `exclude`, the child inherits the
 * parent's and `test/**\/*` in `include` is cancelled. Both effects are silent
 * and green.
 *
 * Hence the two assertions per project below. They are cheap and structural; the
 * ground truth, if you would rather see it directly, is
 * `tsc -p tsconfig.test.json --listFiles` — the test files must appear in that
 * output. Run it from the package root, and from oauth/ for the OAuth layer.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const repoRoot = new URL("../../", import.meta.url);

/**
 * Parse a tsconfig, which is JSONC: both files under test carry the comments
 * that explain the very rule this file pins, so `JSON.parse` alone would throw.
 * Only `//` line comments are stripped, which is all either file uses; string
 * contents are left alone so a path like `"https://…"` survives.
 */
function readTsconfig(path: string): { include?: unknown; exclude?: unknown } {
  const raw = readFileSync(new URL(path, repoRoot), "utf8");
  let out = "";
  let inString = false;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += raw[i + 1] ?? "";
        i += 1;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "/" && raw[i + 1] === "/") {
      while (i < raw.length && raw[i] !== "\n") i += 1;
      out += "\n";
      continue;
    }
    out += ch;
  }
  return JSON.parse(out) as { include?: unknown; exclude?: unknown };
}

function stringsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** Does this `exclude` entry swallow the test directory? */
function excludesTests(entry: string): boolean {
  const normalized = entry.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  return normalized === "test" || normalized.startsWith("test/");
}

const projects = [
  { name: "connector", base: "tsconfig.json", test: "tsconfig.test.json" },
  { name: "oauth", base: "oauth/tsconfig.json", test: "oauth/tsconfig.test.json" },
];

for (const project of projects) {
  describe(`${project.test}`, () => {
    const base = readTsconfig(project.base);
    const testProject = readTsconfig(project.test);

    it("includes the test directory", () => {
      assert.ok(
        stringsOf(testProject.include).some((entry) => entry.replace(/\\/g, "/").startsWith("test/")),
        `${project.test} must include test/**/* or it typechecks no tests at all`
      );
    });

    it("declares its own exclude rather than inheriting the base project's", () => {
      // Looks byte-identical to the parent's and therefore removable. It is not:
      // `exclude` is taken from the last config that declares it, so this line is
      // the only thing standing between a future `"test"` entry in the parent and
      // a test project that silently contains nothing.
      assert.ok(
        Array.isArray(testProject.exclude),
        `${project.test} must declare its own "exclude" — inheriting ${project.base}'s ` +
          `lets a "test" entry added there cancel this project's include, silently and green`
      );
    });

    it("is not emptied by an exclude on either side", () => {
      for (const [file, config] of [
        [project.base, base],
        [project.test, testProject],
      ] as const) {
        for (const entry of stringsOf(config.exclude)) {
          assert.ok(
            !excludesTests(entry),
            `${file} excludes ${JSON.stringify(entry)}, which removes the test suite from ` +
              `${project.test}. Verify with: tsc -p ${project.test} --listFiles`
          );
        }
      }
    });
  });
}
