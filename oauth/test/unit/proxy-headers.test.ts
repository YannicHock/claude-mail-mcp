/**
 * Unit coverage for the header-handling rules createProxy follows, isolated from
 * the rest of the app: a bare HTTP server wraps the proxy function directly, with
 * just enough of the Express Request/Response surface patched on to satisfy what
 * proxy.ts actually calls (`res.status`; everything else — `setHeader`,
 * `flushHeaders`, `on`, and `req.pipe` — is already there on the native objects).
 */

import { strict as assert } from "node:assert";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import type { Request, Response } from "express";

import { silentLogger } from "../../src/logger.js";
import { createProxy, type ProxyOptions } from "../../src/proxy.js";

interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
}

interface UpstreamStub {
  url: string;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

async function startUpstream(): Promise<UpstreamStub> {
  const requests: RecordedRequest[] = [];
  const server = createServer((req, res) => {
    requests.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Wrap createProxy's returned handler in a plain HTTP server so it can be hit with real fetch calls. */
function startProxy(opts: ProxyOptions): { url: Promise<string>; close: () => Promise<void> } {
  const proxy = createProxy(opts);
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // The only Express-specific method proxy.ts calls on `res` is `.status()`;
    // everything else it uses (`setHeader`, `flushHeaders`, `on`) already exists
    // on a native http.ServerResponse.
    const expressRes = res as unknown as Response;
    (expressRes as unknown as { status: (code: number) => Response }).status = (
      code: number
    ): Response => {
      res.statusCode = code;
      return expressRes;
    };
    try {
      proxy(req as unknown as Request, expressRes);
    } catch (err) {
      // A synchronous throw here would otherwise leave the client's fetch()
      // waiting on a response that never arrives, hanging the test rather than
      // failing it.
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end(String(err));
      }
    }
  });
  const url = new Promise<string>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
  return {
    url,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe("proxy header handling", () => {
  let upstream: UpstreamStub;

  before(async () => {
    upstream = await startUpstream();
  });

  after(async () => {
    await upstream.close();
  });

  it("strips the Cookie header before forwarding", async () => {
    const proxy = startProxy({
      upstreamUrl: upstream.url,
      upstreamAuthToken: "static-token",
      log: silentLogger,
    });
    try {
      const proxyUrl = await proxy.url;
      const before = upstream.requests.length;
      const response = await fetch(proxyUrl, {
        headers: { cookie: "__Host-mailmcp_session=secret" },
      });
      assert.equal(response.status, 200);
      const forwarded = upstream.requests[before];
      assert.ok(forwarded, "the request reached the upstream");
      assert.equal(forwarded.headers.cookie, undefined);
    } finally {
      await proxy.close();
    }
  });

  it("still substitutes the static upstream token when extraHeaders is used", async () => {
    const proxy = startProxy({
      upstreamUrl: upstream.url,
      upstreamAuthToken: "static-token",
      extraHeaders: () => ({ "x-settings-assertion": "assertion-value" }),
      log: silentLogger,
    });
    try {
      const proxyUrl = await proxy.url;
      const before = upstream.requests.length;
      const response = await fetch(proxyUrl, {
        headers: { authorization: "Bearer client-supplied" },
      });
      assert.equal(response.status, 200);
      const forwarded = upstream.requests[before];
      assert.ok(forwarded, "the request reached the upstream");
      assert.equal(forwarded.headers.authorization, "Bearer static-token");
      assert.equal(forwarded.headers["x-settings-assertion"], "assertion-value");
    } finally {
      await proxy.close();
    }
  });

  it("resolves a function upstreamPath per request rather than once at construction", async () => {
    const proxy = startProxy({
      upstreamUrl: upstream.url,
      upstreamAuthToken: "static-token",
      upstreamPath: (req) => `/settings/mailboxes${req.url === "/" ? "" : req.url}`,
      log: silentLogger,
    });
    try {
      const proxyUrl = await proxy.url;

      const beforeFirst = upstream.requests.length;
      const firstResponse = await fetch(`${proxyUrl}/foo`);
      assert.equal(firstResponse.status, 200);
      const first = upstream.requests[beforeFirst];
      assert.ok(first, "the first request reached the upstream");
      assert.equal(first.url, "/settings/mailboxes/foo");

      const beforeSecond = upstream.requests.length;
      const secondResponse = await fetch(`${proxyUrl}/bar`);
      assert.equal(secondResponse.status, 200);
      const second = upstream.requests[beforeSecond];
      assert.ok(second, "the second request reached the upstream");
      assert.equal(second.url, "/settings/mailboxes/bar");
    } finally {
      await proxy.close();
    }
  });

  it("still forwards a plain string upstreamPath, unchanged from before", async () => {
    const proxy = startProxy({
      upstreamUrl: upstream.url,
      upstreamAuthToken: "static-token",
      upstreamPath: "/mcp",
      log: silentLogger,
    });
    try {
      const proxyUrl = await proxy.url;
      const before = upstream.requests.length;
      const response = await fetch(proxyUrl);
      assert.equal(response.status, 200);
      const forwarded = upstream.requests[before];
      assert.ok(forwarded, "the request reached the upstream");
      assert.equal(forwarded.url, "/mcp");
    } finally {
      await proxy.close();
    }
  });
});
