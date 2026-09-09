/**
 * The route table of an unclaimed instance, against the real middleware chain.
 *
 * This is the file that would go red if the gate were ever mounted after a route
 * instead of before it, which is the failure mode that matters: a service that
 * still answers `/register` or `/authorize` while nobody has claimed it is an
 * unauthenticated form on the public internet in front of a mail connector.
 */

import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { startHarness, type Harness } from "../helpers/harness.js";

const VALID_HASH =
  "scrypt$1024$8$1$c2FsdHNhbHRzYWx0c2E$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhcw";

function dataDir(): string {
  return mkdtempSync(join(tmpdir(), "oauth-gate-"));
}

/** Write the operator record the way the wizard's last step will. */
function writeOperatorRecord(dir: string): void {
  writeFileSync(
    join(dir, "operator.json"),
    JSON.stringify({ version: 1, username: "operator", passwordHash: VALID_HASH, sessionEpoch: 0 })
  );
}

async function get(harness: Harness, path: string): Promise<Response> {
  return fetch(`${harness.baseUrl}${path}`, { redirect: "manual" });
}

test("an unclaimed instance answers /health as usual", async () => {
  const harness = await startHarness({ unbootstrapped: true });
  try {
    const res = await get(harness, "/health");
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { status: string }).status, "ok");
  } finally {
    await harness.close();
  }
});

test("an unclaimed instance serves the setup page to the claim token", async () => {
  const harness = await startHarness({ unbootstrapped: true });
  try {
    assert.ok(harness.setupUrl, "the harness started unbootstrapped");
    assert.ok(harness.setupUrl.startsWith(`${harness.baseUrl}/setup/`));

    const res = await fetch(harness.setupUrl, { redirect: "manual" });

    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(res.headers.get("x-frame-options"), "DENY");
    assert.match(await res.text(), /not been claimed yet/);
  } finally {
    await harness.close();
  }
});

test("an unclaimed instance answers 503 at /mcp, not 401", async () => {
  // 401 would invite credential guessing against a service that has no
  // credentials to check against yet.
  const harness = await startHarness({ unbootstrapped: true });
  try {
    for (const method of ["GET", "POST"]) {
      const res = await fetch(`${harness.baseUrl}/mcp`, { method, redirect: "manual" });
      assert.equal(res.status, 503, method);
      assert.equal(res.headers.get("www-authenticate"), null, "nothing to authenticate to");
      assert.equal(((await res.json()) as { error: string }).error, "not_configured");
    }
    assert.deepEqual(harness.upstream.requests, [], "nothing reached the connector");
  } finally {
    await harness.close();
  }
});

test("an unclaimed instance 404s every other path, mounted or not", async () => {
  const harness = await startHarness({ unbootstrapped: true });
  try {
    for (const path of [
      "/",
      "/settings",
      "/settings/mailboxes",
      "/authorize?client_id=x",
      "/.well-known/oauth-authorization-server",
      "/.well-known/oauth-protected-resource/mcp",
      "/mcp/extra",
      "/setup",
      "/setup/",
    ]) {
      assert.equal((await get(harness, path)).status, 404, path);
    }
    for (const path of ["/register", "/token"]) {
      const res = await fetch(`${harness.baseUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      assert.equal(res.status, 404, path);
    }
  } finally {
    await harness.close();
  }
});

test("a wrong claim token is indistinguishable from a claimed instance", async () => {
  // Status, headers and body all have to match, or the difference is the oracle
  // that tells a scanner this instance is still claimable.
  const unclaimed = await startHarness({ unbootstrapped: true });
  const claimed = await startHarness();
  try {
    const path = "/setup/definitely-not-the-token";
    const wrong = await get(unclaimed, path);
    const closed = await get(claimed, path);

    assert.equal(wrong.status, 404);
    assert.equal(closed.status, 404);
    assert.equal(wrong.headers.get("content-type"), closed.headers.get("content-type"));
    assert.equal(wrong.headers.get("www-authenticate"), null);
    assert.deepEqual(await wrong.json(), await closed.json());
  } finally {
    await unclaimed.close();
    await claimed.close();
  }
});

test("a token that is a prefix or an extension of the real one is refused", async () => {
  const harness = await startHarness({ unbootstrapped: true });
  try {
    const token = harness.claimToken ?? "";
    assert.notEqual(token, "");
    for (const candidate of [token.slice(0, -1), `${token}x`, token.toUpperCase()]) {
      assert.equal((await get(harness, `/setup/${candidate}`)).status, 404, candidate);
    }
    assert.equal((await get(harness, `/setup/${token}`)).status, 200, "the real one still works");
  } finally {
    await harness.close();
  }
});

test("a sub-path under a valid token is a 404 until the wizard lands", async () => {
  const harness = await startHarness({ unbootstrapped: true });
  try {
    assert.equal((await get(harness, `/setup/${harness.claimToken}/mailbox`)).status, 404);
    const posted = await fetch(`${harness.baseUrl}/setup/${harness.claimToken}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "",
    });
    assert.equal(posted.status, 404, "the placeholder has no form to submit");
  } finally {
    await harness.close();
  }
});

test("the setup link survives a restart mid-wizard", async () => {
  // Same data directory, second process. The tab the operator left open on step
  // 2 has to keep working.
  const dir = dataDir();
  const first = await startHarness({ unbootstrapped: true, dataDir: dir });
  const token = first.claimToken;
  await first.close();

  const second = await startHarness({ unbootstrapped: true, dataDir: dir });
  try {
    assert.equal(second.claimToken, token);
    assert.equal((await get(second, `/setup/${token}`)).status, 200);
  } finally {
    await second.close();
  }
});

test("completing setup closes /setup permanently and opens /mcp", async () => {
  const dir = dataDir();
  const harness = await startHarness({ unbootstrapped: true, dataDir: dir });
  try {
    const token = harness.claimToken ?? "";
    assert.equal((await get(harness, `/setup/${token}`)).status, 200);
    assert.equal((await fetch(`${harness.baseUrl}/mcp`, { method: "POST" })).status, 503);

    // What the wizard's last step does, in the order the design fixes: record
    // first, token second.
    writeOperatorRecord(dir);
    await harness.bootstrap.complete();

    assert.equal((await get(harness, `/setup/${token}`)).status, 404);
    assert.equal(existsSync(join(dir, "claim-token.txt")), false);

    // /mcp is a live endpoint again: 401 with a challenge, which is what an
    // unauthenticated MCP request is supposed to get.
    const mcp = await fetch(`${harness.baseUrl}/mcp`, { method: "POST" });
    assert.equal(mcp.status, 401);
    assert.match(mcp.headers.get("www-authenticate") ?? "", /Bearer/);

    // And so is the rest of the surface.
    assert.equal((await get(harness, "/.well-known/oauth-authorization-server")).status, 200);
  } finally {
    await harness.close();
  }
});

test("a claimed instance never mints a claim token", async () => {
  const dir = dataDir();
  writeOperatorRecord(dir);
  const harness = await startHarness({ unbootstrapped: true, dataDir: dir });
  try {
    assert.equal(harness.bootstrap.bootstrapped, true);
    assert.equal(harness.setupUrl, null);
    assert.equal(existsSync(join(dir, "claim-token.txt")), false);
    assert.equal((await get(harness, "/setup/anything")).status, 404);
  } finally {
    await harness.close();
  }
});

test("the token on disk is the one the setup URL carries", async () => {
  const dir = dataDir();
  const harness = await startHarness({ unbootstrapped: true, dataDir: dir });
  try {
    const onDisk = readFileSync(join(dir, "claim-token.txt"), "utf8").trim();
    assert.equal(harness.setupUrl, `${harness.baseUrl}/setup/${onDisk}`);
  } finally {
    await harness.close();
  }
});

test("a claimed instance is unchanged: no gate, no 503, no setup route", async () => {
  const harness = await startHarness();
  try {
    assert.equal((await get(harness, "/health")).status, 200);
    assert.equal((await get(harness, "/.well-known/oauth-authorization-server")).status, 200);
    assert.equal((await fetch(`${harness.baseUrl}/mcp`, { method: "POST" })).status, 401);
    assert.equal((await get(harness, "/setup/whatever")).status, 404);
  } finally {
    await harness.close();
  }
});
