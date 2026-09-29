import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createNoticeFlash } from "../../src/notice-flash.js";

describe("the notice a save's redirect carries (#173)", () => {
  it("hands back the sentence for the token it was stored under", () => {
    const flash = createNoticeFlash({ now: () => 0 });
    const token = flash.put("The mailbox was saved.");
    assert.match(token, /^[A-Za-z0-9_-]{22}$/);
    assert.equal(flash.get(token), "The mailbox was saved.");
  });

  it("still has it on a reload inside the lifetime, which is the point of the redirect", () => {
    const flash = createNoticeFlash({ now: () => 0 });
    const token = flash.put("saved");
    assert.equal(flash.get(token), "saved");
    assert.equal(flash.get(token), "saved");
  });

  it("forgets it once the lifetime has passed", () => {
    let clock = 0;
    const flash = createNoticeFlash({ now: () => clock, ttlMs: 1_000 });
    const token = flash.put("saved");
    clock = 1_000;
    assert.equal(flash.get(token), null);
  });

  it("knows nothing about a token it never issued, or a query that is not one", () => {
    const flash = createNoticeFlash({ now: () => 0 });
    assert.equal(flash.get("AAAAAAAAAAAAAAAAAAAAAA"), null);
    assert.equal(flash.get(undefined), null);
    assert.equal(flash.get(["a", "b"]), null);
  });

  it("keeps at most `max` notices, dropping the oldest", () => {
    const flash = createNoticeFlash({ now: () => 0, max: 2 });
    const first = flash.put("one");
    const second = flash.put("two");
    const third = flash.put("three");
    assert.equal(flash.get(first), null);
    assert.equal(flash.get(second), "two");
    assert.equal(flash.get(third), "three");
  });

  it("never hands out the same token twice", () => {
    const flash = createNoticeFlash({ now: () => 0 });
    assert.notEqual(flash.put("a"), flash.put("a"));
  });
});
