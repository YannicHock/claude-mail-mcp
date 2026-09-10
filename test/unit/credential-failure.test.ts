/**
 * Unit tests for shared/credential-failure.ts — the classifier itself, away
 * from any socket.
 *
 * `test/unit/probe.test.ts` proves the same distinction end to end against a
 * hand-rolled rejecting IMAP server, and `test/integration/probe.test.ts`
 * against a real GreenMail. Those two say "the probe classifies correctly".
 * This one says what the *rule* is, error shape by error shape, because #146
 * moved the rule out from under the probe and two more callers now depend on
 * it reading exactly the way it always did.
 *
 * The error shapes below are the ones imapflow actually produces; each is
 * documented at the field it exercises in shared/credential-failure.ts.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isCredentialRejection,
  classifyFailure,
  describeFailure,
  CREDENTIAL_REJECTION_MESSAGE,
  MAX_MESSAGE_LENGTH,
} from "../../shared/credential-failure.js";

/** A plain Error decorated the way imapflow decorates a failed command. */
function imapError(message: string, fields: Record<string, unknown>): Error {
  return Object.assign(new Error(message), fields);
}

test("a tagged NO out of the authentication step is a credential rejection", () => {
  // GreenMail's exact shape: Command failed, authenticationFailed, NO, and no
  // serverResponseCode at all.
  assert.equal(
    isCredentialRejection(
      imapError("Command failed", {
        authenticationFailed: true,
        responseStatus: "NO",
        responseText: "LOGIN failed. Invalid login/password for user id alice",
      })
    ),
    true
  );
});

test("a tagged BAD out of the authentication step is a credential rejection", () => {
  assert.equal(
    isCredentialRejection(
      imapError("Command failed", { authenticationFailed: true, responseStatus: "bad" })
    ),
    true
  );
});

test("RFC 5530's AUTHENTICATIONFAILED is a credential rejection on its own", () => {
  // Dovecot sends it; the classification must not rest solely on imapflow's
  // own bookkeeping.
  assert.equal(
    isCredentialRejection(
      imapError("Command failed", { serverResponseCode: "AUTHENTICATIONFAILED" })
    ),
    true
  );
});

test("imapflow's AuthenticationFailure class is a credential rejection", () => {
  // Recognised by name rather than by `instanceof`, so the assertion here is
  // constructed the same way: a subclass of Error called AuthenticationFailure
  // carrying imapflow's always-set `authenticationFailed: true`.
  class AuthenticationFailure extends Error {
    authenticationFailed = true as const;
  }
  assert.equal(isCredentialRejection(new AuthenticationFailure("Authentication failed")), true);
});

test("a connectivity failure is not a credential rejection", () => {
  // This is the distinction the whole classifier exists for. Each of these
  // must stay a connectivity failure.
  assert.equal(isCredentialRejection(imapError("connect ECONNREFUSED 127.0.0.1:1", { code: "ECONNREFUSED" })), false);
  assert.equal(isCredentialRejection(new Error("IMAP timed out after 10000ms")), false);
  assert.equal(isCredentialRejection(imapError("getaddrinfo ENOTFOUND imap.example.invalid", { code: "ENOTFOUND" })), false);
});

test("authenticationFailed alone is not enough", () => {
  // imapflow's LOGIN handler tags it onto *anything* thrown out of the
  // authentication step, a socket dying mid-command included.
  assert.equal(isCredentialRejection(imapError("Connection closed", { authenticationFailed: true })), false);
  assert.equal(
    isCredentialRejection(
      imapError("Connection closed", { authenticationFailed: true, responseStatus: "OK" })
    ),
    false
  );
});

test("a tagged NO alone is not enough", () => {
  // A tagged NO says the server refused a command, not that it refused these
  // credentials.
  assert.equal(isCredentialRejection(imapError("Command failed", { responseStatus: "NO" })), false);
});

test("a non-Error is never a credential rejection", () => {
  assert.equal(isCredentialRejection("Command failed"), false);
  assert.equal(isCredentialRejection(undefined), false);
  assert.equal(isCredentialRejection({ authenticationFailed: true, responseStatus: "NO" }), false);
});

test("classifyFailure reports the fixed message for a rejection", () => {
  const classified = classifyFailure(
    imapError("Command failed", { authenticationFailed: true, responseStatus: "NO" })
  );
  assert.equal(classified.credentialRejection, true);
  assert.equal(classified.reason, CREDENTIAL_REJECTION_MESSAGE);
});

test("classifyFailure keeps a connectivity failure describing itself", () => {
  const classified = classifyFailure(new Error("connect ECONNREFUSED 127.0.0.1:1"));
  assert.equal(classified.credentialRejection, false);
  assert.equal(classified.reason, "connect ECONNREFUSED 127.0.0.1:1");
  assert.notEqual(classified.reason, CREDENTIAL_REJECTION_MESSAGE);
});

test("describeFailure collapses whitespace and bounds the length", () => {
  assert.equal(describeFailure(new Error("  two\n  lines  ")), "two lines");
  const long = describeFailure(new Error("x".repeat(MAX_MESSAGE_LENGTH * 3)));
  assert.ok(long.length <= MAX_MESSAGE_LENGTH + 1, `bounded, got ${long.length}`);
  assert.ok(long.endsWith("…"));
});

test("describeFailure reads only err.message, never the error object", () => {
  // The object a probe or a tool catches may carry the credentials it is
  // complaining about on some other property. Only `message` is ever read.
  const err = Object.assign(new Error("Command failed"), {
    auth: { user: "alice@example.com", pass: "hunter2-very-secret" },
  });
  const described = describeFailure(err);
  assert.equal(described, "Command failed");
  assert.ok(!described.includes("hunter2"));
});
