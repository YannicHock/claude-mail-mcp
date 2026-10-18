/**
 * The app-wide error handler (src/app.ts) — #219.
 *
 * It was written for body-parser errors and answered everything it caught as a
 * malformed body: a route that threw because accounts.json could not be written
 * (ENOSPC, EACCES, EPERM) reached the operator as "your request was malformed"
 * and the log as a client error. The handler is mounted here on a bare Express
 * app with one route that throws and one that parses JSON, so each branch is
 * reached by the thing that really reaches it in production.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import express from "express";

import { requestErrorHandler, type LogLevel } from "../../src/app.js";
import { withServer } from "../helpers/running-app.js";

interface LogLine {
  level: LogLevel;
  message: string;
  extra?: Record<string, unknown>;
}

/** A bare app with the real handler behind a throwing route and a JSON route. */
function appWithHandler(lines: LogLine[]): express.Express {
  const app = express();
  app.post("/write", () => {
    // What writeFile/rename reject with: a plain Error with an errno code and no
    // HTTP status of any kind.
    throw Object.assign(new Error("ENOSPC: no space left on device, write"), {
      code: "ENOSPC",
    });
  });
  app.post("/parse", express.json({ limit: "1kb" }), (_req, res) => {
    res.json({ ok: true });
  });
  app.use(
    requestErrorHandler((level, message, extra) => {
      lines.push({ level, message, extra });
    })
  );
  return app;
}

describe("requestErrorHandler", () => {
  it("answers a route's own failure with a 500 and logs it as a server error", async () => {
    const lines: LogLine[] = [];
    await withServer(appWithHandler(lines), async (baseUrl) => {
      const res = await fetch(`${baseUrl}/write`, { method: "POST" });
      assert.equal(res.status, 500);
      const body = await res.json();
      assert.equal(body.error, "internal_error");
      assert.ok(!JSON.stringify(body).includes("ENOSPC"), "the errno detail stays in the log");
    });
    assert.equal(lines.length, 1);
    assert.equal(lines[0].level, "error");
    assert.ok(!lines[0].message.includes("malformed"), lines[0].message);
    assert.equal(lines[0].extra?.path, "/write");
    assert.equal(lines[0].extra?.code, "ENOSPC");
  });

  it("still answers a body the parser refused with the parser's own 4xx", async () => {
    const lines: LogLine[] = [];
    await withServer(appWithHandler(lines), async (baseUrl) => {
      const malformed = await fetch(`${baseUrl}/parse`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json",
      });
      assert.equal(malformed.status, 400);
      assert.equal((await malformed.json()).error, "bad_request");

      const oversized = await fetch(`${baseUrl}/parse`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ padding: "a".repeat(4096) }),
      });
      assert.equal(oversized.status, 413);
      assert.equal((await oversized.json()).error, "bad_request");
    });
    assert.deepEqual(
      lines.map((line) => [line.level, line.message]),
      [
        ["warn", "rejected malformed request body"],
        ["warn", "rejected malformed request body"],
      ]
    );
  });
});
