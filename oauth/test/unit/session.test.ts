import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CSRF_FIELD,
  SESSION_COOKIE,
  clearedSessionCookie,
  csrfMatches,
  newSession,
  readSessionCookie,
  sessionCookie,
  signSession,
  verifySession,
} from "../../src/session.js";

const KEY = new TextEncoder().encode("s".repeat(32));
const ISSUER = "https://mail-mcp.example.com";

test("a fresh session has unguessable, distinct identifiers", () => {
  const a = newSession("operator", 0);
  const b = newSession("operator", 0);
  assert.notEqual(a.sid, b.sid);
  assert.notEqual(a.csrf, b.csrf);
  assert.notEqual(a.sid, a.csrf, "the CSRF token is not the session id");
  assert.match(a.sid, /^[0-9a-f]{32}$/);
  assert.match(a.csrf, /^[0-9a-f]{32}$/);
});

test("a signed session round-trips", async () => {
  const claims = newSession("operator", 3);
  const token = await signSession(claims, KEY, ISSUER);
  assert.deepEqual(await verifySession(token, KEY, ISSUER, 3), claims);
});

test("a session from an older epoch is rejected", async () => {
  const token = await signSession(newSession("operator", 3), KEY, ISSUER);
  assert.equal(await verifySession(token, KEY, ISSUER, 4), null);
});

test("a session signed with another key or issuer is rejected", async () => {
  const token = await signSession(newSession("operator", 0), KEY, ISSUER);
  const other = new TextEncoder().encode("z".repeat(32));
  assert.equal(await verifySession(token, other, ISSUER, 0), null);
  assert.equal(await verifySession(token, KEY, "https://evil.example", 0), null);
});

test("garbage is rejected rather than thrown on", async () => {
  for (const bad of ["", "x", "a.b.c"]) {
    assert.equal(await verifySession(bad, KEY, ISSUER, 0), null);
  }
});

test("the cookie carries every attribute the design depends on", () => {
  const header = sessionCookie("TOKEN");
  assert.ok(header.startsWith(`${SESSION_COOKIE}=TOKEN;`));
  assert.match(header, /; HttpOnly/);
  assert.match(header, /; Secure/);
  assert.match(header, /; SameSite=Lax/);
  assert.match(header, /; Path=\//);
  assert.match(header, /; Max-Age=3600/);
  assert.ok(!/Domain=/.test(header), "__Host- forbids a Domain attribute");
});

test("clearing the cookie expires it in place", () => {
  const header = clearedSessionCookie();
  assert.ok(header.startsWith(`${SESSION_COOKIE}=;`));
  assert.match(header, /; Max-Age=0/);
  assert.match(header, /; Path=\//);
});

test("the cookie is found among others and absent means null", () => {
  assert.equal(readSessionCookie(`other=1; ${SESSION_COOKIE}=abc; third=2`), "abc");
  assert.equal(readSessionCookie(`${SESSION_COOKIE}=abc`), "abc");
  assert.equal(readSessionCookie("other=1"), null);
  assert.equal(readSessionCookie(undefined), null);
  assert.equal(readSessionCookie(`${SESSION_COOKIE}=`), null);
});

test("a cookie name that merely ends in the session name is not matched", () => {
  assert.equal(readSessionCookie(`not__Host-mailmcp_session=abc`), null);
});

test("CSRF comparison rejects everything but an exact string match", () => {
  const claims = newSession("operator", 0);
  assert.equal(csrfMatches(claims, claims.csrf), true);
  assert.equal(csrfMatches(claims, `${claims.csrf}x`), false);
  assert.equal(csrfMatches(claims, ""), false);
  assert.equal(csrfMatches(claims, undefined), false);
  assert.equal(csrfMatches(claims, ["a", "b"]), false);
  assert.equal(CSRF_FIELD, "_csrf");
});
