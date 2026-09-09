/**
 * The two data volumes, pinned against the way they used to be.
 *
 * `docker-compose.yml` bind-mounted `./data` and `./oauth-data`, and neither
 * directory is tracked in git — so on a clean clone Docker created both itself,
 * as `root:root` mode 755. The two services run as uid 100 and uid 102. The
 * connector then could not save a mailbox and the OAuth layer could not write
 * the claim token at all, which meant it never printed a setup URL: the one
 * thing the whole first boot exists to produce, on the one boot an operator is
 * watching the log for it (#105).
 *
 * Named volumes are what fixed it. Docker initialises an empty one from the
 * image, ownership included, and both images pre-create `/data` owned by their
 * own runtime user — so the ownership is right with no operator step, and no
 * instruction anywhere has to name a uid.
 *
 * That is a property of a file rather than of any code path, which is exactly
 * the kind that was true once and stopped being true. These assertions are
 * deliberately crude string checks: a real YAML parse would need a dependency
 * this package does not have, and the shapes being pinned are one line each.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const compose = readFileSync(new URL("../../docker-compose.yml", import.meta.url), "utf8").replace(
  /\r\n/g,
  "\n"
);

/**
 * The `volumes:` key at column 0, and the names indented under it. There is
 * exactly one such block and it is the top-level one — a service's own
 * `volumes:` is indented four spaces.
 */
function declaredVolumes(): string[] {
  const lines = compose.split("\n");
  const start = lines.findIndex((line) => line === "volumes:");
  if (start === -1) return [];
  const names: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "" || line.startsWith("#")) continue;
    const declared = /^ {2}([\w.-]+):/.exec(line);
    if (declared === null) break;
    names.push(declared[1] as string);
  }
  return names;
}

/** Every `- <source>:/data` mount in the file, in order: the connector's, then the OAuth layer's. */
function dataMountSources(): string[] {
  return (compose.match(/^\s*-\s*(\S+):\/data$/gm) ?? []).map((line) =>
    line.replace(/^\s*-\s*/, "").replace(/:\/data$/, "")
  );
}

describe("the two data volumes", () => {
  it("are mounted at /data once per service, and both are named volumes", () => {
    const sources = dataMountSources();
    assert.equal(sources.length, 2, `expected one /data mount per service, got ${sources.length}`);
    for (const source of sources) {
      assert.doesNotMatch(
        source,
        /^[./~]/,
        `${source}:/data is a bind mount. Docker creates a missing bind-mount source as ` +
          `root:root 755 and neither service can write in it — which is #105, and it costs ` +
          `the operator their setup URL. Use a named volume, which Docker initialises from ` +
          `the image with the runtime user's ownership.`
      );
    }
  });

  it("are declared in the top-level volumes block", () => {
    const declared = declaredVolumes();
    for (const source of dataMountSources()) {
      assert.ok(
        declared.includes(source),
        `${source} is mounted but not declared under the top-level volumes: key — ` +
          `Compose will not create it. Declared: ${declared.join(", ") || "(none)"}`
      );
    }
  });

  it("no longer ask the operator to chown a directory before the first boot", () => {
    // The interim from #21 and #25, and the thing this change exists to remove:
    // two `chown` commands carrying the images' uids, in front of a first-time
    // reader, in a document that has no way of noticing when those numbers move.
    // Nothing has to know them now — the named volume gets ownership from the
    // image, and the one place a uid is still spoken aloud is the message a
    // running service prints about itself.
    for (const doc of ["README.md", "docs/DEPLOYMENT.md"]) {
      const text = readFileSync(new URL(`../../${doc}`, import.meta.url), "utf8");
      // Matched rather than asserted with doesNotMatch, which would print the
      // whole document into the failure.
      //
      // The bare directory name is what both interim instructions used —
      // `sudo chown 100:101 data`. The `./`-prefixed form is left alone on
      // purpose: docs/DEPLOYMENT.md quotes the message a *service* prints about
      // its own uid, which is the thing that replaced these instructions and is
      // the one place a uid may still appear.
      const found = /chown\s+\d+:\d+\s+(data|oauth-data)\b/.exec(text);
      assert.equal(
        found,
        null,
        `${doc} still tells the operator to "${found?.[0]}" — a data directory chowned to a ` +
          `hardcoded uid. The named volume makes that unnecessary; a deployment that ` +
          `bind-mounts the path anyway gets the exact command from the service itself, ` +
          `which cannot be out of date about its own uid.`
      );
    }
  });
});
