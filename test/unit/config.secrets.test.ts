/**
 * The connector's half of "a present file wins, an absent one is generated".
 *
 * `AUTH_TOKEN` and `SETTINGS_SIGNING_KEY` are the two secrets this process
 * shares with the OAuth layer, through files both containers mount. See
 * oauth/test/unit/config.test.ts for the same scenarios on the other side.
 *
 * As in the sibling config tests, each case re-imports src/config.js with a
 * cache-busting query string, because that module reads the environment once at
 * import time.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const KEYS = [
  "AUTH_TOKEN",
  "AUTH_TOKEN_FILE",
  "SETTINGS_SIGNING_KEY",
  "SETTINGS_SIGNING_KEY_FILE",
] as const;

async function loadConfig(env: Partial<Record<(typeof KEYS)[number], string>>) {
  const previous = { ...process.env };
  for (const key of KEYS) delete process.env[key];
  Object.assign(process.env, env);
  try {
    const mod = await import(`../../src/config.js?case=${Math.random()}`);
    return mod.config as {
      authToken: string;
      settingsSigningKey: string;
      secretReport: { name: string; source: string; path: string | null }[];
    };
  } finally {
    process.env = previous;
  }
}

function workdir(): string {
  return mkdtempSync(join(tmpdir(), "mailmcp-config-"));
}

function sources(config: { secretReport: { name: string; source: string }[] }) {
  return Object.fromEntries(config.secretReport.map((entry) => [entry.name, entry.source]));
}

test("an empty secrets directory generates both files and boots", async () => {
  const dir = workdir();
  const config = await loadConfig({
    AUTH_TOKEN_FILE: join(dir, "auth_token.txt"),
    SETTINGS_SIGNING_KEY_FILE: join(dir, "settings_signing_key.txt"),
  });

  assert.deepEqual(sources(config), {
    AUTH_TOKEN: "generated",
    SETTINGS_SIGNING_KEY: "generated",
  });
  assert.ok(config.authToken.length > 0);
  assert.equal(readFileSync(join(dir, "auth_token.txt"), "utf8").trim(), config.authToken);
  assert.equal(
    readFileSync(join(dir, "settings_signing_key.txt"), "utf8").trim(),
    config.settingsSigningKey
  );
});

test("present files are used unchanged and nothing is written", async () => {
  // The upgrade path. A regenerated AUTH_TOKEN here breaks every Claude client
  // that is currently connected to a running instance.
  const dir = workdir();
  writeFileSync(join(dir, "auth_token.txt"), "live-token\n");
  writeFileSync(join(dir, "settings_signing_key.txt"), `${"k".repeat(48)}\n`);
  const before = readdirSync(dir).map((name) => [name, statSync(join(dir, name)).mtimeMs]);

  const config = await loadConfig({
    AUTH_TOKEN: "stale-inline-value",
    AUTH_TOKEN_FILE: join(dir, "auth_token.txt"),
    SETTINGS_SIGNING_KEY_FILE: join(dir, "settings_signing_key.txt"),
  });

  assert.equal(config.authToken, "live-token");
  assert.equal(config.settingsSigningKey, "k".repeat(48));
  assert.deepEqual(sources(config), { AUTH_TOKEN: "file", SETTINGS_SIGNING_KEY: "file" });
  assert.deepEqual(
    readdirSync(dir).map((name) => [name, statSync(join(dir, name)).mtimeMs]),
    before
  );
});

test("a mix of present and absent files keeps the present one", async () => {
  const dir = workdir();
  writeFileSync(join(dir, "auth_token.txt"), "live-token\n");

  const config = await loadConfig({
    AUTH_TOKEN_FILE: join(dir, "auth_token.txt"),
    SETTINGS_SIGNING_KEY_FILE: join(dir, "settings_signing_key.txt"),
  });

  assert.equal(config.authToken, "live-token");
  assert.deepEqual(sources(config), {
    AUTH_TOKEN: "file",
    SETTINGS_SIGNING_KEY: "generated",
  });
});

test("an inline AUTH_TOKEN seeds the file rather than being replaced", async () => {
  // An Option A install carries AUTH_TOKEN in .env and has no secrets file. Its
  // token has to survive the upgrade *and* reach the file the OAuth layer reads,
  // or the proxy substitutes a token the connector will reject.
  const dir = workdir();
  const config = await loadConfig({
    AUTH_TOKEN: "token-from-dot-env",
    AUTH_TOKEN_FILE: join(dir, "auth_token.txt"),
  });

  assert.equal(config.authToken, "token-from-dot-env");
  assert.deepEqual(sources(config), { AUTH_TOKEN: "seeded" });
  assert.equal(
    readFileSync(join(dir, "auth_token.txt"), "utf8").trim(),
    "token-from-dot-env"
  );
});

test("a second boot reads back what the first generated", async () => {
  const dir = workdir();
  const env = {
    AUTH_TOKEN_FILE: join(dir, "auth_token.txt"),
    SETTINGS_SIGNING_KEY_FILE: join(dir, "settings_signing_key.txt"),
  };

  const first = await loadConfig(env);
  const second = await loadConfig(env);

  assert.equal(second.authToken, first.authToken);
  assert.equal(second.settingsSigningKey, first.settingsSigningKey);
  assert.deepEqual(sources(second), { AUTH_TOKEN: "file", SETTINGS_SIGNING_KEY: "file" });
});

test("without AUTH_TOKEN_FILE there is nowhere to generate to, and startup fails", async () => {
  await assert.rejects(() => loadConfig({}), /AUTH_TOKEN/);
});

test("SETTINGS_SIGNING_KEY stays off, and unreported, when neither form is set", async () => {
  const config = await loadConfig({ AUTH_TOKEN: "t" });
  assert.equal(config.settingsSigningKey, "");
  assert.deepEqual(sources(config), { AUTH_TOKEN: "environment" });
});

test("a NAME_FILE in a directory that does not exist is fatal, not silently generated", async () => {
  const dir = workdir();
  await assert.rejects(
    () =>
      loadConfig({
        AUTH_TOKEN: "t",
        AUTH_TOKEN_FILE: join(dir, "missing-directory", "auth_token.txt"),
      }),
    /AUTH_TOKEN_FILE/
  );
  assert.equal(existsSync(join(dir, "missing-directory")), false);
});
