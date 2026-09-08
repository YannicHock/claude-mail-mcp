import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import type { Request, Response } from "express";

import {
  ASSERTION_HEADER,
  requireSettingsAssertion,
  verifyAssertion,
} from "../../src/settings-assertion.js";

const KEY_STRING = "k".repeat(32);
const KEY = new TextEncoder().encode(KEY_STRING);
const OTHER_KEY = new TextEncoder().encode("z".repeat(32));
const ISSUER = "https://mail-mcp.example.com";

/** Build a token the way the OAuth layer will, so the test does not depend on it. */
function mint(overrides: Record<string, unknown> = {}, key = KEY): string {
  const payload = {
    v: 1,
    iss: ISSUER,
    aud: "mail-mcp-settings",
    sub: "operator",
    sid: "session-1",
    csrf: "csrf-1",
    htm: "POST",
    htu: "/settings/mailboxes/work",
    exp: Math.floor(Date.now() / 1000) + 30,
    ...overrides,
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const mac = createHmac("sha256", key).update(encoded).digest("base64url");
  return `${encoded}.${mac}`;
}

test("a well-formed assertion verifies", () => {
  const result = verifyAssertion(mint(), KEY, ISSUER, "POST", "/settings/mailboxes/work");
  assert.deepEqual(result, { sub: "operator", sid: "session-1", csrf: "csrf-1" });
});

test("a different key is rejected", () => {
  const other = new TextEncoder().encode("z".repeat(32));
  const token = mint({}, other);
  assert.equal(verifyAssertion(token, KEY, ISSUER, "POST", "/settings/mailboxes/work"), null);
});

test("a tampered payload is rejected", () => {
  const [encoded, mac] = mint().split(".");
  const decoded = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  decoded.sub = "someone-else";
  const forged = Buffer.from(JSON.stringify(decoded), "utf8").toString("base64url");
  assert.equal(
    verifyAssertion(`${forged}.${mac}`, KEY, ISSUER, "POST", "/settings/mailboxes/work"),
    null
  );
});

test("an expired assertion is rejected", () => {
  const token = mint({ exp: Math.floor(Date.now() / 1000) - 1 });
  assert.equal(verifyAssertion(token, KEY, ISSUER, "POST", "/settings/mailboxes/work"), null);
});

test("a GET assertion cannot be replayed as a POST", () => {
  const token = mint({ htm: "GET" });
  assert.equal(verifyAssertion(token, KEY, ISSUER, "POST", "/settings/mailboxes/work"), null);
});

test("an assertion for another path is rejected", () => {
  const token = mint({ htu: "/settings/mailboxes/personal" });
  assert.equal(verifyAssertion(token, KEY, ISSUER, "POST", "/settings/mailboxes/work"), null);
});

test("a wrong issuer or audience is rejected", () => {
  assert.equal(
    verifyAssertion(mint({ iss: "https://evil.example" }), KEY, ISSUER, "POST", "/settings/mailboxes/work"),
    null
  );
  assert.equal(
    verifyAssertion(mint({ aud: "something-else" }), KEY, ISSUER, "POST", "/settings/mailboxes/work"),
    null
  );
});

test("malformed input returns null rather than throwing", () => {
  for (const bad of ["", ".", "a.b.c", "not-base64.$$$", "onlyonepart"]) {
    assert.equal(verifyAssertion(bad, KEY, ISSUER, "POST", "/x"), null);
  }
});

/**
 * Minimal stand-in for an Express Request. The guard only ever reads
 * `.header()`, `.method`, `.path` and `.ip` — so that is all this provides.
 */
function fakeRequest(
  headers: Record<string, string>,
  method = "POST",
  path = "/settings/mailboxes/work"
): Request {
  const lowered = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    method,
    path,
    ip: "127.0.0.1",
    header(name: string) {
      return lowered.get(name.toLowerCase());
    },
  } as unknown as Request;
}

/** Minimal stand-in for an Express Response, recording what the guard sent. */
function fakeResponse(): Response & { statusCode: number; body?: unknown } {
  const res = {
    locals: {},
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    type(_contentType: string) {
      return res;
    },
    send(body: unknown) {
      res.body = body;
      return res;
    },
  };
  return res as unknown as Response & { statusCode: number; body?: unknown };
}

test("the guard rejects a request with no assertion header", async () => {
  const guard = requireSettingsAssertion({ key: "k".repeat(32), issuer: ISSUER, log: () => {} });
  const res = fakeResponse();
  let called = false;
  await guard(fakeRequest({}), res, () => { called = true; });
  assert.equal(called, false);
  assert.equal(res.statusCode, 401);
});

test("the guard passes a good assertion and exposes its claims", async () => {
  const guard = requireSettingsAssertion({ key: KEY_STRING, issuer: ISSUER, log: () => {} });
  const res = fakeResponse();
  const req = fakeRequest({ [ASSERTION_HEADER]: mint() }, "POST", "/settings/mailboxes/work");
  let called = false;
  await guard(req, res, () => { called = true; });
  assert.equal(called, true);
  assert.deepEqual(res.locals.assertion, { sub: "operator", sid: "session-1", csrf: "csrf-1" });
});

test("the guard never says why it refused", async () => {
  const guard = requireSettingsAssertion({ key: KEY_STRING, issuer: ISSUER, log: () => {} });
  for (const header of [mint({ exp: 1 }), mint({}, OTHER_KEY), "garbage"]) {
    const res = fakeResponse();
    await guard(fakeRequest({ [ASSERTION_HEADER]: header }), res, () => {});
    assert.equal(res.statusCode, 401);
    assert.equal(res.body, "Unauthorized", "one message for every failure mode");
  }
});
