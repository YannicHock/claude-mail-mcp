/**
 * `PUBLIC_URL`, the connector's half of the one value the two services must
 * agree on (src/config.ts).
 *
 * The mirror of `describe("PUBLIC_URL")` in oauth/test/unit/config.test.ts: both
 * readers now run the same canonicalisation, out of the mirrored
 * `canonical-url.ts` that test/unit/canonical-url.test.ts pins. This suite is the
 * connector's end of that — the parse, not the rule, which is why it asserts the
 * shape of the *reader* rather than re-testing the normaliser.
 *
 * `publicUrl` is exercised directly rather than through `config`, which is
 * evaluated once at import time — see the header of config.defaults.test.ts for
 * why each env constellation otherwise needs a file of its own. The default is
 * asserted on the real `config` object as well, since a reader that defaults
 * correctly is worth nothing if the field never reads it.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

delete process.env.PUBLIC_URL;
process.env.AUTH_TOKEN = "test-auth-token";

const { config, publicUrl } = await import("../../src/config.js");

describe("PUBLIC_URL", () => {
  it("defaults to the loopback address the field reads", () => {
    assert.equal(publicUrl({}), "http://localhost:3220");
    assert.equal(publicUrl({ PUBLIC_URL: "" }), "http://localhost:3220");
    assert.equal(publicUrl({ PUBLIC_URL: "   " }), "http://localhost:3220");
    assert.equal(config.publicUrl, "http://localhost:3220");
  });

  it("canonicalises the two spellings that used to 401 (#110)", () => {
    // Host case and an explicit default port. Both are the same URL to every
    // browser and every resolver, and both used to make `payload.iss !== issuer`
    // hold for the life of the deployment.
    assert.equal(
      publicUrl({ PUBLIC_URL: "https://Mail.Example.com" }),
      "https://mail.example.com"
    );
    assert.equal(
      publicUrl({ PUBLIC_URL: "https://mail.example.com:443" }),
      "https://mail.example.com"
    );
  });

  it("still strips the trailing slash and the whitespace it always stripped", () => {
    assert.equal(publicUrl({ PUBLIC_URL: "  https://mail.example.com///  " }), "https://mail.example.com");
  });

  it("keeps a port that is not the scheme's default", () => {
    assert.equal(
      publicUrl({ PUBLIC_URL: "https://mail.example.com:8443/mcp" }),
      "https://mail.example.com:8443/mcp"
    );
  });

  it("refuses a value that is not an absolute http(s) URL", () => {
    // Fatal at boot rather than carried along: an unusable issuer can only
    // answer 401 to every settings request, which is the failure this rejection
    // exists to replace. The message names PUBLIC_URL, which the 401 never did.
    for (const bad of ["mail.example.com", "ftp://mail.example.com", "https://mail.example.com#f"]) {
      assert.throws(
        () => publicUrl({ PUBLIC_URL: bad }),
        (err: unknown) => err instanceof Error && err.message.includes("PUBLIC_URL"),
        `expected ${bad} to be refused`
      );
    }
  });
});
