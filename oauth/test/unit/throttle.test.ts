import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { LoginThrottle, MAX_FAILURES, WINDOW_SECONDS } from "../../src/throttle.js";

describe("LoginThrottle", () => {
  it("allows attempts up to the limit", () => {
    const throttle = new LoginThrottle(3, 900);
    for (let i = 0; i < 3; i += 1) {
      assert.equal(throttle.isBlocked("1.2.3.4"), false);
      throttle.recordFailure("1.2.3.4");
    }
    assert.equal(throttle.isBlocked("1.2.3.4"), true);
  });

  it("counts per IP, so one attacker does not lock out the operator", () => {
    const throttle = new LoginThrottle(2, 900);
    throttle.recordFailure("1.2.3.4");
    throttle.recordFailure("1.2.3.4");
    assert.equal(throttle.isBlocked("1.2.3.4"), true);
    assert.equal(throttle.isBlocked("5.6.7.8"), false);
  });

  it("clears the counter after a successful sign-in", () => {
    const throttle = new LoginThrottle(3, 900);
    throttle.recordFailure("1.2.3.4");
    throttle.recordFailure("1.2.3.4");
    throttle.recordSuccess("1.2.3.4");
    assert.equal(throttle.isBlocked("1.2.3.4"), false);
    assert.equal(throttle.size, 0);
  });

  it("lets failures age out of the window", () => {
    const throttle = new LoginThrottle(2, 900);
    const start = 1_000_000;
    throttle.recordFailure("1.2.3.4", start);
    throttle.recordFailure("1.2.3.4", start);
    assert.equal(throttle.isBlocked("1.2.3.4", start), true);
    assert.equal(throttle.isBlocked("1.2.3.4", start + 901_000), false);
  });

  it("slides the window rather than resetting it wholesale", () => {
    const throttle = new LoginThrottle(3, 900);
    const start = 1_000_000;
    throttle.recordFailure("1.2.3.4", start);
    throttle.recordFailure("1.2.3.4", start + 400_000);
    throttle.recordFailure("1.2.3.4", start + 800_000);
    assert.equal(throttle.isBlocked("1.2.3.4", start + 800_000), true);

    // The oldest has aged out; the two newer ones have not.
    assert.equal(throttle.isBlocked("1.2.3.4", start + 901_000), false);
  });

  it("reports how long the lockout still has to run", () => {
    const throttle = new LoginThrottle(2, 900);
    const start = 1_000_000;
    throttle.recordFailure("1.2.3.4", start);
    throttle.recordFailure("1.2.3.4", start);
    const retryAfter = throttle.retryAfter("1.2.3.4", start + 300_000);
    assert.ok(retryAfter > 0 && retryAfter <= 900, `unexpected retryAfter ${retryAfter}`);
    assert.equal(retryAfter, 600);
  });

  it("reports no wait for an IP that is not blocked", () => {
    const throttle = new LoginThrottle(3, 900);
    assert.equal(throttle.retryAfter("1.2.3.4"), 0);
    throttle.recordFailure("1.2.3.4");
    assert.equal(throttle.retryAfter("1.2.3.4"), 0);
  });

  it("reports the number of failures now in the window", () => {
    const throttle = new LoginThrottle(5, 900);
    assert.equal(throttle.recordFailure("1.2.3.4"), 1);
    assert.equal(throttle.recordFailure("1.2.3.4"), 2);
  });

  it("forgets IPs whose failures have all aged out", () => {
    const throttle = new LoginThrottle(3, 900);
    const start = 1_000_000;
    throttle.recordFailure("1.2.3.4", start);
    assert.equal(throttle.size, 1);
    throttle.sweep(start + 901_000);
    assert.equal(throttle.size, 0);
  });

  it("ships with the documented defaults", () => {
    assert.equal(MAX_FAILURES, 5);
    assert.equal(WINDOW_SECONDS, 15 * 60);
    const throttle = new LoginThrottle();
    for (let i = 0; i < MAX_FAILURES; i += 1) throttle.recordFailure("1.2.3.4");
    assert.equal(throttle.isBlocked("1.2.3.4"), true);
  });
});
