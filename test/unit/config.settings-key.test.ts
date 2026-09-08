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
