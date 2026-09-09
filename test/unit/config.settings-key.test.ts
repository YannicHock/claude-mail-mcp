import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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

test("an inline SETTINGS_SIGNING_KEY is trimmed, matching the file-sourced path", async () => {
  // Both services must derive byte-identical keys from the same secret. A
  // trailing newline pasted from `openssl rand -base64 48` output must not
  // survive on the inline path while the _FILE path (below) already trims it.
  const config = await loadConfig({
    SETTINGS_SIGNING_KEY: `  ${"k".repeat(32)}  \n`,
  });
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
  // A directory where a file was expected. An absent file is generated (see
  // config.secrets.test.ts); one that is *there* and cannot be read is still a
  // typo in a secret mount, and must stop the process rather than quietly
  // produce a replacement for a key the other service already has.
  const dir = mkdtempSync(join(tmpdir(), "mailmcp-"));
  const path = join(dir, "not-a-file");
  mkdirSync(path);
  await assert.rejects(
    () => loadConfig({ SETTINGS_SIGNING_KEY_FILE: path }),
    /Cannot read SETTINGS_SIGNING_KEY_FILE/
  );
});

test("a SETTINGS_SIGNING_KEY_FILE that cannot be created is fatal too", async () => {
  await assert.rejects(
    () => loadConfig({ SETTINGS_SIGNING_KEY_FILE: "/nonexistent/key" }),
    /Cannot create SETTINGS_SIGNING_KEY_FILE/
  );
});
