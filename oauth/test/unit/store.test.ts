import { strict as assert } from "node:assert";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { silentLogger } from "../../src/logger.js";
import { Store, type ClientRecord, type RefreshSession } from "../../src/store.js";

const openStores: Store[] = [];

async function tempStore(): Promise<{ store: Store; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "mail-mcp-oauth-"));
  const path = join(dir, "oauth-state.json");
  const store = await Store.open(path, silentLogger);
  openStores.push(store);
  return { store, path };
}

function client(id: string, issuedAt = 1000): ClientRecord {
  return {
    client_id: id,
    client_id_issued_at: issuedAt,
    redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
}

function session(
  jti: string,
  exp: number,
  overrides: Partial<RefreshSession> = {}
): RefreshSession {
  return {
    jti,
    sub: "operator",
    clientId: "client-1",
    scope: "mcp",
    resource: "https://mail.example.com/mcp",
    exp,
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(openStores.splice(0).map((store) => store.close()));
});

describe("Store persistence", () => {
  it("starts empty when the file does not exist yet", async () => {
    const { store } = await tempStore();
    assert.deepEqual(store.clients, {});
    assert.deepEqual(store.sessions, {});
  });

  it("survives a restart", async () => {
    const { store, path } = await tempStore();
    store.putClient(client("abc"));
    store.putSession("sid-1", session("jti-1", nowPlus(3600)));
    await store.flush();

    const reopened = await Store.open(path, silentLogger);
    openStores.push(reopened);
    assert.ok(reopened.getClient("abc"));
    assert.equal(reopened.getSession("sid-1")?.jti, "jti-1");
  });

  it("writes the file with owner-only permissions", async () => {
    const { store, path } = await tempStore();
    store.putClient(client("abc"));
    await store.flush();
    const contents = JSON.parse(await readFile(path, "utf8"));
    assert.equal(contents.version, 1);
    assert.ok(contents.clients.abc);
  });

  it("leaves no temp files behind after writing", async () => {
    const { store, path } = await tempStore();
    for (let i = 0; i < 5; i += 1) store.putClient(client(`c${i}`));
    await store.flush();
    const entries = await readdir(join(path, ".."));
    assert.deepEqual(entries, ["oauth-state.json"]);
  });

  it("coalesces rapid writes without corrupting the file", async () => {
    const { store, path } = await tempStore();
    for (let i = 0; i < 50; i += 1) store.putClient(client(`c${i}`, 1000 + i));
    await store.flush();
    const contents = JSON.parse(await readFile(path, "utf8"));
    assert.equal(Object.keys(contents.clients).length, 50);
  });

  it("treats a corrupt file as empty and moves it aside", async () => {
    const { store, path } = await tempStore();
    store.putClient(client("abc"));
    await store.close();

    await writeFile(path, "{ this is not json", "utf8");
    const reopened = await Store.open(path, silentLogger);
    openStores.push(reopened);

    assert.deepEqual(reopened.clients, {});
    const entries = await readdir(join(path, ".."));
    assert.ok(
      entries.some((name) => name.includes(".corrupt-")),
      `expected a quarantined file, got ${entries.join(", ")}`
    );
  });

  it("treats a file from an unknown schema version as empty", async () => {
    const { path } = await tempStore();
    await writeFile(
      path,
      JSON.stringify({ version: 99, clients: {}, sessions: {} }),
      "utf8"
    );
    const reopened = await Store.open(path, silentLogger);
    openStores.push(reopened);
    assert.deepEqual(reopened.clients, {});
  });

  it("treats a structurally wrong file as empty", async () => {
    const { path } = await tempStore();
    await writeFile(path, JSON.stringify({ version: 1, clients: [] }), "utf8");
    const reopened = await Store.open(path, silentLogger);
    openStores.push(reopened);
    assert.deepEqual(reopened.clients, {});
  });
});

describe("Store session lifecycle", () => {
  it("replaces a session on rotation rather than accumulating", async () => {
    const { store } = await tempStore();
    store.putSession("sid-1", session("jti-1", nowPlus(3600)));
    store.putSession("sid-1", session("jti-2", nowPlus(3600)));
    assert.equal(Object.keys(store.sessions).length, 1);
    assert.equal(store.getSession("sid-1")?.jti, "jti-2");
  });

  it("deletes a session", async () => {
    const { store } = await tempStore();
    store.putSession("sid-1", session("jti-1", nowPlus(3600)));
    store.deleteSession("sid-1");
    assert.equal(store.getSession("sid-1"), undefined);
  });

  it("prunes expired sessions and keeps live ones", async () => {
    const { store } = await tempStore();
    store.putSession("dead", session("jti-1", nowPlus(-1)));
    store.putSession("alive", session("jti-2", nowPlus(3600)));
    const dropped = store.pruneExpiredSessions();
    assert.equal(dropped, 1);
    assert.equal(store.getSession("dead"), undefined);
    assert.ok(store.getSession("alive"));
  });

  it("prunes expired sessions when reopening the file", async () => {
    const { store, path } = await tempStore();
    store.putSession("dead", session("jti-1", nowPlus(-1)));
    store.putSession("alive", session("jti-2", nowPlus(3600)));
    await store.close();

    const reopened = await Store.open(path, silentLogger);
    openStores.push(reopened);
    assert.equal(reopened.getSession("dead"), undefined);
    assert.ok(reopened.getSession("alive"));
  });
});

describe("Store in-memory mode", () => {
  it("works without a path and writes nothing", async () => {
    const store = await Store.open(null, silentLogger);
    store.putClient(client("abc"));
    await store.flush();
    assert.ok(store.getClient("abc"));
  });
});

function nowPlus(seconds: number): number {
  return Math.floor(Date.now() / 1000) + seconds;
}

describe("Store revocation", () => {
  it("a fresh store starts at token epoch zero", async () => {
    const store = await Store.open(null, silentLogger);
    assert.equal(store.tokenEpoch, 0);
  });

  it("revoking a client drops its sessions and marks it", async () => {
    const store = await Store.open(null, silentLogger);
    store.putClient(client("c1"));
    store.putSession("s1", session("jti-1", nowPlus(3600), { clientId: "c1" }));
    store.putSession("s2", session("jti-2", nowPlus(3600), { clientId: "c2" }));

    store.revokeClient("c1", 1757000000);

    assert.equal(store.getClient("c1")?.revokedAt, 1757000000);
    assert.equal(store.getSession("s1"), undefined);
    assert.ok(store.getSession("s2"), "another client's session is untouched");
  });

  it("deleting a client removes the record and reports the sessions taken with it", async () => {
    const store = await Store.open(null, silentLogger);
    store.putClient(client("c1"));
    store.putSession("s1", session("jti-1", nowPlus(3600), { clientId: "c1" }));
    store.putSession("s2", session("jti-2", nowPlus(3600), { clientId: "c1" }));
    assert.equal(store.deleteClient("c1"), 2);
    assert.equal(store.getClient("c1"), undefined);
    assert.equal(store.getSession("s1"), undefined);
  });

  it("revoking everything bumps the epoch and empties the sessions", async () => {
    const store = await Store.open(null, silentLogger);
    store.putClient(client("c1"));
    store.putSession("s1", session("jti-1", nowPlus(3600), { clientId: "c1" }));
    store.revokeEverything(1757000000);
    assert.equal(store.tokenEpoch, 1);
    assert.deepEqual(Object.keys(store.sessions), []);
    assert.equal(store.getClient("c1")?.revokedAt, 1757000000);
  });

  it("a state file written before tokenEpoch existed still loads", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "store-")), "state.json");
    await writeFile(
      path,
      JSON.stringify({ version: 1, clients: {}, sessions: {} }),
      "utf8"
    );
    const store = await Store.open(path, silentLogger);
    openStores.push(store);
    assert.equal(store.tokenEpoch, 0, "missing means zero, not a corrupt file");
  });

  it("a negative tokenEpoch on disk loads as zero, not carried through", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "store-")), "state.json");
    await writeFile(
      path,
      JSON.stringify({ version: 1, clients: {}, sessions: {}, tokenEpoch: -5 }),
      "utf8"
    );
    const store = await Store.open(path, silentLogger);
    openStores.push(store);
    assert.equal(store.tokenEpoch, 0, "negative is out of domain, not a valid epoch");
  });
});
