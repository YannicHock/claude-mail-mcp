/**
 * Unit tests for src/timeout.ts — the one deadline helper `probe.ts` and
 * `autoconfig.ts` now share, and for the four timeout budgets that use it.
 *
 * The helper tests pin the two rejection messages, because the shared version
 * has to keep producing both: the labelled one `probe.ts` reports per probe,
 * and the bare one `autoconfig.ts` swallows. They also pin that `onTimeout`
 * runs *before* the rejection, which is the whole reason `probe.ts` can tie a
 * socket teardown to it.
 *
 * The budget tests exist because this file's own refactor renamed those
 * constants, and a rename is only safe if it demonstrably moved no numbers.
 * The two per-attempt budgets are still pinned here against literals: if one of
 * those ever needs to change, that is a decision, and it should have to be made
 * twice.
 *
 * The two *total* budgets are no longer pinned against literals here, and that
 * is #134. They moved to `shared/settings-api.ts`, where the setup wizard can
 * see them too, and each of these modules now takes one as its default. A
 * literal here would have been a third place the number is written and a new
 * way for it to drift, so what is asserted instead is the identity — this
 * module's default *is* the shared budget — and the literal itself is pinned
 * once, in test/unit/settings-api.test.ts.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { withTimeout } from "../../src/timeout.js";
import { PER_PROBE_TIMEOUT_MS, TOTAL_TIMEOUT_MS } from "../../src/probe.js";
import {
  AUTOCONFIG_PER_ATTEMPT_TIMEOUT_MS,
  AUTOCONFIG_TOTAL_TIMEOUT_MS,
} from "../../src/autoconfig.js";
import {
  CONNECTOR_AUTOCONFIG_BUDGET_MS,
  CONNECTOR_PROBE_BUDGET_MS,
} from "../../shared/settings-api.js";

/** A promise that never settles — the only thing a deadline can be shown against. */
function never(): Promise<never> {
  return new Promise<never>(() => {});
}

test("a promise that wins the race returns its value", async () => {
  assert.equal(await withTimeout(Promise.resolve("done"), 1_000, "label"), "done");
});

test("a promise that rejects first rejects with its own error, not the timeout", async () => {
  await assert.rejects(
    withTimeout(Promise.reject(new Error("refused")), 1_000, "IMAP"),
    /^Error: refused$/
  );
});

test("with a label, the timeout names which caller timed out", async () => {
  await assert.rejects(withTimeout(never(), 5, "IMAP"), /^Error: IMAP timed out after 5ms$/);
});

test("without a label, the timeout message is the bare one autoconfig has always thrown", async () => {
  await assert.rejects(withTimeout(never(), 5), /^Error: timed out after 5ms$/);
});

test("onTimeout runs before the rejection, so a caller can tear its socket down", async () => {
  const order: string[] = [];
  await assert.rejects(
    withTimeout(never(), 5, "CalDAV", () => order.push("onTimeout")).catch((err: unknown) => {
      order.push("rejected");
      throw err;
    }),
    /timed out after 5ms$/
  );
  assert.deepEqual(order, ["onTimeout", "rejected"]);
});

test("onTimeout is optional and a resolved race never fires it", async () => {
  let fired = false;
  assert.equal(
    await withTimeout(Promise.resolve(1), 1_000, "label", () => {
      fired = true;
    }),
    1
  );
  assert.equal(fired, false);
});

/**
 * The timer is cleared in a `finally`, so a fast win leaves nothing behind.
 * Asserted by handle count rather than by inspection: an uncleared 60s timer
 * would still be referenced here.
 */
test("a fast win leaves no timer behind", async () => {
  const before = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
  await withTimeout(Promise.resolve("fast"), 60_000, "label");
  const after = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
  assert.equal(after, before);
});

test("the per-attempt budgets are the values they have always been", () => {
  assert.equal(PER_PROBE_TIMEOUT_MS, 10_000);
  assert.equal(AUTOCONFIG_PER_ATTEMPT_TIMEOUT_MS, 3_000);
});

/**
 * The half of #134 that lives on this side of the hop.
 *
 * The wizard derives its own two timeouts from these same constants by adding
 * slack, so the invariant "the wizard waits longer than the connector" holds by
 * arithmetic — but only as long as the connector really does run to the shared
 * number. A local literal that drifted from it would put the wizard's slack on
 * the wrong side of the connector's actual deadline with nothing to say so.
 */
test("the connector's total budgets are the shared ones, not copies of them", () => {
  assert.equal(TOTAL_TIMEOUT_MS, CONNECTOR_PROBE_BUDGET_MS);
  assert.equal(AUTOCONFIG_TOTAL_TIMEOUT_MS, CONNECTOR_AUTOCONFIG_BUDGET_MS);
});

test("a per-attempt budget still fits inside the total it runs under", () => {
  assert.ok(PER_PROBE_TIMEOUT_MS <= TOTAL_TIMEOUT_MS);
  assert.ok(AUTOCONFIG_PER_ATTEMPT_TIMEOUT_MS <= AUTOCONFIG_TOTAL_TIMEOUT_MS);
});

/**
 * The point of the rename: both budgets can now be imported into one module
 * and read side by side. The wizard's autoconfig tier (#70) is the module that
 * will do exactly this — look settings up, then probe them — and this file is
 * the proof it will not have to alias anything to do so.
 */
test("the two total budgets can be imported together and are distinct", () => {
  assert.notEqual(TOTAL_TIMEOUT_MS, AUTOCONFIG_TOTAL_TIMEOUT_MS);
});
