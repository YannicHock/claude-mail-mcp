# Settings Web UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `claude-mail-mcp` a browser UI so mailboxes can be added, tested, edited and removed, connected Claude clients reviewed and revoked, and the operator password changed — without a shell on the server.

**Architecture:** The UI is split along data ownership. The OAuth layer owns the operator session, the connected-client list and the operator password; the connector owns mailbox CRUD and the connection test, because it already holds `accounts.json` and the mail libraries. `/settings/mailboxes*` is proxied from the OAuth layer to the connector the same way `/mcp` already is, with the browser's `Cookie` stripped and a short-lived HMAC assertion added. The count of processes able to read plaintext mailbox passwords stays at one.

**Tech Stack:** TypeScript, Express 5, `jose` (OAuth layer only), `node:crypto`, `node:test` + `tsx`. Server-rendered HTML with inline CSS. No frontend framework, no build step, no JavaScript served to the browser.

**Spec:** `docs/planning/specs/2026-09-08-settings-ui.md` — read it before Task 1 and keep it open. Every task below cites the section it implements.

## Global Constraints

Every task's requirements implicitly include this section.

- **Node floor `>=24.0.0`.** CI runs Node 24, matching `node:24-alpine`. Anything reported green must be verified in a Node 24 container, not only on the dev machine. The command is in "Verifying on Node 24" below.
- **No new runtime dependency in either package.** `oauth/` stays on `express` + `jose`; the connector stays on its current eight. This is why the cross-service assertion is an HMAC over a literal string rather than a JWT (spec §4).
- **The toolchain is TypeScript 7, `tsx` 4.23, zod 4, imapflow 2 and nodemailer 10**, as of the 0.5.0 refresh. Two consequences for the code below: nodemailer ships its own type definitions now — `@types/nodemailer` was removed because they are stricter — and the connector's tool schemas are on zod 4, which the MCP SDK accepts alongside 3. Nothing in this plan needs a zod schema, but a `probe.ts` written against nodemailer's old community types will not compile.
- **Do not change any version string.** `scripts/check-versions.sh` runs in CI and fails the build when the eight places this repository states its version stop agreeing, so a partial bump is worse than none. Releasing is a separate act, after this plan is finished.
- **The two packages cannot import from each other.** `oauth/Dockerfile` builds with `context: oauth`, so nothing under `src/` is in its build context. Constants shared between them are duplicated verbatim and each copy carries a comment naming the other.
- **No JavaScript is served to the browser, and no build step is added.** Every page is server-rendered HTML with inline CSS, and every interaction is a form submission.
- **Attribution:** contributions must never name "Claude" or "Anthropic" as an author. No `Co-Authored-By:` trailers, no "Generated with" footers, no session links, no mention of AI assistance in commit messages, PR text or code comments. The product name and references to MCP clients are unaffected.
- **Commits:** English, Conventional Commits, small and thematically separate. One commit per task unless a task says otherwise.
- **`.gitignore` stays as it is.** `accounts.json`, `data/`, `secrets/`, `.env*` and `oauth-data/` are ignored and must remain so. Never commit a generated key, hash or credential.
- **Never log a token, password, code verifier, authorization code, session id or CSRF value.** `oauth/src/logger.ts` states this rule; it now covers session cookies and assertions too.
- **The failed-login log line is deployment API.** `LOGIN_FAILURE_EVENT` ("login failed") plus the `ip` field is matched by the fail2ban filter in `docs/HARDENING.md`. Settings sign-in failures emit the same line; do not change its shape.

### Values fixed across tasks

Copy these verbatim wherever they appear. A mismatch between the two packages is a silent authentication failure, not a compile error.

| Constant | Value |
| --- | --- |
| Assertion header | `x-settings-assertion` |
| Assertion audience | `mail-mcp-settings` |
| Assertion version tag | `1` |
| Assertion lifetime | 30 seconds |
| Session cookie name | `__Host-mailmcp_session` |
| Session audience | `settings-session` |
| Session lifetime | 3600 seconds |
| CSRF form field | `_csrf` |
| Settings key env var | `SETTINGS_SIGNING_KEY` / `SETTINGS_SIGNING_KEY_FILE` |
| Minimum settings key length | 32 bytes |

### Verifying on Node 24

The repository's `node_modules` is built for Windows and cannot run in the Linux
container, so the check copies the tree without it and installs fresh:

```bash
docker run --rm -v "/c/Users/yanni/IdeaProjects/claude-mail-mcp:/src:ro" node:24-alpine sh -c '
set -e
mkdir -p /app && cd /src && tar cf - --exclude=node_modules --exclude=.git --exclude=dist . | (cd /app && tar xf -)
cd /app && npm ci --silent >/dev/null 2>&1
npm run typecheck --silent && npm run typecheck:test --silent && npm run test:unit --silent 2>&1 | tail -6
cd /app/oauth && npm ci --silent >/dev/null 2>&1
npm run typecheck --silent && npm run typecheck:test --silent && npm run test:unit --silent 2>&1 | tail -6
'
```

On Git Bash prefix the whole command with `MSYS_NO_PATHCONV=1`, or the mount path is
mangled into a drive letter.

---

## File structure

**OAuth layer — created**

| File | Responsibility |
| --- | --- |
| `oauth/src/assertion.ts` | Mint the cross-service assertion. Nothing else. |
| `oauth/src/session.ts` | Session token sign/verify, cookie serialisation and parsing, CSRF comparison. No Express types. |
| `oauth/src/operator.ts` | The operator record: seed from the secret, verify, change password, bump `sessionEpoch`, atomic write. |
| `oauth/src/settings-pages.ts` | Pure HTML rendering. Takes plain data, returns a string, touches no I/O. |
| `oauth/src/settings-routes.ts` | The `/settings` router: sign-in, overview, clients, password, logout. |

**OAuth layer — modified**

| File | Change |
| --- | --- |
| `oauth/src/config.ts` | `settingsSigningKey`, `operatorFile`; `authPasswordHash` becomes the seed rather than the live value. |
| `oauth/src/store.ts` | `tokenEpoch` on `StoreData`, `revokedAt` on `ClientRecord`, `deleteClient`, `revokeAll`. |
| `oauth/src/tokens.ts` | `epoch` claim at issuance; epoch and `revokedAt` checks at verification. |
| `oauth/src/proxy.ts` | Strip `Cookie`, inject a header, allow a per-request upstream path. |
| `oauth/src/app.ts` | Mount the settings router and the settings proxy. |
| `oauth/src/index.ts` | Open the operator record and pass it in. |

**Connector — created**

| File | Responsibility |
| --- | --- |
| `src/settings-assertion.ts` | Verify the assertion; the Express guard. |
| `src/accounts-writer.ts` | Atomic, round-trip-validated writes of `accounts.json`. |
| `src/probe.ts` | One-shot IMAP/SMTP/CalDAV connection tests. |
| `src/settings-pages.ts` | Pure HTML rendering for the mailbox list and form. |
| `src/settings-routes.ts` | The `/settings/mailboxes` router. |

**Connector — modified**

| File | Change |
| --- | --- |
| `src/accounts.ts` | Export `parseAccountsFile`; add `create`/`update`/`remove`/`setDefault`/`stamp`. |
| `src/config.ts` | `settingsSigningKey` with `_FILE` support. |
| `src/app.ts` | Mount the settings router when a key is configured. |
| `src/index.ts` | Pass the key through. |
| `src/accounts.ts:96`, `src/tools-mail.ts:56`, `src/tools-calendar.ts:44` | Point at the real settings URL. |

**Deployment**

`docker-compose.yml`, `.env.example`, `.env.docker.example`, `oauth/.env.example`.

## Task dependency graph

```
Task 1 ─┬─> Task 2 ─┬─> Task 6 ──> Task 7 ──> Task 8 ──> Task 9 ─┐
        │           │                                            │
        ├─> Task 3 ─┤                                            ├─> Task 15 ──> Task 16
        ├─> Task 4 ─┘                                            │
        │                                                        │
        ├─> Task 10 ─┬─> Task 14 ─────────────────────────────────┘
        ├─> Task 11 ─┤
        ├─> Task 12 ─┤
        └─> Task 13 ─┘
```

Task 1 first, alone. Then Tasks 2, 3, 4, 10, 11, 12 and 13 can run in parallel — they
create separate files and touch no shared line. Task 5 is folded into Task 6. Tasks
6→9 are serial because each edits `oauth/src/app.ts`. Task 14 edits `src/app.ts` and
waits for 10–13.

**Natural stopping point:** after Task 9 the OAuth layer ships working software — sign
in, review and revoke clients, change the password — with mailbox editing still to
come. If the plan is split across sessions, split it there.

---

## Task 1: Configuration for the settings signing key

Implements spec §4. Both packages learn the same key from the same secret. Nothing
uses it yet; this task exists on its own because every later task depends on the
config shape and a mistake here is discovered in six places at once.

**Files:**
- Modify: `oauth/src/config.ts`
- Modify: `src/config.ts`
- Test: `oauth/test/unit/config.test.ts`
- Test: `test/unit/config.settings-key.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `OAuthConfig.settingsSigningKey: Uint8Array | null` — null when unset, meaning the settings UI is off.
  - `OAuthConfig.operatorFile: string | null` — path to `operator.json`, null when `OPERATOR_FILE=none`.
  - `config.settingsSigningKey: string` in the connector — empty string when unset.

- [ ] **Step 1: Write the failing test for the OAuth layer**

Append to `oauth/test/unit/config.test.ts`. The existing file builds an env object and
calls `loadConfig(env)`; follow whatever helper it already uses to produce a valid
baseline env.

```ts
test("settings signing key is absent by default", () => {
  const config = loadConfig(validEnv());
  assert.equal(config.settingsSigningKey, null);
});

test("settings signing key is read from SETTINGS_SIGNING_KEY", () => {
  const key = "x".repeat(32);
  const config = loadConfig({ ...validEnv(), SETTINGS_SIGNING_KEY: key });
  assert.deepEqual(config.settingsSigningKey, new TextEncoder().encode(key));
});

test("a short settings signing key is refused", () => {
  assert.throws(
    () => loadConfig({ ...validEnv(), SETTINGS_SIGNING_KEY: "too-short" }),
    /at least 32 bytes/
  );
});

test("operatorFile defaults next to the state file and can be disabled", () => {
  assert.equal(
    loadConfig({ ...validEnv(), STATE_FILE: "/data/oauth-state.json" }).operatorFile,
    "/data/operator.json"
  );
  assert.equal(
    loadConfig({ ...validEnv(), OPERATOR_FILE: "none" }).operatorFile,
    null
  );
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd oauth && node --import tsx --test test/unit/config.test.ts`
Expected: FAIL — `settingsSigningKey` is not a property of the returned object.

- [ ] **Step 3: Implement in `oauth/src/config.ts`**

Add the two fields to the `OAuthConfig` interface:

```ts
  /**
   * Key for the assertion the settings proxy sends to the connector. Null turns
   * the settings UI off entirely: with no key there is nothing the connector
   * would accept, so the routes are not mounted at all.
   */
  settingsSigningKey: Uint8Array | null;
  /**
   * Where the live operator record lives. AUTH_PASSWORD_HASH seeds it once; after
   * that this file wins, because /run/secrets is mounted read-only and a password
   * change has to be able to write somewhere. `OPERATOR_FILE=none` keeps the old
   * behaviour — hash from the secret, password change disabled.
   */
  operatorFile: string | null;
```

And in `loadConfig`, after the existing `stateFile` block:

```ts
  const settingsKeyRaw = readSecret(env, "SETTINGS_SIGNING_KEY");
  let settingsSigningKey: Uint8Array | null = null;
  if (settingsKeyRaw !== undefined) {
    settingsSigningKey = new TextEncoder().encode(settingsKeyRaw);
    if (settingsSigningKey.length < MIN_SIGNING_KEY_BYTES) {
      throw new ConfigError(
        `SETTINGS_SIGNING_KEY must be at least ${MIN_SIGNING_KEY_BYTES} bytes; got ` +
          `${settingsSigningKey.length}. Generate one with: openssl rand -base64 48`
      );
    }
  }

  const operatorFileRaw = optional(
    env,
    "OPERATOR_FILE",
    stateFile === null ? "" : join(dirname(stateFile), "operator.json")
  );
  const operatorFile =
    operatorFileRaw === "" || operatorFileRaw === "none" ? null : operatorFileRaw;
```

Import `dirname` and `join` from `node:path` at the top. Return both new fields from
`loadConfig`.

- [ ] **Step 4: Run the OAuth config tests**

Run: `cd oauth && node --import tsx --test test/unit/config.test.ts`
Expected: PASS, and the existing tests in that file still pass.

- [ ] **Step 5: Write the failing connector test**

Create `test/unit/config.settings-key.test.ts`. The connector's `config` is a frozen
module-level constant, so each case needs a fresh import with a cache-busting query —
match whatever the existing `config.overrides.test.ts` does.

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function loadConfig(env: Record<string, string>) {
  const previous = { ...process.env };
  Object.assign(process.env, { AUTH_TOKEN: "t", ...env });
  try {
    const mod = await import(`../../src/config.js?case=${Math.random()}`);
    return mod.config;
  } finally {
    process.env = previous;
  }
}

test("settings signing key defaults to empty", async () => {
  const config = await loadConfig({});
  assert.equal(config.settingsSigningKey, "");
});

test("settings signing key can be supplied inline", async () => {
  const config = await loadConfig({ SETTINGS_SIGNING_KEY: "k".repeat(32) });
  assert.equal(config.settingsSigningKey, "k".repeat(32));
});

test("SETTINGS_SIGNING_KEY_FILE wins over the inline value and is trimmed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mailmcp-"));
  const file = join(dir, "key");
  writeFileSync(file, `${"f".repeat(32)}\n`);
  const config = await loadConfig({
    SETTINGS_SIGNING_KEY: "i".repeat(32),
    SETTINGS_SIGNING_KEY_FILE: file,
  });
  assert.equal(config.settingsSigningKey, "f".repeat(32));
});

test("an unreadable SETTINGS_SIGNING_KEY_FILE is fatal, not a silent fallback", async () => {
  await assert.rejects(
    () => loadConfig({ SETTINGS_SIGNING_KEY_FILE: "/nonexistent/key" }),
    /Cannot read SETTINGS_SIGNING_KEY_FILE/
  );
});
```

- [ ] **Step 6: Run it and watch it fail**

Run: `node --import tsx --test test/unit/config.settings-key.test.ts`
Expected: FAIL — the property does not exist.

- [ ] **Step 7: Implement in `src/config.ts`**

The connector has no file-backed secret reader yet. Add one above `export const config`:

```ts
import { readFileSync } from "node:fs";

/**
 * Read a value that may be given inline or as a path to a file holding it.
 *
 * `NAME_FILE` wins when both are set, and an unreadable `NAME_FILE` is fatal
 * rather than a silent fallback to `NAME` — a typo in a secret mount should stop
 * the process, not quietly downgrade it. Mirrors the same helper in
 * oauth/src/config.ts.
 */
function secret(name: string, fallback: string): string {
  const filePath = process.env[`${name}_FILE`];
  if (filePath && filePath.trim() !== "") {
    try {
      return readFileSync(filePath.trim(), "utf8").trim();
    } catch (err) {
      throw new Error(
        `Cannot read ${name}_FILE at ${filePath.trim()}: ` +
          (err instanceof Error ? err.message : String(err))
      );
    }
  }
  return optional(name, fallback);
}
```

And in the config object:

```ts
  /**
   * Shared key for the settings assertion the OAuth layer sends with proxied
   * /settings requests. Empty means the settings routes are not mounted and this
   * process behaves exactly as it did before they existed.
   */
  settingsSigningKey: secret("SETTINGS_SIGNING_KEY", ""),
```

- [ ] **Step 8: Run both suites**

Run: `node --import tsx --test test/unit/*.test.ts` and
`cd oauth && node --import tsx --test test/unit/*.test.ts`
Expected: PASS, nothing regressed.

- [ ] **Step 9: Commit**

```bash
git add oauth/src/config.ts oauth/test/unit/config.test.ts src/config.ts test/unit/config.settings-key.test.ts
git commit -m "feat(settings): configure the shared signing key in both services"
```

---

## Task 2: The cross-service assertion

Implements spec §4. Two implementations of one format, one per package, because the
build contexts are separate. Write both here so they are written from the same
description and tested against each other.

**Files:**
- Create: `oauth/src/assertion.ts`
- Create: `src/settings-assertion.ts`
- Test: `oauth/test/unit/assertion.test.ts`
- Test: `test/unit/settings-assertion.test.ts`

**Interfaces:**
- Consumes: `OAuthConfig.settingsSigningKey`, `config.settingsSigningKey` (Task 1).
- Produces:
  - `signAssertion(input: AssertionInput, key: Uint8Array, issuer: string): string` where `AssertionInput = { sub: string; sid: string; csrf: string; method: string; path: string }`
  - `verifyAssertion(token: string, key: Uint8Array, issuer: string, method: string, path: string, now?: number): VerifiedAssertion | null` where `VerifiedAssertion = { sub: string; sid: string; csrf: string }`
  - `ASSERTION_HEADER = "x-settings-assertion"`, exported from both.

- [ ] **Step 1: Write the failing tests for the connector's verifier**

Create `test/unit/settings-assertion.test.ts`. These tests double as the format's
specification, so write them before either implementation.

```ts
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";

import { verifyAssertion } from "../../src/settings-assertion.js";

const KEY = new TextEncoder().encode("k".repeat(32));
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
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --import tsx --test test/unit/settings-assertion.test.ts`
Expected: FAIL — cannot find module `../../src/settings-assertion.js`.

- [ ] **Step 3: Implement `src/settings-assertion.ts`**

```ts
/**
 * The assertion the OAuth layer attaches to a proxied settings request.
 *
 * Deliberately not a JWT. A JWT here would mean either adding `jose` to this
 * package — which depends on no crypto library at all — or hand-writing JWT
 * verification, which is where algorithm-confusion bugs live. This is an HMAC over
 * the literal transmitted string: there is no algorithm field to confuse and no
 * canonicalisation to disagree about, and it needs only node:crypto.
 *
 * Format: `<payload>.<mac>`, where `payload` is base64url-encoded JSON and `mac` is
 * HMAC-SHA256 over that exact string. Verification recomputes the MAC over what
 * arrived, compares in constant time, and only then parses the JSON — so no
 * attacker-controlled bytes reach JSON.parse until the signature has held.
 *
 * The format is mirrored in oauth/src/assertion.ts. The two packages have separate
 * Docker build contexts and cannot share a module; if you change one, change both.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/** Header the assertion travels in. Mirrored in oauth/src/assertion.ts. */
export const ASSERTION_HEADER = "x-settings-assertion";

/** Audience claim. Mirrored in oauth/src/assertion.ts. */
export const ASSERTION_AUDIENCE = "mail-mcp-settings";

const VERSION = 1;

export interface VerifiedAssertion {
  sub: string;
  sid: string;
  csrf: string;
}

/**
 * Verify an assertion. Returns null for anything that does not hold — a wrong key,
 * a tampered payload, an expired token, or one minted for a different method or
 * path. Never throws: a malformed header is a 401, not a 500.
 */
export function verifyAssertion(
  token: string,
  key: Uint8Array,
  issuer: string,
  method: string,
  path: string,
  now: number = Math.floor(Date.now() / 1000)
): VerifiedAssertion | null {
  const separator = token.indexOf(".");
  if (separator <= 0 || separator === token.length - 1) return null;
  const encoded = token.slice(0, separator);
  const presented = token.slice(separator + 1);
  if (encoded.includes(".") || presented.includes(".")) return null;

  const expected = createHmac("sha256", key).update(encoded).digest();
  let presentedMac: Buffer;
  try {
    presentedMac = Buffer.from(presented, "base64url");
  } catch {
    return null;
  }
  if (presentedMac.length !== expected.length) return null;
  if (!timingSafeEqual(presentedMac, expected)) return null;

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object") return null;

  if (payload.v !== VERSION) return null;
  if (payload.iss !== issuer) return null;
  if (payload.aud !== ASSERTION_AUDIENCE) return null;
  if (payload.htm !== method.toUpperCase()) return null;
  if (payload.htu !== path) return null;
  if (typeof payload.exp !== "number" || payload.exp <= now) return null;

  const { sub, sid, csrf } = payload;
  if (typeof sub !== "string" || typeof sid !== "string" || typeof csrf !== "string") {
    return null;
  }
  return { sub, sid, csrf };
}
```

- [ ] **Step 4: Run the connector tests**

Run: `node --import tsx --test test/unit/settings-assertion.test.ts`
Expected: PASS, all nine cases.

- [ ] **Step 5: Write the failing test for the minter**

Create `oauth/test/unit/assertion.test.ts`. It verifies with an independent
recomputation rather than by calling the connector's verifier, which it cannot import.

```ts
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";

import { ASSERTION_TTL_SECONDS, signAssertion } from "../../src/assertion.js";

const KEY = new TextEncoder().encode("k".repeat(32));
const ISSUER = "https://mail-mcp.example.com";

function decode(token: string): Record<string, unknown> {
  const [encoded, mac] = token.split(".");
  const expected = createHmac("sha256", KEY).update(encoded).digest("base64url");
  assert.equal(mac, expected, "MAC must cover the encoded payload verbatim");
  return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
}

test("the minted assertion carries every claim the verifier checks", () => {
  const before = Math.floor(Date.now() / 1000);
  const token = signAssertion(
    { sub: "operator", sid: "s1", csrf: "c1", method: "post", path: "/settings/mailboxes" },
    KEY,
    ISSUER
  );
  const payload = decode(token);
  assert.equal(payload.v, 1);
  assert.equal(payload.iss, ISSUER);
  assert.equal(payload.aud, "mail-mcp-settings");
  assert.equal(payload.sub, "operator");
  assert.equal(payload.sid, "s1");
  assert.equal(payload.csrf, "c1");
  assert.equal(payload.htm, "POST", "method is upper-cased so the two sides agree");
  assert.equal(payload.htu, "/settings/mailboxes");
  assert.ok(
    (payload.exp as number) >= before + ASSERTION_TTL_SECONDS &&
      (payload.exp as number) <= before + ASSERTION_TTL_SECONDS + 2
  );
});

test("the payload carries no secret beyond the session identifiers", () => {
  const token = signAssertion(
    { sub: "operator", sid: "s1", csrf: "c1", method: "GET", path: "/settings/mailboxes" },
    KEY,
    ISSUER
  );
  assert.deepEqual(
    Object.keys(decode(token)).sort(),
    ["aud", "csrf", "exp", "htm", "htu", "iss", "sid", "sub", "v"]
  );
});
```

- [ ] **Step 6: Run it and watch it fail**

Run: `cd oauth && node --import tsx --test test/unit/assertion.test.ts`
Expected: FAIL — cannot find module `../../src/assertion.js`.

- [ ] **Step 7: Implement `oauth/src/assertion.ts`**

```ts
/**
 * Minting side of the settings assertion.
 *
 * See src/settings-assertion.ts in the connector for the verifying side and for why
 * this is an HMAC rather than a JWT. The two packages have separate Docker build
 * contexts and cannot share a module; if you change the format here, change it
 * there in the same commit.
 */

import { createHmac } from "node:crypto";

/** Header the assertion travels in. Mirrored in src/settings-assertion.ts. */
export const ASSERTION_HEADER = "x-settings-assertion";

/** Audience claim. Mirrored in src/settings-assertion.ts. */
export const ASSERTION_AUDIENCE = "mail-mcp-settings";

/**
 * How long an assertion is good for. Long enough to survive a slow hop on the
 * container network, short enough that a captured one is worthless — it is minted
 * per request and never stored.
 */
export const ASSERTION_TTL_SECONDS = 30;

const VERSION = 1;

export interface AssertionInput {
  sub: string;
  sid: string;
  csrf: string;
  /** The HTTP method of the request being proxied. Case-insensitive. */
  method: string;
  /** The upstream path, query string excluded. */
  path: string;
}

export function signAssertion(
  input: AssertionInput,
  key: Uint8Array,
  issuer: string,
  now: number = Math.floor(Date.now() / 1000)
): string {
  const payload = {
    v: VERSION,
    iss: issuer,
    aud: ASSERTION_AUDIENCE,
    sub: input.sub,
    sid: input.sid,
    csrf: input.csrf,
    htm: input.method.toUpperCase(),
    htu: input.path,
    exp: now + ASSERTION_TTL_SECONDS,
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const mac = createHmac("sha256", key).update(encoded).digest("base64url");
  return `${encoded}.${mac}`;
}
```

- [ ] **Step 8: Run both new suites**

Run: `node --import tsx --test test/unit/settings-assertion.test.ts` and
`cd oauth && node --import tsx --test test/unit/assertion.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add oauth/src/assertion.ts oauth/test/unit/assertion.test.ts src/settings-assertion.ts test/unit/settings-assertion.test.ts
git commit -m "feat(settings): sign and verify the cross-service assertion"
```

---

## Task 3: The operator session

Implements spec §3.2 and §3.3. Pure token and cookie handling, no Express.

**Files:**
- Create: `oauth/src/session.ts`
- Test: `oauth/test/unit/session.test.ts`

**Interfaces:**
- Consumes: `OAuthConfig.signingKey`, `OAuthConfig.issuer`.
- Produces:
  - `SESSION_COOKIE = "__Host-mailmcp_session"`, `SESSION_TTL_SECONDS = 3600`, `CSRF_FIELD = "_csrf"`
  - `newSession(username: string, epoch: number): SessionClaims` where `SessionClaims = { sub: string; sid: string; csrf: string; epoch: number }`
  - `signSession(claims, key, issuer): Promise<string>`
  - `verifySession(token, key, issuer, currentEpoch): Promise<SessionClaims | null>`
  - `sessionCookie(token: string): string`, `clearedSessionCookie(): string`
  - `readSessionCookie(header: string | undefined): string | null`
  - `csrfMatches(claims: SessionClaims, submitted: unknown): boolean`

- [ ] **Step 1: Write the failing test**

Create `oauth/test/unit/session.test.ts`.

```ts
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
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd oauth && node --import tsx --test test/unit/session.test.ts`
Expected: FAIL — cannot find module `../../src/session.js`.

- [ ] **Step 3: Implement `oauth/src/session.ts`**

```ts
/**
 * The operator's browser session.
 *
 * Unlike the OAuth sign-in step, which carries its state in a signed hidden field,
 * the settings UI spans several requests and needs a cookie. It still keeps no
 * server-side session table: the cookie is a signed token and the only server state
 * is a single integer, `sessionEpoch`, which every token carries a copy of. Bumping
 * it invalidates every outstanding session at once — which is what makes sign-out
 * everywhere, and a password change, mean anything against a stateless token.
 *
 * The `__Host-` prefix is not decoration. It makes the browser refuse the cookie
 * unless it is Secure, has no Domain and is scoped to Path=/, so a sibling host
 * cannot set a cookie this service would read. Path=/ is the price: the cookie is
 * sent to /mcp and /token too, which ignore it, and proxy.ts strips it before
 * anything leaves for the connector.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";

/** Cookie name. The `__Host-` prefix is enforced by the browser, not by us. */
export const SESSION_COOKIE = "__Host-mailmcp_session";

/** Absolute lifetime. Re-issued on every authenticated GET, so it acts as idle timeout. */
export const SESSION_TTL_SECONDS = 60 * 60;

/** Name of the hidden CSRF field in every state-changing form. */
export const CSRF_FIELD = "_csrf";

const AUDIENCE = "settings-session";
const ALGORITHM = "HS256";

export interface SessionClaims {
  sub: string;
  sid: string;
  csrf: string;
  epoch: number;
}

/** Mint claims for a newly authenticated operator. Never called before sign-in succeeds. */
export function newSession(username: string, epoch: number): SessionClaims {
  return {
    sub: username,
    sid: randomBytes(16).toString("hex"),
    csrf: randomBytes(16).toString("hex"),
    epoch,
  };
}

export async function signSession(
  claims: SessionClaims,
  key: Uint8Array,
  issuer: string
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ sid: claims.sid, csrf: claims.csrf, epoch: claims.epoch })
    .setProtectedHeader({ alg: ALGORITHM, typ: "JWT" })
    .setIssuer(issuer)
    .setAudience(AUDIENCE)
    .setSubject(claims.sub)
    .setIssuedAt(now)
    .setExpirationTime(now + SESSION_TTL_SECONDS)
    .sign(key);
}

/**
 * Verify a session cookie. Returns null for anything that does not hold, including a
 * token whose epoch is behind the current one — that is the revocation path, and it
 * must be indistinguishable from an ordinary expiry to the caller.
 */
export async function verifySession(
  token: string,
  key: Uint8Array,
  issuer: string,
  currentEpoch: number
): Promise<SessionClaims | null> {
  let payload;
  try {
    ({ payload } = await jwtVerify(token, key, {
      algorithms: [ALGORITHM],
      issuer,
      audience: AUDIENCE,
    }));
  } catch {
    return null;
  }
  const { sub, sid, csrf, epoch } = payload;
  if (
    typeof sub !== "string" ||
    typeof sid !== "string" ||
    typeof csrf !== "string" ||
    typeof epoch !== "number"
  ) {
    return null;
  }
  if (epoch !== currentEpoch) return null;
  return { sub, sid, csrf, epoch };
}

export function sessionCookie(token: string): string {
  return [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${SESSION_TTL_SECONDS}`,
  ].join("; ");
}

export function clearedSessionCookie(): string {
  return [`${SESSION_COOKIE}=`, "Path=/", "HttpOnly", "Secure", "SameSite=Lax", "Max-Age=0"].join(
    "; "
  );
}

/**
 * Pull the session token out of a Cookie header.
 *
 * Hand-parsed rather than via a dependency: the grammar needed here is one pair per
 * `; ` and nothing else, and adding a package to this service to do it would be a
 * poor trade. Matching is on the whole name, so `not__Host-mailmcp_session` does not
 * pass for ours.
 */
export function readSessionCookie(header: string | undefined): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== SESSION_COOKIE) continue;
    const value = part.slice(separator + 1).trim();
    return value === "" ? null : value;
  }
  return null;
}

/** Constant-time comparison of a submitted CSRF field against the session's own. */
export function csrfMatches(claims: SessionClaims, submitted: unknown): boolean {
  if (typeof submitted !== "string" || submitted.length === 0) return false;
  const expected = Buffer.from(claims.csrf, "utf8");
  const presented = Buffer.from(submitted, "utf8");
  if (expected.length !== presented.length) {
    timingSafeEqual(expected, expected);
    return false;
  }
  return timingSafeEqual(expected, presented);
}
```

- [ ] **Step 4: Run the test**

Run: `cd oauth && node --import tsx --test test/unit/session.test.ts`
Expected: PASS, all ten cases.

- [ ] **Step 5: Commit**

```bash
git add oauth/src/session.ts oauth/test/unit/session.test.ts
git commit -m "feat(settings): add the stateless operator session"
```

---

## Task 4: The operator record

Implements spec §9. Moves the live password hash off the read-only secret mount.

**Files:**
- Create: `oauth/src/operator.ts`
- Test: `oauth/test/unit/operator.test.ts`

**Interfaces:**
- Consumes: `hashPassword`, `verifyPassword`, `constantTimeEquals` from `./passwords.js`; `Logger` from `./logger.js`.
- Produces:
  - `class OperatorRecord` with `static open(path: string | null, seed: { username: string; passwordHash: string }, log: Logger): Promise<OperatorRecord>`
  - `get username(): string`, `get sessionEpoch(): number`, `get canChangePassword(): boolean`
  - `verify(username: string, password: string): Promise<boolean>`
  - `changePassword(next: string): Promise<void>` — hashes, writes, bumps `sessionEpoch`
  - `bumpSessionEpoch(): Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `oauth/test/unit/operator.test.ts`.

```ts
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { silentLogger } from "../../src/logger.js";
import { OperatorRecord } from "../../src/operator.js";
import { hashPassword } from "../../src/passwords.js";

const FAST_SCRYPT = { N: 1024, r: 8, p: 1 } as const;

async function seed() {
  return { username: "operator", passwordHash: await hashPassword("first", FAST_SCRYPT) };
}

async function tempFile(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "operator-")), "operator.json");
}

test("the record is seeded from the secret on first open", async () => {
  const path = await tempFile();
  const record = await OperatorRecord.open(path, await seed(), silentLogger);
  assert.equal(record.username, "operator");
  assert.equal(record.sessionEpoch, 0);
  assert.equal(await record.verify("operator", "first"), true);
  const written = JSON.parse(await readFile(path, "utf8"));
  assert.equal(written.version, 1);
  assert.equal(written.sessionEpoch, 0);
});

test("the stored hash wins over the seed on reopen", async () => {
  const path = await tempFile();
  const first = await OperatorRecord.open(path, await seed(), silentLogger);
  await first.changePassword("second");

  const reopened = await OperatorRecord.open(path, await seed(), silentLogger);
  assert.equal(await reopened.verify("operator", "second"), true);
  assert.equal(await reopened.verify("operator", "first"), false);
});

test("changing the password bumps the session epoch", async () => {
  const record = await OperatorRecord.open(await tempFile(), await seed(), silentLogger);
  assert.equal(record.sessionEpoch, 0);
  await record.changePassword("second");
  assert.equal(record.sessionEpoch, 1);
});

test("a wrong username costs the same answer as a wrong password", async () => {
  const record = await OperatorRecord.open(await tempFile(), await seed(), silentLogger);
  assert.equal(await record.verify("someone-else", "first"), false);
  assert.equal(await record.verify("operator", "wrong"), false);
});

test("the file is written 0600", async () => {
  const path = await tempFile();
  const record = await OperatorRecord.open(path, await seed(), silentLogger);
  await record.changePassword("second");
  const mode = (await stat(path)).mode & 0o777;
  assert.equal(mode, 0o600);
});

test("a corrupt file falls back to the seed instead of refusing to start", async () => {
  const path = await tempFile();
  await writeFile(path, "{ not json", "utf8");
  const record = await OperatorRecord.open(path, await seed(), silentLogger);
  assert.equal(await record.verify("operator", "first"), true);
});

test("with no path the record is read-only and the password cannot be changed", async () => {
  const record = await OperatorRecord.open(null, await seed(), silentLogger);
  assert.equal(record.canChangePassword, false);
  assert.equal(await record.verify("operator", "first"), true);
  await assert.rejects(() => record.changePassword("second"), /OPERATOR_FILE/);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd oauth && node --import tsx --test test/unit/operator.test.ts`
Expected: FAIL — cannot find module `../../src/operator.js`.

- [ ] **Step 3: Implement `oauth/src/operator.ts`**

```ts
/**
 * The live operator credential.
 *
 * AUTH_PASSWORD_HASH cannot be the live value: it arrives as a Docker file-secret
 * mounted read-only under /run/secrets, and a password change has to be able to
 * write somewhere. So the secret seeds this record once and the record wins from
 * then on. `OPERATOR_FILE=none` keeps the old arrangement — hash from the secret,
 * password change unavailable — for a deployment that would rather manage the hash
 * out of band.
 *
 * The trap that arrangement creates is an operator who edits the secret file and
 * wonders why nothing happened. open() therefore logs which source is live and
 * warns by name when the two differ.
 */

import { randomUUID } from "node:crypto";
import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { Logger } from "./logger.js";
import { constantTimeEquals, hashPassword, verifyPassword } from "./passwords.js";

const CURRENT_VERSION = 1;

interface OperatorData {
  version: number;
  username: string;
  passwordHash: string;
  sessionEpoch: number;
}

export interface OperatorSeed {
  username: string;
  passwordHash: string;
}

export class OperatorRecord {
  #data: OperatorData;
  readonly #path: string | null;
  readonly #log: Logger;
  #writeChain: Promise<void> = Promise.resolve();

  private constructor(path: string | null, data: OperatorData, log: Logger) {
    this.#path = path;
    this.#data = data;
    this.#log = log;
  }

  static async open(
    path: string | null,
    seed: OperatorSeed,
    log: Logger
  ): Promise<OperatorRecord> {
    const fresh: OperatorData = {
      version: CURRENT_VERSION,
      username: seed.username,
      passwordHash: seed.passwordHash,
      sessionEpoch: 0,
    };

    if (path === null) {
      log("info", "operator credential source", { source: "secret", writable: false });
      return new OperatorRecord(null, fresh, log);
    }

    let raw: string | null = null;
    try {
      raw = await readFile(path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }

    if (raw === null) {
      const record = new OperatorRecord(path, fresh, log);
      await record.#persist();
      log("info", "operator credential source", { source: "secret (seeded)", path });
      return record;
    }

    const parsed = parse(raw);
    if (!parsed) {
      log("error", "operator file unreadable, falling back to the secret", { path });
      return new OperatorRecord(path, fresh, log);
    }

    if (parsed.passwordHash !== seed.passwordHash) {
      // The most common cause is an operator who changed the password here and
      // later edited the secret expecting it to take effect. Say so by name.
      log("warn", "AUTH_PASSWORD_HASH differs from the stored operator hash and is ignored", {
        path,
      });
    }
    log("info", "operator credential source", { source: "file", path });
    return new OperatorRecord(path, parsed, log);
  }

  get username(): string {
    return this.#data.username;
  }

  get sessionEpoch(): number {
    return this.#data.sessionEpoch;
  }

  get canChangePassword(): boolean {
    return this.#path !== null;
  }

  /**
   * Check a submitted username and password. The username is compared in constant
   * time and the password is verified regardless, so a wrong username and a wrong
   * password take the same path and the same time.
   */
  async verify(username: string, password: string): Promise<boolean> {
    const nameOk = constantTimeEquals(username, this.#data.username);
    const passwordOk = await verifyPassword(password, this.#data.passwordHash);
    return nameOk && passwordOk;
  }

  async changePassword(next: string): Promise<void> {
    if (this.#path === null) {
      throw new Error(
        "Password change is disabled because OPERATOR_FILE is set to none. " +
          "Rotate AUTH_PASSWORD_HASH instead."
      );
    }
    const passwordHash = await hashPassword(next);
    this.#data = {
      ...this.#data,
      passwordHash,
      sessionEpoch: this.#data.sessionEpoch + 1,
    };
    await this.#persist();
  }

  /** Invalidate every outstanding session without touching the password. */
  async bumpSessionEpoch(): Promise<void> {
    this.#data = { ...this.#data, sessionEpoch: this.#data.sessionEpoch + 1 };
    if (this.#path !== null) await this.#persist();
  }

  /**
   * Temp file, then rename. The same recipe as store.ts: a crash mid-write leaves
   * the previous credential intact rather than a truncated one that would lock the
   * operator out of their own server.
   */
  async #persist(): Promise<void> {
    const path = this.#path;
    if (path === null) return;
    const payload = JSON.stringify(this.#data, null, 2);
    this.#writeChain = this.#writeChain.then(async () => {
      const temp = join(dirname(path), `.${randomUUID()}.tmp`);
      await writeFile(temp, payload, { encoding: "utf8", mode: 0o600 });
      await chmod(temp, 0o600);
      await rename(temp, path);
    });
    return this.#writeChain;
  }
}

function parse(raw: string): OperatorData | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Partial<OperatorData>;
  if (candidate.version !== CURRENT_VERSION) return null;
  if (typeof candidate.username !== "string" || candidate.username === "") return null;
  if (typeof candidate.passwordHash !== "string" || candidate.passwordHash === "") return null;
  if (typeof candidate.sessionEpoch !== "number" || !Number.isInteger(candidate.sessionEpoch)) {
    return null;
  }
  return {
    version: CURRENT_VERSION,
    username: candidate.username,
    passwordHash: candidate.passwordHash,
    sessionEpoch: candidate.sessionEpoch,
  };
}
```

- [ ] **Step 4: Run the test**

Run: `cd oauth && node --import tsx --test test/unit/operator.test.ts`
Expected: PASS, all seven cases.

- [ ] **Step 5: Commit**

```bash
git add oauth/src/operator.ts oauth/test/unit/operator.test.ts
git commit -m "feat(settings): move the live operator hash off the read-only secret"
```

---

## Task 5: Settings page rendering in the OAuth layer

Implements spec §5.1 and the no-JavaScript constraint. Pure functions, no I/O, so the
rendering is testable without a server.

**Files:**
- Create: `oauth/src/settings-pages.ts`
- Test: `oauth/test/unit/settings-pages.test.ts`

**Interfaces:**
- Consumes: `escapeHtml` from `./login.js`; `CSRF_FIELD` from `./session.js`.
- Produces:
  - `renderSettingsSignIn(opts: { error?: string }): string`
  - `renderOverview(opts: OverviewData): string` where `OverviewData = { csrf: string; username: string; connectorReachable: boolean; connectorVersion: string | null; mailboxes: Array<{ id: string; label: string; isDefault: boolean }>; clientCount: number; sessionCount: number; canChangePassword: boolean; notice?: string }`
  - `renderClients(opts: ClientsData): string` where `ClientsData = { csrf: string; clients: Array<{ id: string; name: string | null; issuedAt: number; redirectHosts: string[]; revoked: boolean }>; sessions: Array<{ sid: string; clientId: string; scope: string; expiresAt: number }>; notice?: string }`
  - `renderPasswordChange(opts: { csrf: string; error?: string; disabledReason?: string }): string`
  - `SETTINGS_HEADERS: Record<string, string>` — the response headers every settings page sets

- [ ] **Step 1: Write the failing test**

Create `oauth/test/unit/settings-pages.test.ts`.

```ts
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  SETTINGS_HEADERS,
  renderClients,
  renderOverview,
  renderPasswordChange,
  renderSettingsSignIn,
} from "../../src/settings-pages.js";

test("every page declares the strict content security policy and no framing", () => {
  assert.equal(
    SETTINGS_HEADERS["Content-Security-Policy"],
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'"
  );
  assert.equal(SETTINGS_HEADERS["X-Frame-Options"], "DENY");
  assert.equal(SETTINGS_HEADERS["Cache-Control"], "no-store");
  assert.equal(SETTINGS_HEADERS["Referrer-Policy"], "no-referrer");
});

test("no page carries a script tag or an inline handler", () => {
  const pages = [
    renderSettingsSignIn({}),
    renderOverview({
      csrf: "c",
      username: "operator",
      connectorReachable: true,
      connectorVersion: "0.5.0",
      mailboxes: [{ id: "work", label: "Work", isDefault: true }],
      clientCount: 1,
      sessionCount: 1,
      canChangePassword: true,
    }),
    renderClients({ csrf: "c", clients: [], sessions: [] }),
    renderPasswordChange({ csrf: "c" }),
  ];
  for (const page of pages) {
    assert.ok(!/<script/i.test(page), "no script element");
    assert.ok(!/\son[a-z]+\s*=/i.test(page), "no inline event handler");
    assert.ok(!/javascript:/i.test(page), "no javascript: URL");
  }
});

test("state-changing forms carry the CSRF field", () => {
  const page = renderClients({
    csrf: "csrf-value",
    clients: [
      { id: "c1", name: "Claude", issuedAt: 1757000000, redirectHosts: ["claude.ai"], revoked: false },
    ],
    sessions: [{ sid: "s1", clientId: "c1", scope: "mcp", expiresAt: 1757600000 }],
  });
  const forms = page.match(/<form[\s\S]*?<\/form>/g) ?? [];
  assert.ok(forms.length >= 2, "a revoke form per client and per session");
  for (const form of forms) {
    assert.match(form, /name="_csrf" value="csrf-value"/);
    assert.match(form, /method="post"/i);
  }
});

test("client-supplied names are escaped, not interpreted", () => {
  const page = renderClients({
    csrf: "c",
    clients: [
      {
        id: "c1",
        name: '<img src=x onerror="alert(1)">',
        issuedAt: 1757000000,
        redirectHosts: ["claude.ai"],
        revoked: false,
      },
    ],
    sessions: [],
  });
  assert.ok(!page.includes("<img src=x"), "the tag must not survive as markup");
  assert.match(page, /&lt;img src=x/);
});

test("the sign-in page shows an error without echoing it as markup", () => {
  const page = renderSettingsSignIn({ error: "<b>nope</b>" });
  assert.match(page, /&lt;b&gt;nope/);
  assert.ok(!page.includes("<b>nope</b>"));
});

test("the overview says plainly when the connector is unreachable", () => {
  const page = renderOverview({
    csrf: "c",
    username: "operator",
    connectorReachable: false,
    connectorVersion: null,
    mailboxes: [],
    clientCount: 0,
    sessionCount: 0,
    canChangePassword: true,
  });
  assert.match(page, /unreachable/i);
});

test("the password form is rendered disabled with a reason when changes are off", () => {
  const page = renderPasswordChange({ csrf: "c", disabledReason: "OPERATOR_FILE is set to none" });
  assert.match(page, /OPERATOR_FILE is set to none/);
  assert.ok(!/<input[^>]*type="password"[^>]*name="new_password"/.test(page));
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd oauth && node --import tsx --test test/unit/settings-pages.test.ts`
Expected: FAIL — cannot find module `../../src/settings-pages.js`.

- [ ] **Step 3: Implement `oauth/src/settings-pages.ts`**

Reuse the visual language of `login.ts`: a `STYLE` constant of inline CSS using system
colour keywords (`Canvas`, `CanvasText`, `AccentColor`) so both themes work without a
media query, wrapped by a `page(title, body)` helper that emits the doctype, meta
charset, viewport, `robots: noindex, nofollow`, the title and the style block.

The load-bearing details, each covered by a test above:

```ts
/**
 * Response headers every settings page sets.
 *
 * The same set the sign-in page in login.ts uses, for the same reasons: these pages
 * carry a CSRF token and take a password, must not be cached anywhere, and have no
 * reason to be framed. The CSP allows inline styles and nothing else — in
 * particular no script, which is why every interaction here is a form submission.
 */
export const SETTINGS_HEADERS: Record<string, string> = {
  "Cache-Control": "no-store",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy":
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
};

/** Hidden CSRF input. Every state-changing form gets exactly this. */
function csrfField(csrf: string): string {
  return `<input type="hidden" name="${CSRF_FIELD}" value="${escapeHtml(csrf)}">`;
}
```

Every interpolation of a value that did not originate in this file goes through
`escapeHtml` — client names, error strings, mailbox labels, redirect hosts. Timestamps
render with `new Date(seconds * 1000).toISOString()`.

Page contents:

- **Sign-in** — username and password inputs, submit, `action="/settings/login"`. No CSRF field: there is no session yet, and `isSameOrigin` covers this POST.
- **Overview** — connector reachability and version, mailbox list linking to `/settings/mailboxes`, counts of clients and sessions linking to `/settings/clients`, a link to `/settings/password` when `canChangePassword`, and two sign-out forms (`/settings/logout`, and the same with `all=1`).
- **Clients** — one table row per client with a revoke form, one per session with a revoke form, and a "revoke everything" form. Above them, one sentence stating that revoking takes effect immediately for both refresh and access tokens.
- **Password** — current, new and confirmation inputs, plus a checkbox `disconnect_clients` described as also disconnecting every connected Claude client, default unchecked. When `disabledReason` is set, render the reason and no form at all.

- [ ] **Step 4: Run the test**

Run: `cd oauth && node --import tsx --test test/unit/settings-pages.test.ts`
Expected: PASS, all seven cases.

- [ ] **Step 5: Commit**

```bash
git add oauth/src/settings-pages.ts oauth/test/unit/settings-pages.test.ts
git commit -m "feat(settings): render the operator pages"
```

---

## Task 6: Sign-in, overview and the session guard

Implements spec §3.1 and the first two rows of §5.1. This is where the router appears
and where `app.ts` starts changing, so Tasks 6 to 9 run in order.

**Files:**
- Create: `oauth/src/settings-routes.ts`
- Modify: `oauth/src/app.ts`
- Modify: `oauth/src/index.ts`
- Test: `oauth/test/integration/settings-session.test.ts`
- Test: `oauth/test/helpers/harness.ts` (extend)

**Interfaces:**
- Consumes: Tasks 1, 3, 4, 5.
- Produces:
  - `createSettingsRouter(deps: SettingsDeps): express.Router` where `SettingsDeps = { config: OAuthConfig; store: Store; operator: OperatorRecord; throttle: LoginThrottle; log: Logger; upstreamHealth: () => Promise<{ reachable: boolean; version: string | null; mailboxes: Array<{ id: string; label: string; isDefault: boolean }> }> }`
  - `requireSession(deps): express.RequestHandler` — attaches `res.locals.session: SessionClaims` and re-issues the cookie on GET
  - `requireCsrf(deps): express.RequestHandler`
  - Harness gains `operator: OperatorRecord` and `signIn(): Promise<string>` returning the session cookie value.

- [ ] **Step 1: Write the failing integration test**

Create `oauth/test/integration/settings-session.test.ts`. Use `startHarness` and plain
`fetch` with `redirect: "manual"`, as the existing integration tests do.

```ts
test("an unauthenticated GET /settings returns the sign-in form and no data", async () => {
  const harness = await startHarness();
  const res = await fetch(`${harness.baseUrl}/settings`);
  const body = await res.text();
  assert.equal(res.status, 200);
  assert.match(body, /name="password"/);
  assert.ok(!body.includes("Connected clients"), "no operator data before sign-in");
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(res.headers.get("set-cookie"), null, "no cookie is issued before sign-in");
  await harness.close();
});

test("a correct sign-in sets the session cookie with the expected attributes", async () => {
  const harness = await startHarness();
  const res = await fetch(`${harness.baseUrl}/settings/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: harness.baseUrl },
    body: new URLSearchParams({ username: TEST_USERNAME, password: TEST_PASSWORD }),
  });
  assert.equal(res.status, 303);
  const cookie = res.headers.get("set-cookie") ?? "";
  assert.match(cookie, /^__Host-mailmcp_session=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Lax/);
  await harness.close();
});

test("a wrong password is throttled after five attempts and logs the fail2ban line", async () => {
  const events: string[] = [];
  const harness = await startHarness({ log: (_l, msg) => events.push(msg) });
  for (let i = 0; i < 5; i += 1) {
    const res = await signInWith(harness, TEST_USERNAME, "wrong");
    assert.equal(res.status, 401);
  }
  const blocked = await signInWith(harness, TEST_USERNAME, TEST_PASSWORD);
  assert.equal(blocked.status, 429, "a correct password does not bypass the lockout");
  assert.ok(blocked.headers.has("retry-after"));
  assert.ok(events.includes("login failed"), "the fail2ban filter matches on this line");
  await harness.close();
});

test("the settings throttle and the OAuth sign-in throttle share one budget", async () => {
  const harness = await startHarness();
  for (let i = 0; i < 5; i += 1) await signInWith(harness, TEST_USERNAME, "wrong");
  const authorize = await postAuthorizeForm(harness, TEST_USERNAME, TEST_PASSWORD);
  assert.equal(authorize.status, 429);
  await harness.close();
});

test("a session cookie minted before a password change stops working after it", async () => {
  const harness = await startHarness();
  const cookie = await harness.signIn();
  assert.equal((await getSettings(harness, cookie)).status, 200);
  await harness.operator.changePassword("a new password entirely");
  const after = await getSettings(harness, cookie);
  assert.equal(after.status, 200);
  assert.match(await after.text(), /name="password"/, "back to the sign-in form");
  await harness.close();
});

test("a POST without the CSRF field is refused", async () => {
  const harness = await startHarness();
  const cookie = await harness.signIn();
  const res = await fetch(`${harness.baseUrl}/settings/logout`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: harness.baseUrl,
      cookie: `__Host-mailmcp_session=${cookie}`,
    },
    body: new URLSearchParams({}),
  });
  assert.equal(res.status, 403);
  await harness.close();
});

test("a cross-origin POST is refused even with a valid CSRF token", async () => {
  const harness = await startHarness();
  const cookie = await harness.signIn();
  const csrf = extractCsrf(await (await getSettings(harness, cookie)).text());
  const res = await fetch(`${harness.baseUrl}/settings/logout`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: "https://evil.example",
      cookie: `__Host-mailmcp_session=${cookie}`,
    },
    body: new URLSearchParams({ _csrf: csrf }),
  });
  assert.equal(res.status, 403);
  await harness.close();
});
```

Add the helpers `signInWith`, `getSettings`, `postAuthorizeForm` and `extractCsrf` to
the harness or to the top of this file; `extractCsrf` is
`/name="_csrf" value="([^"]+)"/.exec(html)?.[1] ?? ""`.

- [ ] **Step 2: Run it and watch it fail**

Run: `cd oauth && node --import tsx --test test/integration/settings-session.test.ts`
Expected: FAIL — `/settings` returns the 404 JSON body.

- [ ] **Step 3: Implement the router and guards**

In `oauth/src/settings-routes.ts`:

```ts
/**
 * The operator-facing routes.
 *
 * Mounted only when a settings signing key is configured. Without one there is
 * nothing the connector would accept for /settings/mailboxes, and a half-mounted UI
 * that can list mailboxes but not reach them is worse than no UI.
 */
```

`requireSession` reads the cookie with `readSessionCookie`, verifies it with
`verifySession` against `operator.sessionEpoch`, and on failure renders the sign-in
page with status 200 rather than redirecting — a redirect to a page that renders a
form is a round trip for nothing. On success it puts the claims in `res.locals.session`
and, for `GET`, re-issues the cookie so the hour becomes an idle timeout.

`requireCsrf` runs `isSameOrigin(req.headers, config.issuer)` and
`csrfMatches(res.locals.session, req.body?.[CSRF_FIELD])`, answering 403 with a short
HTML page if either fails.

`POST /settings/login`:

1. `throttle.isBlocked(req.ip)` → 429 with `Retry-After: throttle.retryAfter(req.ip)`.
2. `isSameOrigin` → 403.
3. `operator.verify(username, password)`. On failure: `throttle.recordFailure(req.ip)`, `log("warn", LOGIN_FAILURE_EVENT, { ip: req.ip, endpoint: "settings" })`, re-render the sign-in page with status 401 and a generic error that does not say which field was wrong.
4. On success: `throttle.recordSuccess(req.ip)`, `newSession(operator.username, operator.sessionEpoch)`, `signSession`, `Set-Cookie`, `303` to `/settings`.

`POST /settings/logout`: clear the cookie; when `all=1`, `await operator.bumpSessionEpoch()` first. 303 to `/settings`.

`GET /settings`: render the overview from `upstreamHealth()`, `Object.keys(store.clients).length` and `Object.keys(store.sessions).length`.

In `app.ts`, after the existing routes and before the 404 handler:

```ts
  if (config.settingsSigningKey !== null && opts.operator) {
    app.use(
      "/settings",
      createSettingsRouter({
        config,
        store,
        operator: opts.operator,
        throttle,
        log,
        upstreamHealth: () => fetchUpstreamHealth(config, log),
      })
    );
  }
```

`CreateAppOptions` gains `operator?: OperatorRecord`. `fetchUpstreamHealth` does a
`GET ${config.upstreamMcpUrl}/health` with a 3-second `AbortSignal.timeout`, returning
`{ reachable: false, version: null, mailboxes: [] }` on any failure — the overview says
so rather than erroring. `index.ts` opens the record and passes it:

```ts
  const operator = await OperatorRecord.open(
    config.operatorFile,
    { username: config.authUsername, passwordHash: config.authPasswordHash },
    log
  );
  const { app } = createApp({ config, store, operator, log });
```

- [ ] **Step 4: Extend the harness**

Give `Harness` an `operator` field and a `signIn()` that performs the login POST and
returns the cookie value. Build the record with `OperatorRecord.open(null, …)` by
default so unit-speed tests do not touch the filesystem, and let `HarnessOptions` pass
a path for the tests that need a writable one. Seed it with the harness's existing
`FAST_SCRYPT` hash of `TEST_PASSWORD`, and set a `SETTINGS_SIGNING_KEY` in the default
config overrides so the router is mounted.

- [ ] **Step 5: Run the test**

Run: `cd oauth && node --import tsx --test test/integration/settings-session.test.ts`
Expected: PASS, all seven cases.

- [ ] **Step 6: Run the whole OAuth suite**

Run: `cd oauth && node --import tsx --test test/unit/*.test.ts test/integration/*.test.ts`
Expected: PASS. The existing 201 + 57 must still pass — in particular the authorization
flow tests, which now share a throttle with a new endpoint.

- [ ] **Step 7: Commit**

```bash
git add oauth/src/settings-routes.ts oauth/src/app.ts oauth/src/index.ts oauth/test/helpers/harness.ts oauth/test/integration/settings-session.test.ts
git commit -m "feat(settings): sign in to the operator UI and hold a session"
```

---

## Task 7: Store support for revocation

Implements the storage half of spec §8. Kept separate from Task 8 so the token change
lands against a store that already has the fields, and so a reviewer can reject one
without the other.

**Files:**
- Modify: `oauth/src/store.ts`
- Test: `oauth/test/unit/store.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `StoreData.tokenEpoch: number`
  - `ClientRecord.revokedAt?: number`
  - `store.tokenEpoch: number`
  - `store.deleteClient(clientId: string): number` — deletes the client and its sessions, returns how many sessions went
  - `store.revokeClient(clientId: string, at: number): void` — marks `revokedAt` and drops its sessions
  - `store.revokeEverything(at: number): void` — bumps `tokenEpoch`, clears sessions, marks every client

- [ ] **Step 1: Write the failing tests**

Append to `oauth/test/unit/store.test.ts`.

```ts
test("a fresh store starts at token epoch zero", async () => {
  const store = await Store.open(null, silentLogger);
  assert.equal(store.tokenEpoch, 0);
});

test("revoking a client drops its sessions and marks it", async () => {
  const store = await Store.open(null, silentLogger);
  store.putClient(clientRecord("c1"));
  store.putSession("s1", session({ clientId: "c1" }));
  store.putSession("s2", session({ clientId: "c2" }));

  store.revokeClient("c1", 1757000000);

  assert.equal(store.getClient("c1")?.revokedAt, 1757000000);
  assert.equal(store.getSession("s1"), undefined);
  assert.ok(store.getSession("s2"), "another client's session is untouched");
});

test("deleting a client removes the record and reports the sessions taken with it", async () => {
  const store = await Store.open(null, silentLogger);
  store.putClient(clientRecord("c1"));
  store.putSession("s1", session({ clientId: "c1" }));
  store.putSession("s2", session({ clientId: "c1" }));
  assert.equal(store.deleteClient("c1"), 2);
  assert.equal(store.getClient("c1"), undefined);
  assert.equal(store.getSession("s1"), undefined);
});

test("revoking everything bumps the epoch and empties the sessions", async () => {
  const store = await Store.open(null, silentLogger);
  store.putClient(clientRecord("c1"));
  store.putSession("s1", session({ clientId: "c1" }));
  store.revokeEverything(1757000000);
  assert.equal(store.tokenEpoch, 1);
  assert.deepEqual(Object.keys(store.sessions), []);
  assert.equal(store.getClient("c1")?.revokedAt, 1757000000);
});

test("a state file written before tokenEpoch existed still loads", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "store-")), "state.json");
  await writeFile(
    path,
    JSON.stringify({ version: 1, clients: {}, sessions: {} }),
    "utf8"
  );
  const store = await Store.open(path, silentLogger);
  assert.equal(store.tokenEpoch, 0, "missing means zero, not a corrupt file");
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `cd oauth && node --import tsx --test test/unit/store.test.ts`
Expected: FAIL — `store.tokenEpoch` is undefined.

- [ ] **Step 3: Implement**

Add `tokenEpoch: number` to `StoreData` and `revokedAt?: number` to `ClientRecord`.
`emptyData()` sets `tokenEpoch: 0`. In `parseData`, accept a missing `tokenEpoch` as 0
rather than rejecting the file — an upgrade must not quarantine everyone's sessions:

```ts
  const tokenEpoch =
    typeof candidate.tokenEpoch === "number" && Number.isInteger(candidate.tokenEpoch)
      ? candidate.tokenEpoch
      : 0;
```

Add the three methods, each ending in `this.save()`.

- [ ] **Step 4: Run the test**

Run: `cd oauth && node --import tsx --test test/unit/store.test.ts`
Expected: PASS, including the existing cases.

- [ ] **Step 5: Commit**

```bash
git add oauth/src/store.ts oauth/test/unit/store.test.ts
git commit -m "feat(oauth): record revocation state alongside clients and sessions"
```

---

## Task 8: Make revocation immediate

Implements the token half of spec §8.

**Files:**
- Modify: `oauth/src/tokens.ts`
- Test: `oauth/test/unit/tokens.test.ts`

**Interfaces:**
- Consumes: Task 7's `store.tokenEpoch`, `ClientRecord.revokedAt`.
- Produces: no signature change. `verifyAccessToken` gains two rejection paths, both reported as the existing `invalid_token`.

- [ ] **Step 1: Write the failing tests**

Append to `oauth/test/unit/tokens.test.ts`.

```ts
test("an access token stops verifying once the token epoch moves", async () => {
  const store = await Store.open(null, silentLogger);
  store.putClient(clientRecord("c1"));
  const issuer = new TokenIssuer(issuerOptions(store));
  const { accessToken } = await issuer.issue(accessClaims({ clientId: "c1" }));

  assert.equal((await issuer.verifyAccessToken(accessToken, RESOURCE)).ok, true);
  store.revokeEverything(Math.floor(Date.now() / 1000));
  const after = await issuer.verifyAccessToken(accessToken, RESOURCE);
  assert.equal(after.ok, false);
});

test("an access token stops verifying once its own client is revoked", async () => {
  const store = await Store.open(null, silentLogger);
  store.putClient(clientRecord("c1"));
  store.putClient(clientRecord("c2"));
  const issuer = new TokenIssuer(issuerOptions(store));
  const first = await issuer.issue(accessClaims({ clientId: "c1" }));
  const second = await issuer.issue(accessClaims({ clientId: "c2" }));

  store.revokeClient("c1", Math.floor(Date.now() / 1000) + 1);

  assert.equal((await issuer.verifyAccessToken(first.accessToken, RESOURCE)).ok, false);
  assert.equal((await issuer.verifyAccessToken(second.accessToken, RESOURCE)).ok, true);
});

test("a token issued after a client was revoked and re-registered is accepted", async () => {
  const store = await Store.open(null, silentLogger);
  store.putClient(clientRecord("c1"));
  const issuer = new TokenIssuer(issuerOptions(store));
  store.revokeClient("c1", Math.floor(Date.now() / 1000) - 60);
  store.putClient(clientRecord("c1"));
  const { accessToken } = await issuer.issue(accessClaims({ clientId: "c1" }));
  assert.equal((await issuer.verifyAccessToken(accessToken, RESOURCE)).ok, true);
});

test("a token minted before the epoch claim existed still verifies", async () => {
  const store = await Store.open(null, silentLogger);
  store.putClient(clientRecord("c1"));
  const issuer = new TokenIssuer(issuerOptions(store));
  const legacy = await new SignJWT({
    token_use: "access",
    client_id: "c1",
    scope: "mcp",
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(ISSUER)
    .setAudience(RESOURCE)
    .setSubject("operator")
    .setIssuedAt()
    .setExpirationTime("1h")
    .setJti("legacy")
    .sign(KEY);
  assert.equal((await issuer.verifyAccessToken(legacy, RESOURCE)).ok, true);
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `cd oauth && node --import tsx --test test/unit/tokens.test.ts`
Expected: FAIL — the first two cases still verify.

- [ ] **Step 3: Implement**

In `#mint`, add `epoch: this.#store.tokenEpoch` to the access token's payload. Refresh
tokens do not need it: a refresh already fails once its session is gone.

In `verifyAccessToken`, after `#verify` succeeds:

```ts
    // A stateless token cannot be withdrawn, so revocation is expressed as two
    // comparisons instead. Without them "revoke" would mean "stops refreshing, keeps
    // working for up to an hour", which is not what the button says.
    const epoch =
      typeof result.payload.epoch === "number" ? result.payload.epoch : 0;
    if (epoch < this.#store.tokenEpoch) {
      return { ok: false, reason: "invalid_token" };
    }
    const client = this.#store.getClient(result.claims.clientId);
    const issuedAt = result.payload.iat;
    if (
      client?.revokedAt !== undefined &&
      typeof issuedAt === "number" &&
      issuedAt < client.revokedAt
    ) {
      return { ok: false, reason: "invalid_token" };
    }
```

A missing `epoch` reads as 0, which equals the initial `tokenEpoch`, so upgrading
invalidates nothing on its own. Comparing `iat` against `revokedAt` rather than
clearing the record means a client that re-registers gets a clean slate without a
special case.

- [ ] **Step 4: Run the tests**

Run: `cd oauth && node --import tsx --test test/unit/tokens.test.ts`
Expected: PASS, existing cases included.

- [ ] **Step 5: Commit**

```bash
git add oauth/src/tokens.ts oauth/test/unit/tokens.test.ts
git commit -m "feat(oauth): make revocation take effect on issued access tokens"
```

---

## Task 9: The clients page, the password page, and the settings proxy

Implements the rest of spec §5.1, §8 and §9, plus the `Cookie` filter from §3.2. Last
task in the OAuth layer; after it, that service is complete and shippable.

**Files:**
- Modify: `oauth/src/settings-routes.ts`
- Modify: `oauth/src/proxy.ts`
- Modify: `oauth/src/app.ts`
- Test: `oauth/test/unit/proxy-headers.test.ts` (create)
- Test: `oauth/test/integration/settings-clients.test.ts` (create)
- Test: `oauth/test/integration/settings-proxy.test.ts` (create)

**Interfaces:**
- Consumes: Tasks 2, 5, 6, 7, 8.
- Produces:
  - `ProxyOptions.upstreamPath?: string | ((req: Request) => string)`
  - `ProxyOptions.extraHeaders?: (req: Request) => Record<string, string>`
  - `HOP_BY_HOP` gains `cookie`

- [ ] **Step 1: Write the failing proxy test**

Create `oauth/test/integration/settings-proxy.test.ts`.

```ts
test("the session cookie never reaches the connector", async () => {
  const harness = await startHarness();
  const cookie = await harness.signIn();
  await fetch(`${harness.baseUrl}/settings/mailboxes`, {
    headers: { cookie: `__Host-mailmcp_session=${cookie}` },
  });
  const forwarded = harness.upstream.requests.at(-1);
  assert.ok(forwarded, "the request reached the upstream");
  assert.equal(forwarded.headers.cookie, undefined, "Cookie must be stripped");
  assert.ok(
    !JSON.stringify(forwarded.headers).includes(cookie),
    "the session token appears in no forwarded header"
  );
});

test("the proxied request carries the static token and a matching assertion", async () => {
  const harness = await startHarness();
  const cookie = await harness.signIn();
  await fetch(`${harness.baseUrl}/settings/mailboxes`, {
    headers: { cookie: `__Host-mailmcp_session=${cookie}` },
  });
  const forwarded = harness.upstream.requests.at(-1)!;
  assert.equal(forwarded.headers.authorization, `Bearer ${UPSTREAM_TOKEN}`);
  const assertionHeader = forwarded.headers["x-settings-assertion"];
  assert.equal(typeof assertionHeader, "string");
  const payload = JSON.parse(
    Buffer.from((assertionHeader as string).split(".")[0], "base64url").toString("utf8")
  );
  assert.equal(payload.htm, "GET");
  assert.equal(payload.htu, "/settings/mailboxes");
  assert.equal(payload.aud, "mail-mcp-settings");
});

test("an unauthenticated settings request never reaches the connector", async () => {
  const harness = await startHarness();
  const before = harness.upstream.requests.length;
  const res = await fetch(`${harness.baseUrl}/settings/mailboxes`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /name="password"/);
  assert.equal(harness.upstream.requests.length, before, "nothing was forwarded");
});

test("a MCP request is unaffected by the cookie filter", async () => {
  const harness = await startHarness();
  const token = await completeAuthorizationFlow(harness);
  await fetch(`${harness.baseUrl}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      cookie: "unrelated=1",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  const forwarded = harness.upstream.requests.at(-1)!;
  assert.equal(forwarded.headers.cookie, undefined);
  assert.equal(forwarded.headers["x-settings-assertion"], undefined);
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `cd oauth && node --import tsx --test test/integration/settings-proxy.test.ts`
Expected: FAIL — `/settings/mailboxes` is not routed anywhere.

- [ ] **Step 3: Implement the proxy changes**

Add `"cookie"` to `HOP_BY_HOP` with the reason:

```ts
  // Not hop-by-hop in the RFC sense, but never forwarded for the same practical
  // reason: the operator's session cookie is scoped to Path=/ by the __Host- prefix
  // and would otherwise be sent upstream. The connector authenticates settings
  // requests by assertion alone and must never be able to read browser state.
  "cookie",
```

Widen `upstreamPath` to `string | ((req: Request) => string)` and resolve it per
request. Add `extraHeaders?: (req: Request) => Record<string, string>`, applied after
the authorization substitution so it cannot overwrite it.

In `app.ts`, create a second proxy for settings, mounted after `requireSession` so an
unauthenticated request is answered locally and never forwarded:

```ts
    const settingsProxy = createProxy({
      upstreamUrl: config.upstreamMcpUrl,
      upstreamAuthToken: config.upstreamAuthToken,
      upstreamPath: (req) => `/settings/mailboxes${req.path === "/" ? "" : req.path}`,
      extraHeaders: (req) => ({
        [ASSERTION_HEADER]: signAssertion(
          {
            sub: req.res!.locals.session.sub,
            sid: req.res!.locals.session.sid,
            csrf: req.res!.locals.session.csrf,
            method: req.method,
            path: `/settings/mailboxes${req.path === "/" ? "" : req.path}`,
          },
          config.settingsSigningKey!,
          config.issuer
        ),
      }),
      log,
    });
```

Note the path is computed once per request in both places from the same expression;
if they disagree the connector rejects the assertion, which is the failure mode you
want rather than a silent mismatch.

- [ ] **Step 4: Write and implement the clients page**

Create `oauth/test/integration/settings-clients.test.ts`:

```ts
test("revoking a client ends its session and its access token at once", async () => {
  const harness = await startHarness();
  const { accessToken, refreshToken, clientId } = await completeAuthorizationFlow(harness);
  const cookie = await harness.signIn();
  const csrf = extractCsrf(await (await getClients(harness, cookie)).text());

  const res = await postForm(harness, "/settings/clients/revoke", cookie, {
    _csrf: csrf,
    client_id: clientId,
  });
  assert.equal(res.status, 303);

  const mcp = await fetch(`${harness.baseUrl}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assert.equal(mcp.status, 401, "the access token dies with the client, not an hour later");

  const refresh = await postTokenRefresh(harness, refreshToken, clientId);
  assert.equal(refresh.status, 400);
});

test("the clients page lists nothing sensitive", async () => {
  const harness = await startHarness();
  const { accessToken, refreshToken } = await completeAuthorizationFlow(harness);
  const cookie = await harness.signIn();
  const body = await (await getClients(harness, cookie)).text();
  assert.ok(!body.includes(accessToken));
  assert.ok(!body.includes(refreshToken));
  assert.ok(!body.includes(UPSTREAM_TOKEN));
});
```

Implement `GET /settings/clients` and `POST /settings/clients/revoke` behind
`requireSession` and `requireCsrf`, dispatching on the submitted field: `client_id` →
`store.revokeClient`, `sid` → `store.deleteSession`, `all=1` → `store.revokeEverything`.
Then 303 back to `/settings/clients`.

- [ ] **Step 5: Implement the password page**

`GET /settings/password` renders `renderPasswordChange`, passing
`disabledReason: "OPERATOR_FILE is set to none"` when `!operator.canChangePassword`.
`POST /settings/password`, behind `requireSession` and `requireCsrf`:

1. Refuse with 409 when `!operator.canChangePassword`.
2. `throttle.isBlocked(req.ip)` → 429.
3. `operator.verify(operator.username, current_password)` → on failure record it, log `LOGIN_FAILURE_EVENT`, re-render with 401.
4. `new_password !== confirm_password`, or shorter than 12 characters → re-render with an error, no throttle hit; this is a typo, not an attack.
5. `await operator.changePassword(next)`, which bumps `sessionEpoch` and so invalidates the current cookie too.
6. When `disconnect_clients` is checked, `store.revokeEverything(now)`.
7. Clear the cookie and 303 to `/settings`, which now shows the sign-in form.

- [ ] **Step 6: Run everything in the OAuth package**

Run: `cd oauth && node --import tsx --test test/unit/*.test.ts test/integration/*.test.ts`
Expected: PASS.

- [ ] **Step 7: Verify on Node 24**

Run the container command from "Verifying on Node 24".
Expected: both packages typecheck and their unit suites pass.

- [ ] **Step 8: Commit**

```bash
git add oauth/src/settings-routes.ts oauth/src/proxy.ts oauth/src/app.ts oauth/test/
git commit -m "feat(settings): review and revoke clients, change the operator password"
```

---

## Task 10: The connector's assertion guard

Implements the connector half of spec §4. Task 2 wrote the verifier; this wires it into
Express.

**Files:**
- Modify: `src/settings-assertion.ts`
- Test: `test/unit/settings-assertion.test.ts` (extend)

**Interfaces:**
- Consumes: `verifyAssertion` (Task 2), `config.settingsSigningKey` (Task 1).
- Produces: `requireSettingsAssertion(opts: { key: string; issuer: string; log: Logger }): RequestHandler`, attaching `res.locals.assertion: VerifiedAssertion`.

- [ ] **Step 1: Write the failing test**

Append to `test/unit/settings-assertion.test.ts`. Drive the middleware with fake
request and response objects rather than a server; the full path is covered in Task 14.

```ts
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
```

- [ ] **Step 2: Run and watch it fail**

Run: `node --import tsx --test test/unit/settings-assertion.test.ts`
Expected: FAIL — `requireSettingsAssertion` is not exported.

- [ ] **Step 3: Implement**

```ts
/**
 * Express guard for the settings routes.
 *
 * Two credentials must hold to reach a mailbox through here: the static AUTH_TOKEN
 * that already gates /mcp, checked by the existing bearer middleware, and this
 * assertion. The bearer proves the request came from the OAuth layer; the assertion
 * proves a human signed in there moments ago, for this method and this path.
 *
 * Every failure answers the same 401 with the same body. Telling the caller whether
 * the signature, the expiry or the path was wrong would help nobody who is supposed
 * to be here.
 */
export function requireSettingsAssertion(opts: {
  key: string;
  issuer: string;
  log: Logger;
}): RequestHandler {
  const key = new TextEncoder().encode(opts.key);
  return (req, res, next) => {
    const header = req.header(ASSERTION_HEADER);
    const verified =
      header === undefined
        ? null
        : verifyAssertion(header, key, opts.issuer, req.method, req.path);
    if (verified === null) {
      opts.log("warn", "rejected settings request", { ip: req.ip, path: req.path });
      res.status(401).type("text/plain").send("Unauthorized");
      return;
    }
    res.locals.assertion = verified;
    next();
  };
}
```

`req.path` on a mounted router excludes the mount prefix, so mount the router at `/`
and give the routes their full `/settings/mailboxes/...` paths — otherwise `htu` will
not match what the OAuth layer signed. Task 14 depends on this.

- [ ] **Step 4: Run the test**

Run: `node --import tsx --test test/unit/settings-assertion.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/settings-assertion.ts test/unit/settings-assertion.test.ts
git commit -m "feat(settings): guard the connector's settings routes"
```

---

## Task 11: Writing accounts.json

Implements spec §6.2. The highest-risk task in the plan: it is the only code in this
repository that writes mailbox credentials.

**Files:**
- Create: `src/accounts-writer.ts`
- Modify: `src/accounts.ts`
- Test: `test/unit/accounts-writer.test.ts`

**Interfaces:**
- Consumes: `Account`, `AccountsFile` from `./accounts.js`.
- Produces:
  - `parseAccountsFile` exported from `src/accounts.ts`
  - `writeAccountsFile(path: string, file: AccountsFile): Promise<void>` in the writer
  - `readStamp(path: string): Promise<string>` — `"<size>-<mtimeMs>"`, `"absent"` when missing
  - `AccountsStore` methods: `create(account: Account, stamp: string): Promise<void>`, `update(id: string, account: Account, stamp: string): Promise<void>`, `remove(id: string, stamp: string): Promise<void>`, `setDefault(id: string, stamp: string): Promise<void>`, `stamp(): Promise<string>`
  - `class StaleStampError extends Error`

- [ ] **Step 1: Write the failing tests**

Create `test/unit/accounts-writer.test.ts`.

```ts
test("a written file is valid input to the parser", async () => {
  const path = await tempAccounts();
  const store = new AccountsStore(path);
  await store.start();
  await store.create(sampleAccount("work"), await store.stamp());

  const reread = new AccountsStore(path);
  await reread.start();
  assert.deepEqual(reread.ids(), ["work"]);
  assert.equal(reread.resolve("work").imap.pass, "imap-secret");
});

test("the in-memory store is current without waiting for the watcher", async () => {
  const store = new AccountsStore(await tempAccounts());
  await store.start();
  await store.create(sampleAccount("work"), await store.stamp());
  assert.deepEqual(store.ids(), ["work"], "no sleep, no fs.watch");
});

test("the file is written 0600 and no temp file is left behind", async () => {
  const path = await tempAccounts();
  const store = new AccountsStore(path);
  await store.start();
  await store.create(sampleAccount("work"), await store.stamp());
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  const leftovers = (await readdir(dirname(path))).filter((n) => n.endsWith(".tmp"));
  assert.deepEqual(leftovers, []);
});

test("a mutation that would produce an unreadable file leaves the old one intact", async () => {
  const path = await tempAccounts();
  const store = new AccountsStore(path);
  await store.start();
  await store.create(sampleAccount("work"), await store.stamp());
  const before = await readFile(path, "utf8");

  const broken = { ...sampleAccount("second"), imap: { ...sampleAccount("second").imap, port: 0 } };
  await assert.rejects(() => store.create(broken as never, await store.stamp()));

  assert.equal(await readFile(path, "utf8"), before);
  assert.deepEqual(store.ids(), ["work"], "memory did not move either");
});

test("a duplicate id is refused", async () => {
  const store = new AccountsStore(await tempAccounts());
  await store.start();
  await store.create(sampleAccount("work"), await store.stamp());
  await assert.rejects(() => store.create(sampleAccount("work"), await store.stamp()), /work/);
});

test("updating an unknown id is refused", async () => {
  const store = new AccountsStore(await tempAccounts());
  await store.start();
  await assert.rejects(() => store.update("ghost", sampleAccount("ghost"), await store.stamp()));
});

test("setDefault moves the flag rather than adding a second one", async () => {
  const store = new AccountsStore(await tempAccounts());
  await store.start();
  await store.create({ ...sampleAccount("work"), default: true }, await store.stamp());
  await store.create(sampleAccount("home"), await store.stamp());
  await store.setDefault("home", await store.stamp());
  assert.equal(store.list().filter((a) => a.default).length, 1);
  assert.equal(store.resolve().id, "home");
});

test("a stale stamp is refused instead of clobbering the other edit", async () => {
  const path = await tempAccounts();
  const store = new AccountsStore(path);
  await store.start();
  const stamp = await store.stamp();

  await writeFile(path, JSON.stringify({ version: 1, accounts: [sampleAccount("byhand")] }), "utf8");

  await assert.rejects(
    () => store.create(sampleAccount("work"), stamp),
    (err: Error) => err.name === "StaleStampError"
  );
});

test("removing the last account leaves a valid empty file", async () => {
  const path = await tempAccounts();
  const store = new AccountsStore(path);
  await store.start();
  await store.create(sampleAccount("work"), await store.stamp());
  await store.remove("work", await store.stamp());
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { version: 1, accounts: [] });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `node --import tsx --test test/unit/accounts-writer.test.ts`
Expected: FAIL — `store.create` is not a function.

- [ ] **Step 3: Implement `src/accounts-writer.ts`**

```ts
/**
 * Writing accounts.json.
 *
 * This is the only code in the repository that writes mailbox credentials, and the
 * file it writes is read by a process that hot-reloads it. Two properties matter
 * more than anything else here:
 *
 * 1. A reader never sees a partial file. The write goes to a sibling temp file and
 *    is renamed into place, which is atomic within a directory. The temp file is
 *    created 0600, so the credentials are never briefly world-readable.
 * 2. The connector never writes a file it would refuse to read. The serialised text
 *    is handed back to the same parser the loader uses, and only a clean parse is
 *    allowed to reach the rename.
 */

import { randomUUID } from "node:crypto";
import { open, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { type AccountsFile, parseAccountsFile } from "./accounts.js";

/** Identifies the on-disk version a form was rendered from. */
export async function readStamp(path: string): Promise<string> {
  try {
    const info = await stat(path);
    return `${info.size}-${info.mtimeMs}`;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw err;
  }
}

export class StaleStampError extends Error {
  constructor() {
    super(
      "accounts.json changed on disk since this form was opened. " +
        "Review the current contents and submit again."
    );
    this.name = "StaleStampError";
  }
}

export async function writeAccountsFile(path: string, file: AccountsFile): Promise<void> {
  const serialised = `${JSON.stringify(file, null, 2)}\n`;

  // The round trip. If this throws, nothing has touched the real file yet.
  parseAccountsFile(serialised);

  const temp = join(dirname(path), `.${randomUUID()}.tmp`);
  try {
    await writeFile(temp, serialised, { encoding: "utf8", mode: 0o600 });
    // fsync before rename: a crash between the two would otherwise leave a file
    // that exists but has no contents, and mailbox credentials are not something
    // to lose to a power cut.
    const handle = await open(temp, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, path);
  } catch (err) {
    await unlink(temp).catch(() => {});
    throw err;
  }
}
```

- [ ] **Step 4: Implement the store methods**

In `src/accounts.ts`, export `parseAccountsFile` and add a `#writeChain` so two
submissions cannot interleave. Each mutation follows the same shape:

```ts
  async create(account: Account, stamp: string): Promise<void> {
    await this.#mutate(stamp, (accounts) => {
      if (accounts.some((a) => a.id === account.id)) {
        throw new AccountsStoreError(`An account with id "${account.id}" already exists.`);
      }
      return [...accounts, account];
    });
  }
```

with the shared step:

```ts
  async #mutate(
    stamp: string,
    change: (accounts: Account[]) => Account[]
  ): Promise<void> {
    this.#writeChain = this.#writeChain.then(async () => {
      // Re-read rather than trusting memory: a hand edit since the last load is a
      // change the operator meant, and the stamp check is what tells them apart.
      const current = await readStamp(this.filePath);
      if (current !== stamp) throw new StaleStampError();
      await this.reload();

      const next = change(this.accounts);
      const file: AccountsFile = { version: 1, accounts: next };
      await writeAccountsFile(this.filePath, file);

      this.accounts = next;
      this.byId = new Map(next.map((a) => [a.id, a]));
    });
    return this.#writeChain;
  }
```

Note the ordering: memory is updated only after the rename returns, so a failed write
leaves both the file and the in-memory list untouched. `setDefault` clears `default` on
every account before setting it on one. `stamp()` is `readStamp(this.filePath)`.

- [ ] **Step 5: Run the test**

Run: `node --import tsx --test test/unit/accounts-writer.test.ts`
Expected: PASS, all nine cases.

- [ ] **Step 6: Run the whole connector unit suite**

Run: `node --import tsx --test test/unit/*.test.ts`
Expected: PASS. `accounts.test.ts` in particular, which covers the parser this now
depends on twice.

- [ ] **Step 7: Commit**

```bash
git add src/accounts.ts src/accounts-writer.ts test/unit/accounts-writer.test.ts
git commit -m "feat(settings): write accounts.json atomically and validated"
```

---

## Task 12: The connection test

Implements spec §7.

**Files:**
- Create: `src/probe.ts`
- Test: `test/unit/probe.test.ts`
- Test: `test/integration/probe.test.ts`

**Interfaces:**
- Consumes: `ImapCreds`, `SmtpCreds`, `CalDavCreds` from `./accounts.js`.
- Produces:
  - `probeAccount(input: ProbeInput, opts?: { perProbeMs?: number; totalMs?: number }): Promise<ProbeReport>`
  - `ProbeInput = { imap: ImapCreds; smtp: SmtpCreds; caldav?: CalDavCreds }`
  - `ProbeReport = { imap: ProbeResult; smtp: ProbeResult; caldav: ProbeResult | null }`
  - `ProbeResult = { ok: true } | { ok: false; message: string }`
  - `PER_PROBE_TIMEOUT_MS = 10_000`, `TOTAL_TIMEOUT_MS = 25_000`, `MAX_MESSAGE_LENGTH = 200`

- [ ] **Step 1: Write the failing unit test**

Create `test/unit/probe.test.ts`. Point the probes at a closed port; this needs no
fixture and runs offline.

```ts
test("a closed port fails within the per-probe timeout", async () => {
  const started = Date.now();
  const report = await probeAccount(
    { imap: creds({ port: 1 }), smtp: creds({ port: 1 }) },
    { perProbeMs: 2000, totalMs: 5000 }
  );
  assert.equal(report.imap.ok, false);
  assert.equal(report.smtp.ok, false);
  assert.ok(Date.now() - started < 5000);
});

test("failure messages are bounded and carry no password", async () => {
  const report = await probeAccount(
    { imap: creds({ port: 1, pass: "hunter2-very-secret" }), smtp: creds({ port: 1 }) },
    { perProbeMs: 2000, totalMs: 5000 }
  );
  assert.equal(report.imap.ok, false);
  if (report.imap.ok) return;
  assert.ok(report.imap.message.length <= MAX_MESSAGE_LENGTH);
  assert.ok(!report.imap.message.includes("hunter2"));
});

test("CalDAV is skipped when no URL is configured", async () => {
  const report = await probeAccount(
    { imap: creds({ port: 1 }), smtp: creds({ port: 1 }) },
    { perProbeMs: 1000, totalMs: 3000 }
  );
  assert.equal(report.caldav, null);
});

test("the three probes run concurrently, not one after another", async () => {
  const started = Date.now();
  await probeAccount(
    {
      imap: creds({ port: 1 }),
      smtp: creds({ port: 1 }),
      caldav: { url: "http://127.0.0.1:1/dav", user: "u", pass: "p" },
    },
    { perProbeMs: 2000, totalMs: 6000 }
  );
  assert.ok(Date.now() - started < 4000, "three sequential 2s probes would exceed this");
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `node --import tsx --test test/unit/probe.test.ts`
Expected: FAIL — cannot find module `../../src/probe.js`.

- [ ] **Step 3: Implement `src/probe.ts`**

```ts
/**
 * One-shot connection tests for credentials that have not been saved yet.
 *
 * Deliberately not built on ClientPool. The pool exists to keep connections warm for
 * configured accounts; running a test through it would cache credentials the operator
 * may be about to discard, and a failed test would poison the pool for an account
 * that still works. Everything here is created for one probe and torn down.
 *
 * Every probe is bounded twice — per probe and in total — because the host on the
 * other end is whatever the operator typed. An unreachable address must fail the form
 * submission quickly, not hold a request open until the proxy gives up on it.
 */
```

`probeAccount` runs the three probes with `Promise.all`, each wrapped in
`withTimeout(promise, ms, label)` that rejects with `` `${label} timed out after ${ms}ms` ``,
and the whole thing wrapped in the total bound. Each probe:

- **IMAP** — `new ImapFlow({ host, port, secure: tls, auth: { user, pass }, logger: false })`, `connect()`, then `logout()` in a `finally`.
- **SMTP** — `nodemailer.createTransport({ host, port, secure: tls, auth: { user, pass } })`, `verify()`, then `close()`.
- **CalDAV** — `createDAVClient({ serverUrl: url, credentials: { username: user, password: pass }, authMethod: "Basic", defaultAccountType: "caldav" })`, then `fetchCalendars()`.

All three signatures were re-verified against the versions installed by the 0.5.0
refresh (imapflow 2, nodemailer 10, tsdav 2.3) and are unchanged from the versions
this plan was written against.

Failures are converted by `describe(err)`, which takes `err.message`, collapses
whitespace, truncates to `MAX_MESSAGE_LENGTH` and appends `…`. It never interpolates
credentials; the tests assert that.

One thing worth using that imapflow 2 added: it exports an `AuthenticationFailure`
error class. Check for it before falling through to `describe(err)`, and report
"the server rejected these credentials" rather than whatever the provider's wording
happens to be. Wrong password and unreachable host are the two outcomes an operator
needs told apart, and they are the two this distinction gets right.

- [ ] **Step 4: Run the unit test**

Run: `node --import tsx --test test/unit/probe.test.ts`
Expected: PASS.

- [ ] **Step 5: Write and run the integration test**

Create `test/integration/probe.test.ts` against the GreenMail fixture, following the
skip-when-Docker-is-absent pattern already in `test/integration/mail-server.test.ts`.

```ts
test("correct credentials against GreenMail report success", async () => {
  const report = await probeAccount({ imap: greenmailImap(), smtp: greenmailSmtp() });
  assert.deepEqual(report.imap, { ok: true });
  assert.deepEqual(report.smtp, { ok: true });
});

test("a wrong password reports failure, not success", async () => {
  const report = await probeAccount({
    imap: { ...greenmailImap(), pass: "wrong" },
    smtp: greenmailSmtp(),
  });
  assert.equal(report.imap.ok, false);
});
```

Run: `node --import tsx --test test/integration/probe.test.ts`
Expected: PASS, or a clean skip when the Docker daemon is unreachable.

- [ ] **Step 6: Commit**

```bash
git add src/probe.ts test/unit/probe.test.ts test/integration/probe.test.ts
git commit -m "feat(settings): test mailbox credentials before saving them"
```

---

## Task 13: Mailbox page rendering

Implements spec §6.1. Pure functions, and the home of the rule that no stored password
reaches the HTML.

**Files:**
- Create: `src/settings-pages.ts`
- Test: `test/unit/settings-pages.test.ts`

**Interfaces:**
- Consumes: `Account` from `./accounts.js`; `ProbeReport` from `./probe.js`.
- Produces:
  - `renderMailboxList(opts: { csrf: string; accounts: Account[]; stamp: string; notice?: string }): string`
  - `renderMailboxForm(opts: MailboxFormData): string` where `MailboxFormData = { csrf: string; stamp: string; account: Account | null; values?: Record<string, string>; errors?: Record<string, string>; probe?: ProbeReport }`
  - `escapeHtml(value: string): string`

- [ ] **Step 1: Write the failing test**

Create `test/unit/settings-pages.test.ts`. The first case is the requirement the spec
calls out by name.

```ts
test("no stored password reaches the rendered form", () => {
  const account = {
    ...sampleAccount("work"),
    imap: { ...sampleAccount("work").imap, pass: "imap-plaintext-secret" },
    smtp: { ...sampleAccount("work").smtp, pass: "smtp-plaintext-secret" },
    caldav: { url: "https://dav.example.com", user: "u", pass: "caldav-plaintext-secret" },
  };
  const html = renderMailboxForm({ csrf: "c", stamp: "1-2", account });
  for (const secret of [
    "imap-plaintext-secret",
    "smtp-plaintext-secret",
    "caldav-plaintext-secret",
  ]) {
    assert.ok(!html.includes(secret), `${secret} must not appear anywhere in the page`);
  }
});

test("password inputs render empty and say what empty means", () => {
  const html = renderMailboxForm({ csrf: "c", stamp: "1-2", account: sampleAccount("work") });
  const inputs = html.match(/<input[^>]*type="password"[^>]*>/g) ?? [];
  assert.ok(inputs.length >= 2);
  for (const input of inputs) {
    assert.match(input, /value=""/);
    assert.match(input, /placeholder="unchanged"/);
    assert.match(input, /autocomplete="new-password"/);
  }
});

test("the list page never renders a password either", () => {
  const html = renderMailboxList({
    csrf: "c",
    stamp: "1-2",
    accounts: [{ ...sampleAccount("work"), imap: { ...sampleAccount("work").imap, pass: "listed-secret" } }],
  });
  assert.ok(!html.includes("listed-secret"));
});

test("the stamp travels in every form so a concurrent edit is caught", () => {
  const html = renderMailboxForm({ csrf: "c", stamp: "42-99", account: null });
  assert.match(html, /name="_stamp" value="42-99"/);
});

test("removing CalDAV is its own checkbox, not an emptied field", () => {
  const html = renderMailboxForm({
    csrf: "c",
    stamp: "1-2",
    account: { ...sampleAccount("work"), caldav: { url: "https://dav", user: "u", pass: "p" } },
  });
  assert.match(html, /type="checkbox"[^>]*name="remove_caldav"/);
});

test("labels and errors are escaped", () => {
  const html = renderMailboxForm({
    csrf: "c",
    stamp: "1-2",
    account: { ...sampleAccount("work"), label: '<script>alert(1)</script>' },
    errors: { "imap.host": '<b>bad</b>' },
  });
  assert.ok(!html.includes("<script>alert(1)</script>"));
  assert.ok(!html.includes("<b>bad</b>"));
  assert.match(html, /&lt;script&gt;/);
});

test("a probe report renders per service and does not save anything", () => {
  const html = renderMailboxForm({
    csrf: "c",
    stamp: "1-2",
    account: sampleAccount("work"),
    probe: { imap: { ok: true }, smtp: { ok: false, message: "auth failed" }, caldav: null },
  });
  assert.match(html, /IMAP[\s\S]*?(ok|success)/i);
  assert.match(html, /auth failed/);
  assert.match(html, /not saved/i);
});

test("no page carries a script tag or an inline handler", () => {
  for (const html of [
    renderMailboxList({ csrf: "c", stamp: "1-2", accounts: [sampleAccount("work")] }),
    renderMailboxForm({ csrf: "c", stamp: "1-2", account: null }),
  ]) {
    assert.ok(!/<script/i.test(html));
    assert.ok(!/\son[a-z]+\s*=/i.test(html));
  }
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `node --import tsx --test test/unit/settings-pages.test.ts`
Expected: FAIL — cannot find module `../../src/settings-pages.js`.

- [ ] **Step 3: Implement `src/settings-pages.ts`**

Copy the `escapeHtml` implementation and the visual language from
`oauth/src/login.ts` — the packages cannot share a module, so this is a deliberate
duplicate and the file's header comment says so and names the other copy.

The form renders, in order: id (readonly when editing, because it is the key), label,
default checkbox, IMAP host/port/user/password/tls, SMTP host/port/user/password/tls,
mail defaults (from, from name, drafts folder, sent folder), and an optional CalDAV
group with url/user/password plus the `remove_caldav` checkbox when the account has
one. Hidden fields: `_csrf` and `_stamp`.

Two submit buttons:

```html
<button type="submit" name="_action" value="save">Save</button>
<button type="submit" formaction="/settings/mailboxes/work/test" name="_action" value="test">
  Test connection
</button>
```

`formaction` is what keeps the test out of the save path without a line of JavaScript.
Above the form, when `probe` is present, one row per service reading "IMAP — ok" or
"IMAP — failed: <message>", followed by the sentence "Nothing was saved. Press Save to
store these values."

- [ ] **Step 4: Run the test**

Run: `node --import tsx --test test/unit/settings-pages.test.ts`
Expected: PASS, all eight cases.

- [ ] **Step 5: Commit**

```bash
git add src/settings-pages.ts test/unit/settings-pages.test.ts
git commit -m "feat(settings): render the mailbox list and editor"
```

---

## Task 14: The connector's settings routes

Implements spec §5.2 and §6, joining Tasks 10 to 13.

**Files:**
- Create: `src/settings-routes.ts`
- Modify: `src/app.ts`
- Modify: `src/index.ts`
- Test: `test/integration/settings-mailboxes.test.ts`

**Interfaces:**
- Consumes: Tasks 10, 11, 12, 13.
- Produces: `createSettingsRouter(deps: { store: AccountsStore; issuer: string; settingsKey: string; log: Logger }): express.Router`; `CreateAppOptions` gains `settingsSigningKey?: string` and `publicUrl: string`.

- [ ] **Step 1: Write the failing integration test**

Create `test/integration/settings-mailboxes.test.ts`. Build the app with `createApp`
against a temporary accounts file and mint assertions in the test with the same HMAC
the OAuth layer uses.

```ts
test("a settings request without an assertion is refused", async () => {
  const { url } = await startConnector();
  const res = await fetch(`${url}/settings/mailboxes`, {
    headers: { authorization: `Bearer ${AUTH_TOKEN}` },
  });
  assert.equal(res.status, 401);
});

test("a settings request without the bearer token is refused", async () => {
  const { url } = await startConnector();
  const res = await fetch(`${url}/settings/mailboxes`, {
    headers: { [ASSERTION_HEADER]: mint("GET", "/settings/mailboxes") },
  });
  assert.equal(res.status, 401);
});

test("an assertion signed with the wrong key is refused", async () => {
  const { url } = await startConnector();
  const res = await get(url, "/settings/mailboxes", mint("GET", "/settings/mailboxes", OTHER_KEY));
  assert.equal(res.status, 401);
});

test("an assertion bound to another path is refused", async () => {
  const { url } = await startConnector();
  const res = await get(url, "/settings/mailboxes", mint("GET", "/settings/mailboxes/work"));
  assert.equal(res.status, 401);
});

test("an expired assertion is refused", async () => {
  const { url } = await startConnector();
  const res = await get(url, "/settings/mailboxes", mintExpired("GET", "/settings/mailboxes"));
  assert.equal(res.status, 401);
});

test("a POST without the CSRF field is refused", async () => {
  const { url } = await startConnector();
  const res = await post(url, "/settings/mailboxes", { id: "work" }, { csrf: "" });
  assert.equal(res.status, 403);
});

test("a POST whose CSRF field disagrees with the assertion is refused", async () => {
  const { url } = await startConnector();
  const res = await post(url, "/settings/mailboxes", { _csrf: "not-the-one", id: "work" });
  assert.equal(res.status, 403);
});

test("create, edit, make default and delete round-trip through the real app", async () => {
  const { url, accountsPath } = await startConnector();

  const created = await post(url, "/settings/mailboxes", validForm({ id: "work" }));
  assert.equal(created.status, 303);
  assert.deepEqual(JSON.parse(await readFile(accountsPath, "utf8")).accounts.length, 1);

  const edited = await post(url, "/settings/mailboxes/work", validForm({ id: "work", label: "Renamed" }));
  assert.equal(edited.status, 303);
  const afterEdit = JSON.parse(await readFile(accountsPath, "utf8"));
  assert.equal(afterEdit.accounts[0].label, "Renamed");
  assert.equal(
    afterEdit.accounts[0].imap.pass,
    "imap-secret",
    "an empty password field keeps the stored one"
  );

  const removed = await post(url, "/settings/mailboxes/work/delete", { _csrf: CSRF, _stamp: await stamp() });
  assert.equal(removed.status, 303);
  assert.deepEqual(JSON.parse(await readFile(accountsPath, "utf8")).accounts, []);
});

test("the edit page shows no stored password even end to end", async () => {
  const { url } = await startConnector();
  await post(url, "/settings/mailboxes", validForm({ id: "work" }));
  const page = await (await get(url, "/settings/mailboxes/work", mint("GET", "/settings/mailboxes/work"))).text();
  assert.ok(!page.includes("imap-secret"));
});

test("a stale stamp is reported rather than clobbering", async () => {
  const { url, accountsPath } = await startConnector();
  const stale = await stamp();
  await writeFile(accountsPath, JSON.stringify({ version: 1, accounts: [] }), "utf8");
  const res = await post(url, "/settings/mailboxes", validForm({ id: "work", _stamp: stale }));
  assert.equal(res.status, 409);
  assert.match(await res.text(), /changed on disk/i);
});

test("a test submission probes without writing", async () => {
  const { url, accountsPath } = await startConnector();
  const res = await post(url, "/settings/mailboxes/test", validForm({ id: "work", imapPort: "1", smtpPort: "1" }));
  assert.equal(res.status, 200);
  assert.match(await res.text(), /not saved/i);
  assert.deepEqual(JSON.parse(await readFile(accountsPath, "utf8")).accounts, []);
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `node --import tsx --test test/integration/settings-mailboxes.test.ts`
Expected: FAIL — every route 404s.

- [ ] **Step 3: Implement the router**

`src/settings-routes.ts` mounts `express.urlencoded({ extended: false, limit: "64kb" })`
on its own routes only. The existing global `express.json()` in `app.ts` ignores
form-encoded bodies, so it needs no change.

Each route is declared with its full path so `req.path` matches the `htu` the OAuth
layer signed — see Task 10.

`requireFormCsrf` compares `req.body._csrf` against `res.locals.assertion.csrf` with a
constant-time comparison, answering 403. This is the connector checking CSRF without
ever having seen the cookie.

`formToAccount(body, existing)` builds an `Account`, applying the merge rule:

```ts
/**
 * A blank password field means "keep the stored one", which is the whole reason the
 * form can be rendered without ever emitting a password. On create there is nothing
 * to keep, so blank is an error instead.
 */
function mergedPassword(submitted: string, stored: string | undefined, field: string): string {
  if (submitted !== "") return submitted;
  if (stored !== undefined) return stored;
  throw new FormError(field, "Required.");
}
```

Validation collects `FormError`s into an `errors` record and re-renders the form with
status 400 and the submitted values, minus every password. Success writes through the
Task 11 methods and answers 303 to `/settings/mailboxes`. `StaleStampError` becomes a
409 with the form re-rendered. The two test routes call `probeAccount` and re-render
with `probe` set, status 200, writing nothing.

In `src/app.ts`:

```ts
  if (opts.settingsSigningKey) {
    app.use(
      bearerAuth,
      createSettingsRouter({
        store,
        issuer: opts.publicUrl,
        settingsKey: opts.settingsSigningKey,
        log,
      })
    );
  }
```

`index.ts` passes `settingsSigningKey: config.settingsSigningKey` and
`publicUrl: config.publicUrl`. The issuer must equal the OAuth layer's `PUBLIC_URL`, or
every assertion fails the `iss` check — Task 15 documents that.

- [ ] **Step 4: Run the test**

Run: `node --import tsx --test test/integration/settings-mailboxes.test.ts`
Expected: PASS, all eleven cases.

- [ ] **Step 5: Run both suites and typecheck**

Run: `npm run typecheck && npm run typecheck:test && node --import tsx --test test/unit/*.test.ts test/integration/*.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/settings-routes.ts src/app.ts src/index.ts test/integration/settings-mailboxes.test.ts
git commit -m "feat(settings): manage mailboxes from the browser"
```

---

## Task 15: Deployment and the promises in the code

Implements spec §10, and retires the three error strings that started this.

**Files:**
- Modify: `docker-compose.yml`
- Modify: `.env.example`, `.env.docker.example`, `oauth/.env.example`
- Modify: `src/accounts.ts` (the `NoSuchAccountError` message), `src/tools-mail.ts:56`, `src/tools-calendar.ts:44`
- Test: `test/unit/accounts.test.ts` (adjust the message assertion if one exists)

- [ ] **Step 1: Update `docker-compose.yml`**

Drop `:ro` from the connector's volume and explain why the direction reversed:

```yaml
    volumes:
      # Writable since the settings UI: the connector is the only process that
      # writes accounts.json, and it is the one that already reads the credentials
      # in it. The directory must be writable by uid 100 too, not just the file —
      # saving renames a temp file into place. See docs/planning/specs/
      # 2026-09-08-settings-ui-design.md §10.
      - ./data:/data
```

Add `settings_signing_key` to both services' `secrets:` lists, `SETTINGS_SIGNING_KEY_FILE`
to both `environment:` blocks, and the secret definition:

```yaml
  settings_signing_key:
    file: ./secrets/settings_signing_key.txt
```

with a comment naming its generator, `openssl rand -base64 48`, and stating that both
containers mount the same file because it is what lets the connector trust a settings
request from the OAuth layer.

Replace the line 28 comment — the one claiming the UI "doesn't exist yet" — with what
now exists.

- [ ] **Step 2: Update the env examples**

`oauth/.env.example`: `SETTINGS_SIGNING_KEY_FILE`, `OPERATOR_FILE`, and a note that
`AUTH_PASSWORD_HASH` seeds the operator record once and is ignored afterwards.

`.env.example` and `.env.docker.example`: `SETTINGS_SIGNING_KEY_FILE`, and the
requirement that `PUBLIC_URL` here must be the same value as the OAuth layer's
`PUBLIC_URL` because it is the assertion's `iss`.

- [ ] **Step 3: Fix the three messages that promised this UI**

They currently name "the connector's /settings URL", which was never right — the UI is
served from the public origin, and the connector's own settings routes are not
reachable from outside. Each becomes a statement of where to actually go:

```ts
        ? `No mailbox accounts configured yet. Add one under /settings/mailboxes on this deployment's public URL.`
```

Same treatment in `src/tools-mail.ts:56` and `src/tools-calendar.ts:44`.

- [ ] **Step 4: Run the connector suite**

Run: `node --import tsx --test test/unit/*.test.ts`
Expected: PASS. Update any assertion that matched the old wording.

- [ ] **Step 5: Commit**

```bash
git add docker-compose.yml .env.example .env.docker.example oauth/.env.example src/accounts.ts src/tools-mail.ts src/tools-calendar.ts test/unit/accounts.test.ts
git commit -m "feat(settings): wire the deployment and point the errors at the real page"
```

---

## Task 16: Whole-system verification

No new features. This is the gate before the branch is offered for review.

- [ ] **Step 1: Run everything on Node 24**

Run the container command from "Verifying on Node 24", extended with both integration
suites (the connector's needs a reachable Docker daemon for GreenMail, so run that part
on the host instead).
Expected: PASS everywhere.

- [ ] **Step 2: Check the counts moved as promised**

Run each suite and record the totals. The floor was 25 + 14 for the connector and
201 + 57 for the OAuth layer; report the new numbers in the pull request body rather
than asserting a target here.

- [ ] **Step 3: Grep for the things that must not be there**

```bash
git log --format='%B' origin/main..HEAD | grep -inE 'claude|anthropic|co-authored-by|generated with' || echo "clean"
git diff origin/main..HEAD -- . ':!docs' | grep -nE 'console\.log' || echo "no stray logging"
git status --porcelain --ignored | grep -E 'accounts\.json|secrets/|oauth-data/|\.env' || echo "no credential file staged"
```

Expected: the first finds only legitimate product references (the `claude-mail-mcp`
name, MCP client names) and no attribution; the others are clean.

- [ ] **Step 4: Confirm the docker build still works for both images**

```bash
docker build -t mailmcp-check .
docker build -f oauth/Dockerfile -t mailoauth-check oauth
```

Expected: both succeed. The OAuth image's build context is `oauth/`, so a settings
module that accidentally imports from `../src` fails here rather than in production.

- [ ] **Step 5: Commit anything outstanding and open the pull request**

The PR body states what shipped, the test counts before and after, and the three
behaviour changes in `oauth/src/` with their justifications from the spec. No
attribution footer.

---

## Self-review notes

Checked against the spec on 2026-09-08:

- §0 → Task 15 step 3. §1 → the plan's architecture. §2 → Tasks 6, 9, 14.
- §3.1 → Task 6. §3.2 → Tasks 3, 6, 9. §3.3 → Tasks 3, 6, 14.
- §4 → Tasks 1, 2, 9, 10. §5.1 → Tasks 6, 9. §5.2 → Task 14.
- §6.1 → Tasks 13, 14. §6.2 → Task 11. §7 → Task 12. §8 → Tasks 7, 8, 9.
- §9 → Tasks 4, 9. §10 → Task 15. §11 → distributed across every task, gated by Task 16.
- §12 is the negative space and needs no task.

Names used consistently throughout: `signAssertion`/`verifyAssertion`,
`ASSERTION_HEADER`, `newSession`/`signSession`/`verifySession`, `sessionCookie`,
`csrfMatches`, `OperatorRecord.open`/`verify`/`changePassword`/`bumpSessionEpoch`,
`store.revokeClient`/`deleteClient`/`revokeEverything`/`tokenEpoch`,
`writeAccountsFile`/`readStamp`/`StaleStampError`, `probeAccount`/`ProbeReport`,
`renderMailboxList`/`renderMailboxForm`, `createSettingsRouter`.
