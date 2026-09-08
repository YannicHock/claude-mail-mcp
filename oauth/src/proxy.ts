/**
 * The authenticated MCP proxy.
 *
 * This is the only place the connector's static token is used, and the rules it
 * follows are the reason this service exists:
 *
 * 1. The client's `Authorization` header is *replaced*, never forwarded. What
 *    arrives is one of this service's own access tokens; what leaves is the
 *    connector's `AUTH_TOKEN`. Neither is ever passed through to the other side.
 * 2. Nothing is buffered. The request body is piped as it arrives and the
 *    response is piped back with headers flushed immediately, so a streamed
 *    `text/event-stream` response reaches the client as it is produced rather
 *    than at the end.
 * 3. Hop-by-hop headers are dropped in both directions (RFC 9110 section 7.6.1),
 *    and the upstream's own `WWW-Authenticate` is suppressed — the connector
 *    speaks static-token auth, and letting its challenge reach an OAuth client
 *    would send Claude off to re-run a flow that cannot fix anything.
 *
 * No body parser is mounted on this route. Parsing the JSON-RPC payload here
 * would consume the stream and force a re-serialisation, and this service has no
 * reason to look inside the message at all.
 */

import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Request, Response } from "express";

import type { Logger } from "./logger.js";

/**
 * Headers that must not be forwarded in either direction. `connection`,
 * `keep-alive`, `transfer-encoding` and friends describe a single hop; copying
 * them onto the next one produces framing bugs that surface as truncated
 * responses under load.
 */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

export interface ProxyOptions {
  upstreamUrl: string;
  upstreamAuthToken: string;
  /**
   * Path the connector serves MCP on, which is always `/mcp` — it is a fixed
   * route in `src/app.ts` upstream, not a configurable one. Deliberately separate
   * from this service's own public `MCP_PATH`: the two are equal by default, but
   * changing where this service is reachable must not silently change where it
   * forwards to.
   */
  upstreamPath?: string;
  log: Logger;
  /** Milliseconds before an idle upstream connection is abandoned. */
  timeoutMs?: number;
}

/**
 * Default upstream timeout.
 *
 * Generous on purpose: a `tools/call` behind this can be a real IMAP fetch over a
 * slow link. It only needs to be shorter than the client's own patience, and it
 * exists to stop sockets accumulating, not to enforce a latency budget.
 */
const DEFAULT_TIMEOUT_MS = 120_000;

export function createProxy(opts: ProxyOptions) {
  const target = new URL(opts.upstreamUrl);
  const isHttps = target.protocol === "https:";
  const requestFn = isHttps ? httpsRequest : httpRequest;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const upstreamPath = opts.upstreamPath ?? "/mcp";

  return function proxyToUpstream(req: Request, res: Response): void {
    const headers = forwardableRequestHeaders(req.headers);

    // The substitution. The client's credential is discarded here; it has already
    // been verified by the time this runs, and it means nothing upstream.
    headers.authorization = `Bearer ${opts.upstreamAuthToken}`;
    headers.host = target.host;

    const upstream = requestFn(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (isHttps ? 443 : 80),
        method: req.method,
        path: joinPath(target.pathname, upstreamPath),
        headers,
      },
      (upstreamRes: IncomingMessage) => {
        res.status(upstreamRes.statusCode ?? 502);
        for (const [name, value] of Object.entries(upstreamRes.headers)) {
          if (value === undefined) continue;
          if (HOP_BY_HOP.has(name.toLowerCase())) continue;
          // The connector challenges with its own static-token scheme. Passing
          // that to an OAuth client would start a flow that cannot succeed; this
          // service issues its own 401 before ever reaching the upstream.
          if (name.toLowerCase() === "www-authenticate") continue;
          res.setHeader(name, value);
        }
        // Flush the head before any body arrives, so a streaming response starts
        // reaching the client immediately instead of at the first chunk boundary.
        res.flushHeaders();
        upstreamRes.pipe(res);
      }
    );

    upstream.setTimeout(timeoutMs, () => {
      opts.log("warn", "upstream timed out", { timeout_ms: timeoutMs });
      upstream.destroy(new Error("upstream timeout"));
    });

    upstream.on("error", (err: Error) => {
      opts.log("error", "upstream request failed", { error: err.message });
      if (!res.headersSent) {
        res.status(502).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Upstream MCP server unreachable" },
          id: null,
        });
      } else {
        res.destroy();
      }
    });

    // If the client hangs up mid-request, stop work upstream rather than leaving
    // a socket to complete into a response nobody will read.
    res.on("close", () => {
      if (!upstream.destroyed) upstream.destroy();
    });

    req.pipe(upstream);
  };
}

function forwardableRequestHeaders(
  source: Request["headers"]
): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    if (lower === "authorization") continue; // replaced below, never forwarded
    headers[lower] = value;
  }
  return headers;
}

/**
 * Join any path prefix carried by UPSTREAM_MCP_URL with the connector's MCP
 * route, so `http://mail-mcp:3220/base` forwards to `/base/mcp`.
 */
function joinPath(basePath: string, upstreamPath: string): string {
  const base = basePath === "/" ? "" : basePath.replace(/\/+$/, "");
  const suffix = upstreamPath.startsWith("/") ? upstreamPath : `/${upstreamPath}`;
  return `${base}${suffix}`;
}
