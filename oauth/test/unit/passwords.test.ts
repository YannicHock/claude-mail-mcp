import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  constantTimeEquals,
  hashPassword,
  isValidHashFormat,
  parseHash,
  verifyPassword,
} from "../../src/passwords.js";

/**
 * Cheap parameters for the tests. The shipped default is N=2^16, which takes long
 * enough per call that using it here would dominate the suite's runtime for no
 * added coverage — the code path is identical.
 */
const FAST = { N: 1024, r: 8, p: 1 } as const;

describe("hashPassword / verifyPassword", () => {
  it("verifies the password it hashed", async () => {
    const hash = await hashPassword("correct horse battery staple", FAST);
    assert.equal(await verifyPassword("correct horse battery staple", hash), true);
  });

  it("rejects a wrong password", async () => {
    const hash = await hashPassword("correct horse battery staple", FAST);
    assert.equal(await verifyPassword("Correct horse battery staple", hash), false);
    assert.equal(await verifyPassword("", hash), false);
  });

  it("produces a different hash each time, so the salt is actually random", async () => {
    const a = await hashPassword("same password", FAST);
    const b = await hashPassword("same password", FAST);
    assert.notEqual(a, b);
    assert.equal(await verifyPassword("same password", a), true);
    assert.equal(await verifyPassword("same password", b), true);
  });

  it("encodes its cost parameters so they can be raised later", async () => {
    const hash = await hashPassword("pw", FAST);
    const parsed = parseHash(hash);
    assert.ok(parsed);
    assert.equal(parsed.N, FAST.N);
    assert.equal(parsed.r, FAST.r);
    assert.equal(parsed.p, FAST.p);
  });

  it("verifies a hash made with different parameters than the current default", async () => {
    const old = await hashPassword("pw", { N: 512, r: 8, p: 1 });
    assert.equal(await verifyPassword("pw", old), true);
  });

  it("normalises unicode so an equivalent password still verifies", async () => {
    // "ä" as a single code point vs. "a" + combining diaeresis.
    const hash = await hashPassword("pässword", FAST);
    assert.equal(await verifyPassword("pässword", hash), true);
  });

  it("uses the default parameters when none are given", async () => {
    const hash = await hashPassword("pw");
    const parsed = parseHash(hash);
    assert.ok(parsed);
    assert.equal(parsed.N, 2 ** 16);
    assert.equal(await verifyPassword("pw", hash), true);
  });
});

describe("parseHash", () => {
  it("accepts a well-formed hash", async () => {
    assert.equal(isValidHashFormat(await hashPassword("pw", FAST)), true);
  });

  it("tolerates surrounding whitespace, which a secret file usually has", async () => {
    const hash = await hashPassword("pw", FAST);
    assert.equal(isValidHashFormat(`${hash}\n`), true);
    assert.equal(await verifyPassword("pw", `  ${hash}\n`), true);
  });

  it("rejects malformed input rather than throwing", () => {
    for (const bad of [
      "",
      "not-a-hash",
      "scrypt$16384$8$1$onlyfourfields",
      "bcrypt$16384$8$1$c2FsdA$aGFzaA",
      "scrypt$0$8$1$c2FsdA$aGFzaA",
      "scrypt$-1$8$1$c2FsdA$aGFzaA",
      "scrypt$notanumber$8$1$c2FsdA$aGFzaA",
      "scrypt$16384$8$1$$aGFzaA",
      "scrypt$16384$8$1$c2FsdA$",
    ]) {
      assert.equal(parseHash(bad), null, `expected null for ${JSON.stringify(bad)}`);
      assert.equal(isValidHashFormat(bad), false);
    }
  });

  it("rejects an N that is not a power of two, which scrypt would reject at call time", () => {
    assert.equal(parseHash("scrypt$16385$8$1$c2FsdA$aGFzaA"), null);
  });

  it("makes verifyPassword return false for a malformed hash instead of throwing", async () => {
    assert.equal(await verifyPassword("pw", "garbage"), false);
    assert.equal(await verifyPassword("pw", ""), false);
  });
});

describe("constantTimeEquals", () => {
  it("compares equal strings as equal", () => {
    assert.equal(constantTimeEquals("operator", "operator"), true);
  });

  it("rejects different strings, including different lengths", () => {
    assert.equal(constantTimeEquals("operator", "Operator"), false);
    assert.equal(constantTimeEquals("operator", "operator2"), false);
    assert.equal(constantTimeEquals("", "operator"), false);
  });

  it("handles empty strings", () => {
    assert.equal(constantTimeEquals("", ""), true);
  });

  it("compares by bytes, not by code units", () => {
    assert.equal(constantTimeEquals("ä", "ä"), true);
    assert.equal(constantTimeEquals("ä", "a"), false);
  });
});
