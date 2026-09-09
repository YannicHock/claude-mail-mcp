/**
 * `TRUST_PROXY`, the connector's reverse-proxy hop count (src/config.ts).
 *
 * The same suite the OAuth layer has guarded its own copy with since it shipped
 * — `describe("trust proxy")` in oauth/test/unit/config.test.ts — because the
 * two settings mean the same thing and must not drift apart again. What the
 * connector did instead, until #107, was `app.set("trust proxy", true)`: the
 * whole chain trusted and its leftmost entry taken, which is the entry the
 * client writes. test/unit/app-trust-proxy.test.ts covers the served effect;
 * this covers the parse.
 *
 * `trustProxyHops` is exercised directly rather than through `config`, which is
 * evaluated once at import time — see the header of config.defaults.test.ts for
 * why each env constellation otherwise needs a file of its own. The default is
 * asserted on the real `config` object as well, since a parser that defaults
 * correctly is worth nothing if the field never reads it.
 */
import { describe, it, test } from "node:test";
import assert from "node:assert/strict";

delete process.env.TRUST_PROXY;
process.env.AUTH_TOKEN = "test-auth-token";

const { config, trustProxyHops } = await import("../../src/config.js");

describe("trust proxy", () => {
  it("defaults to a single hop, not to trusting the whole chain", () => {
    // A boolean would let a client pick its own req.ip through X-Forwarded-For
    // and write an address of its choosing into the rejection log a jail reads.
    assert.equal(trustProxyHops({}), 1);
    assert.equal(trustProxyHops({ TRUST_PROXY: "" }), 1);
    assert.equal(trustProxyHops({ TRUST_PROXY: "   " }), 1);
  });

  it("accepts a different hop count", () => {
    assert.equal(trustProxyHops({ TRUST_PROXY: "2" }), 2);
  });

  it("accepts 0 for a service nothing proxies", () => {
    assert.equal(trustProxyHops({ TRUST_PROXY: "0" }), 0);
  });

  it("rejects a boolean or a negative value", () => {
    for (const value of ["true", "-1", "yes", "1.5"]) {
      assert.throws(
        () => trustProxyHops({ TRUST_PROXY: value }),
        /TRUST_PROXY/,
        `TRUST_PROXY=${value} should be rejected`
      );
    }
  });
});

test("config exposes the hop count, defaulting to one", () => {
  assert.equal(config.trustProxy, 1);
});
