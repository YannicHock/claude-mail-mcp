/**
 * `docs/PROVIDERS.md`'s summary table, pinned against the registry it describes
 * (#182).
 *
 * The report is hand-written, and nearly all of it should be: the quotations,
 * the reasoning, what each provider's documentation does and does not say. One
 * column is not research but a restatement of code — which halves of the
 * registry entry (a preset, shown as `MAIL_PROVIDERS`; advice, shown as
 * `PROVIDER_ADVICE`) each provider has. That column changes whenever
 * `src/providers.ts` does rather than when the research does, so it is the one
 * most likely to go stale, and before this test nothing noticed when it had.
 *
 * Same reasoning as `compose-data-volumes.test.ts`: a property of a file rather
 * than of any code path, true once and liable to stop being true. And the same
 * method — deliberately crude string parsing, because a Markdown parser would be
 * a dependency this package does not have, and the shape being read is one
 * table row per provider. Only the first two columns are pinned; the prose and
 * the third column stay the author's.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { PROVIDERS, type Provider } from "../../src/providers.js";

const doc = readFileSync(new URL("../../docs/PROVIDERS.md", import.meta.url), "utf8").replace(
  /\r\n/g,
  "\n"
);

interface SummaryRow {
  /** The link text of the first column — a registry `label`, exactly. */
  name: string;
  /** The link target of the first column, without the `#`. */
  anchor: string;
  /** The second column, as written. */
  membership: string;
}

/**
 * Every row of the table under `## Summary` whose header starts `| Provider |`.
 *
 * Everything from that header to the next heading is read, not just up to the
 * first line that is not a table row, so a row stranded after a blank line is
 * still checked rather than silently dropped — and every `|` line in that range
 * has to be a row this function understands.
 */
function parseSummary(): SummaryRow[] {
  const lines = doc.split("\n");
  const section = lines.findIndex((line) => line === "## Summary");
  assert.notEqual(section, -1, "docs/PROVIDERS.md has no `## Summary` section");
  const header = lines.findIndex((line, i) => i > section && line.startsWith("| Provider |"));
  assert.notEqual(header, -1, "the Summary section has no `| Provider |` table");
  const nextHeading = lines.findIndex((line, i) => i > header && /^#{1,6} /.test(line));
  const end = nextHeading === -1 ? lines.length : nextHeading;

  const rows: SummaryRow[] = [];
  // header + 1 is the `| --- |` separator.
  for (const line of lines.slice(header + 2, end)) {
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").map((cell) => cell.trim());
    // A leading and a trailing pipe leave an empty cell at each end.
    const first = cells[1] ?? "";
    const link = /^\[([^\]]+)\]\(#([^)]*)\)$/.exec(first);
    assert.ok(link, `a summary row whose first column is not a link to its section: ${line}`);
    rows.push({ name: link[1] as string, anchor: link[2] as string, membership: cells[2] ?? "" });
  }
  return rows;
}

const ROWS = parseSummary();

/** The anchor GitHub generates for a heading. */
function githubSlug(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/ /g, "-");
}

/** The second column's whole vocabulary. */
function expectedMembership(provider: Provider): string {
  if (provider.preset !== undefined && provider.advice !== undefined) return "preset + advice";
  if (provider.preset !== undefined) return "preset";
  return "advice";
}

describe("docs/PROVIDERS.md's summary table, against PROVIDERS", () => {
  it("has a row for every provider in the registry, named by its label", () => {
    const named = new Set(ROWS.map((row) => row.name));
    for (const provider of PROVIDERS) {
      assert.ok(named.has(provider.label), `${provider.id} (${provider.label}) has no row in the summary`);
    }
  });

  it("has no row for a provider the registry does not hold", () => {
    const labels = new Set(PROVIDERS.map((provider) => provider.label));
    for (const row of ROWS) {
      assert.ok(labels.has(row.name), `the summary lists ${row.name}, which is not in PROVIDERS`);
    }
  });

  it("names each provider once", () => {
    const names = ROWS.map((row) => row.name);
    assert.equal(new Set(names).size, names.length, names.join(", "));
  });

  it("says which halves each provider has, the way the registry says it", () => {
    for (const row of ROWS) {
      const provider = PROVIDERS.find((entry) => entry.label === row.name);
      if (provider === undefined) continue; // reported by the test above
      assert.equal(row.membership, expectedMembership(provider), `${row.name}'s second column`);
    }
  });

  it("links each row to a section headed with the same label", () => {
    // The first column is a label because the sections already were: each
    // provider's `###` heading is its registry label, so that is the one name
    // a reader of the code and a reader of the report both see.
    for (const row of ROWS) {
      assert.equal(row.anchor, githubSlug(row.name), `${row.name}'s link`);
    }
    for (const provider of PROVIDERS) {
      assert.ok(doc.includes(`\n### ${provider.label}\n`), `no \`### ${provider.label}\` section`);
    }
  });
});
