/**
 * Which `X-Forwarded-For` entry the connector believes (src/app.ts).
 *
 * `app.set("trust proxy", …)` decides what `req.ip` is, and `req.ip` is what
 * the two rejection log lines carry — `rejected unauthenticated MCP request`
 * in src/app.ts and `rejected settings request` in src/settings-assertion.ts.
 * The obvious use for those lines is a fail2ban jail, so the value has to be
 * an address a proxy observed rather than one the client typed.
 *
 * `trust proxy: true` — what this used to be — trusts the whole chain and takes
 * its leftmost entry. A reverse proxy only *appends* the address it saw, so the
 * leftmost entry is whatever the client sent, and the jail bans a name of the
 * attacker's choosing. The OAuth layer argues the same thing at length
 * (oauth/src/config.ts) and has done since it shipped; this suite is the
 * connector's copy of that guarantee, in the shape
 * oauth/test/unit/config.test.ts's `describe("trust proxy")` already uses.
 *
 * Driven through the real `createApp` chain over a real socket, because the
 * setting only has an effect on a served request: a test that read the Express
 * setting back would pass just as happily with a boolean in it. Offline like
 * every other unit test — the server binds 127.0.0.1:0, the accounts store
 * lives in a temp directory and nothing connects to a mailbox.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { LogLevel } from "../../src/app.js";
import { withRunningApp } from "../helpers/running-app.js";

/** The address the client wrote into the header itself. Never a valid answer. */
const FORGED = "198.51.100.9";
/** What the reverse proxy in front appended: the address it actually observed. */
const OBSERVED = "203.0.113.7";

/**
 * Send one unauthenticated `POST /mcp` carrying `<forged>, <observed>` — the
 * shape a single reverse proxy produces from a client that sent an
 * `X-Forwarded-For` of its own — and return the `ip` the rejection logged.
 */
async function rejectedRequestIp(trustProxy?: number): Promise<unknown> {
  const lines: { level: LogLevel; message: string; extra?: Record<string, unknown> }[] = [];

  return withRunningApp(
    {
      trustProxy,
      log: (level, message, extra) => lines.push({ level, message, extra }),
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Forwarded-For": `${FORGED}, ${OBSERVED}`,
        },
        body: "{}",
      });
      assert.equal(response.status, 401, "the request must be rejected for the log line to exist");

      const rejection = lines.find((l) => l.message === "rejected unauthenticated MCP request");
      assert.ok(rejection, "the rejection is logged");
      return rejection.extra?.ip;
    }
  );
}

describe("trust proxy", () => {
  it("logs the address the reverse proxy observed, not one the client picked", async () => {
    // With `trust proxy: true` this would be FORGED, and a jail reading the
    // line would ban whatever address the attacker named.
    assert.equal(await rejectedRequestIp(), OBSERVED);
  });

  it("skips exactly as many hops as it is told to", async () => {
    // Two trusted hops means the second entry from the right is the client —
    // correct only where a CDN really sits in front of the reverse proxy.
    assert.equal(await rejectedRequestIp(2), FORGED);
  });

  it("trusts no forwarded entry at all at zero hops", async () => {
    // Nothing proxies it: the socket address is the only truth available.
    assert.equal(await rejectedRequestIp(0), "127.0.0.1");
  });
});
