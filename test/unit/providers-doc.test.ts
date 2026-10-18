/**
 * `docs/PROVIDERS.md`'s summary table, pinned against the registry it describes
 * (#182).
 *
 * The report is hand-written, and nearly all of it should be: the quotations,
 * the reasoning, what each provider's documentation does and does not say. One
 * column is not research but a restatement of code — which of the registry's
 * two views (`MAIL_PROVIDERS`, the presets; `PROVIDER_ADVICE`, the domain
 * advice) each provider is in. That column changes whenever `src/providers.ts`
 * does rather than when the research does, so it is the one most likely to go
 * stale, and before this test nothing noticed when it had.
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
  /** The second column, as written. */
  membership: string;
}

/**
 * The rows of the table under `## Summary` whose header starts `| Provider |`.
 * Everything before that header and everything after the first non-table line
 * is prose, and ignored.
 */
function summaryRows(): SummaryRow[] {
  const lines = doc.split("\n");
  const section = lines.findIndex((line) => line === "## Summary");
  assert.notEqual(section, -1, "docs/PROVIDERS.md has no `## Summary` section");
  const header = lines.findIndex((line, i) => i > section && line.startsWith("| Provider |"));
  assert.notEqual(header, -1, "the Summary section has no `| Provider |` table");

  const rows: SummaryRow[] = [];
  // header + 1 is the `| --- |` separator.
  for (const line of lines.slice(header + 2)) {
    if (!line.startsWith("|")) break;
    const cells = line.split("|").map((cell) => cell.trim());
    // A leading and a trailing pipe leave an empty cell at each end.
    const first = cells[1] ?? "";
    const link = /^\[([^\]]+)\]\(#[^)]*\)$/.exec(first);
    assert.ok(link, `the first column should be a link to the provider's section: ${first}`);
    rows.push({ name: link[1] as string, membership: cells[2] ?? "" });
  }
  return rows;
}

/**
 * The second column's vocabulary: which view or views, optionally "only", and
 * optionally the one field of that half that carries the provider's sentence.
 */
const MEMBERSHIP = /^(preset \+ advice|preset|advice)(?: only)?(?: \(`(note|credentialNote|unsupported)`\))?$/;

function expectedMembership(provider: Provider): string {
  if (provider.preset !== undefined && provider.advice !== undefined) return "preset + advice";
  if (provider.preset !== undefined) return "preset";
  return "advice";
}

describe("docs/PROVIDERS.md's summary table, against PROVIDERS", () => {
  it("has a row for every provider in the registry, named by its label", () => {
    const named = new Set(summaryRows().map((row) => row.name));
    for (const provider of PROVIDERS) {
      assert.ok(named.has(provider.label), `${provider.id} (${provider.label}) has no row in the summary`);
    }
  });

  it("has no row for a provider the registry does not hold", () => {
    const labels = new Set(PROVIDERS.map((provider) => provider.label));
    for (const row of summaryRows()) {
      assert.ok(labels.has(row.name), `the summary lists ${row.name}, which is not in PROVIDERS`);
    }
  });

  it("names each provider once", () => {
    const names = summaryRows().map((row) => row.name);
    assert.equal(new Set(names).size, names.length, names.join(", "));
  });

  it("says which view each provider is in, the way the registry says it", () => {
    for (const row of summaryRows()) {
      const provider = PROVIDERS.find((entry) => entry.label === row.name);
      if (provider === undefined) continue; // reported by the test above
      const parsed = MEMBERSHIP.exec(row.membership);
      assert.ok(parsed, `${row.name}: "${row.membership}" is not preset, advice, or preset + advice`);
      assert.equal(parsed[1], expectedMembership(provider), `${row.name}'s second column`);

      // A field named in brackets has to be one that provider actually carries.
      const field = parsed[2];
      if (field === "note") assert.notEqual(provider.preset?.note ?? "", "", `${row.name} has no note`);
      if (field === "credentialNote") {
        assert.notEqual(provider.advice?.credentialNote, undefined, `${row.name} has no credentialNote`);
      }
      if (field === "unsupported") {
        assert.notEqual(provider.advice?.unsupported, undefined, `${row.name} has no unsupported`);
      }
    }
  });

  it("links each row to a section headed with the same label", () => {
    // The first column is a label because the sections already were: each
    // provider's `###` heading is its registry label, so that is the one name
    // a reader of the code and a reader of the report both see.
    for (const provider of PROVIDERS) {
      assert.ok(doc.includes(`\n### ${provider.label}\n`), `no \`### ${provider.label}\` section`);
    }
  });
});
