/**
 * Where each body limit applies (src/app.ts) — #137.
 *
 * `express.json({ limit: "5mb" })` used to be mounted app-wide, ahead of
 * everything. body-parser marks a parsed request with `req._body` and every
 * later `json()` short-circuits on it, so the settings router's own 64 KB
 * `jsonBody` never ran and the JSON branch of a settings route accepted eighty
 * times what the form branch of the same route did. The parser is now scoped to
 * the one route that needs that size.
 *
 * The settings side of the fix is asserted end-to-end in
 * test/integration/settings-mailboxes.test.ts (the oversized-JSON case and its
 * parity with the oversized-form case). This file guards the other direction:
 * that scoping the parser did not quietly shrink what `/mcp` accepts. A
 * `send_message` with an attachment is a genuinely large JSON-RPC body, and it
 * is the only thing here that posts one.
 *
 * Offline like every other unit test — the server binds 127.0.0.1:0, the
 * accounts store lives in a temp directory and nothing connects to a mailbox.
 */

import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { describe, it } from "node:test";

import { createApp } from "../../src/app.js";
import { ClientPool } from "../../src/client-pool.js";
import { makeAccount, withAccountsStore } from "../helpers/fixtures.js";

const AUTH_TOKEN = "body-limit-unit-test-token";

/** Post `body` to `/mcp` with a valid Bearer token and report what came back. */
async function postToMcp(body: string): Promise<{ status: number; text: string }> {
  return withAccountsStore([makeAccount({ id: "work", label: "Work", default: true })], async (store, dir) => {
    const pool = new ClientPool(store);
    const app = createApp({
      store,
      pool,
      authToken: AUTH_TOKEN,
      accountsFile: path.join(dir, "accounts.json"),
      publicUrl: "http://localhost.invalid",
    });

    const server = await new Promise<Server>((resolve, reject) => {
      const s: Server = app.listen(0, "127.0.0.1", () => resolve(s));
      s.on("error", reject);
    });
    try {
      const { port } = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${AUTH_TOKEN}`,
        },
        body,
      });
      return { status: response.status, text: await response.text() };
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await pool.closeAll().catch(() => {});
    }
  });
}

describe("body limits", () => {
  it("still parses a megabyte-scale JSON-RPC body on /mcp", async () => {
    // A `send_message` carrying an attachment looks like this. Well over the
    // settings routes' 64 KB and well under /mcp's 5 MB, so it must reach the
    // MCP transport rather than the app-wide malformed-body handler.
    const request = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "ping",
      params: { _padding: "a".repeat(1024 * 1024) },
    });
    assert.ok(request.length > 1024 * 1024, "the fixture really is over a megabyte");

    const { status, text } = await postToMcp(request);
    assert.notEqual(status, 413, `the body was refused as too large: ${text}`);
    assert.ok(
      !text.includes("malformed or oversized body"),
      `the body never reached the MCP handler: ${text}`
    );
  });
});
