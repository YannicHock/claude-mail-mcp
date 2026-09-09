import { strict as assert } from "node:assert";
import { randomBytes } from "node:crypto";
import { beforeEach, describe, it, test } from "node:test";

import { SignJWT } from "jose";

import { silentLogger } from "../../src/logger.js";
import { Store, type ClientRecord } from "../../src/store.js";
import {
  TokenIssuer,
  type AccessTokenClaims,
  type TokenIssuerOptions,
} from "../../src/tokens.js";

const ISSUER = "https://mail.example.com";
const RESOURCE = "https://mail.example.com/mcp";
const KEY = new Uint8Array(randomBytes(32));

const CLAIMS = {
  sub: "operator",
  clientId: "client-1",
  scope: "mcp",
  resource: RESOURCE,
} as const;

/** Fixed-key issuer options, so a hand-signed token and the issuer agree on the key. */
function issuerOptions(store: Store): TokenIssuerOptions {
  return {
    issuer: ISSUER,
    signingKey: KEY,
    accessTokenTtl: 3600,
    refreshTokenTtl: 2592000,
    store,
  };
}

function accessClaims(overrides: Partial<AccessTokenClaims> = {}): AccessTokenClaims {
  return { ...CLAIMS, ...overrides };
}

function clientRecord(id: string): ClientRecord {
  return {
    client_id: id,
    client_id_issued_at: 1000,
    redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
}

async function makeIssuer(
  overrides: { accessTokenTtl?: number; refreshTokenTtl?: number } = {}
): Promise<{ issuer: TokenIssuer; store: Store; key: Uint8Array }> {
  const key = new Uint8Array(randomBytes(32));
  const store = await Store.open(null, silentLogger);
  const issuer = new TokenIssuer({
    issuer: ISSUER,
    signingKey: key,
    accessTokenTtl: overrides.accessTokenTtl ?? 3600,
    refreshTokenTtl: overrides.refreshTokenTtl ?? 2592000,
    store,
  });
  return { issuer, store, key };
}

describe("TokenIssuer.issue / verifyAccessToken", () => {
  let issuer: TokenIssuer;
  let store: Store;
  let key: Uint8Array;

  beforeEach(async () => {
    ({ issuer, store, key } = await makeIssuer());
  });

  it("issues a verifiable access token bound to the resource", async () => {
    const tokens = await issuer.issue(CLAIMS);
    const result = await issuer.verifyAccessToken(tokens.accessToken, RESOURCE);
    assert.equal(result.ok, true);
    assert.ok(result.ok);
    assert.equal(result.claims.sub, "operator");
    assert.equal(result.claims.clientId, "client-1");
    assert.equal(result.claims.scope, "mcp");
    assert.equal(result.claims.resource, RESOURCE);
  });

  it("reports the access token lifetime it actually used", async () => {
    const short = await makeIssuer({ accessTokenTtl: 900 });
    const tokens = await short.issuer.issue(CLAIMS);
    assert.equal(tokens.expiresIn, 900);
  });

  it("rejects a token minted for a different audience", async () => {
    const tokens = await issuer.issue(CLAIMS);
    const result = await issuer.verifyAccessToken(
      tokens.accessToken,
      "https://other.example.com/mcp"
    );
    assert.equal(result.ok, false);
    assert.ok(!result.ok);
    assert.equal(result.reason, "wrong_audience");
  });

  it("rejects a token signed with a different key", async () => {
    const tokens = await issuer.issue(CLAIMS);
    const other = await makeIssuer();
    const result = await other.issuer.verifyAccessToken(tokens.accessToken, RESOURCE);
    assert.equal(result.ok, false);
    assert.ok(!result.ok);
    assert.equal(result.reason, "invalid_token");
  });

  it("rejects a token from a different issuer", async () => {
    const foreign = await new SignJWT({
      token_use: "access",
      client_id: "client-1",
      scope: "mcp",
    })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuer("https://evil.example.com")
      .setAudience(RESOURCE)
      .setSubject("operator")
      .setIssuedAt()
      .setExpirationTime("1h")
      .setJti("x")
      .sign(key);

    const result = await issuer.verifyAccessToken(foreign, RESOURCE);
    assert.equal(result.ok, false);
  });

  it("rejects an expired token as expired, not merely invalid", async () => {
    const expiring = await makeIssuer({ accessTokenTtl: -10 });
    const tokens = await expiring.issuer.issue(CLAIMS);
    const result = await expiring.issuer.verifyAccessToken(tokens.accessToken, RESOURCE);
    assert.equal(result.ok, false);
    assert.ok(!result.ok);
    assert.equal(result.reason, "expired_token");
  });

  it("rejects a refresh token presented as a bearer credential", async () => {
    const tokens = await issuer.issue(CLAIMS);
    const result = await issuer.verifyAccessToken(tokens.refreshToken, RESOURCE);
    assert.equal(result.ok, false);
    assert.ok(!result.ok);
    assert.equal(result.reason, "wrong_use");
  });

  it("rejects an unsigned token claiming alg none", async () => {
    // Hand-built because jose refuses to sign `none`; this is the exact shape an
    // algorithm-confusion attempt takes.
    const header = Buffer.from(
      JSON.stringify({ alg: "none", typ: "JWT" })
    ).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({
        iss: ISSUER,
        aud: RESOURCE,
        sub: "operator",
        jti: "x",
        client_id: "client-1",
        scope: "mcp",
        token_use: "access",
        exp: Math.floor(Date.now() / 1000) + 3600,
      })
    ).toString("base64url");
    const result = await issuer.verifyAccessToken(`${header}.${payload}.`, RESOURCE);
    assert.equal(result.ok, false);
    assert.ok(!result.ok);
    assert.equal(result.reason, "invalid_token");
  });

  it("rejects garbage and empty input without throwing", async () => {
    for (const bad of ["", "not.a.jwt", "a.b.c", "...."]) {
      const result = await issuer.verifyAccessToken(bad, RESOURCE);
      assert.equal(result.ok, false, `expected rejection for ${JSON.stringify(bad)}`);
    }
  });

  it("opens exactly one refresh session per issue", async () => {
    await issuer.issue(CLAIMS);
    assert.equal(Object.keys(store.sessions).length, 1);
  });
});

describe("TokenIssuer.rotate", () => {
  let issuer: TokenIssuer;
  let store: Store;

  beforeEach(async () => {
    ({ issuer, store } = await makeIssuer());
  });

  it("exchanges a refresh token for a new pair", async () => {
    const first = await issuer.issue(CLAIMS);
    const rotated = await issuer.rotate(first.refreshToken);
    assert.equal(rotated.ok, true);
    assert.ok(rotated.ok);
    assert.notEqual(rotated.tokens.refreshToken, first.refreshToken);

    const verified = await issuer.verifyAccessToken(
      rotated.tokens.accessToken,
      RESOURCE
    );
    assert.equal(verified.ok, true);
  });

  it("carries the original subject, client, scope and resource forward", async () => {
    const first = await issuer.issue(CLAIMS);
    const rotated = await issuer.rotate(first.refreshToken);
    assert.ok(rotated.ok);
    const verified = await issuer.verifyAccessToken(
      rotated.tokens.accessToken,
      RESOURCE
    );
    assert.ok(verified.ok);
    assert.equal(verified.claims.sub, "operator");
    assert.equal(verified.claims.clientId, "client-1");
    assert.equal(verified.claims.scope, "mcp");
  });

  it("keeps the session identity across rotation instead of leaking sessions", async () => {
    const first = await issuer.issue(CLAIMS);
    const sidBefore = Object.keys(store.sessions);
    await issuer.rotate(first.refreshToken);
    const sidAfter = Object.keys(store.sessions);
    assert.deepEqual(sidAfter, sidBefore);
    assert.equal(sidAfter.length, 1);
  });

  it("refuses the old refresh token once it has been rotated", async () => {
    const first = await issuer.issue(CLAIMS);
    await issuer.rotate(first.refreshToken);
    const replay = await issuer.rotate(first.refreshToken);
    assert.equal(replay.ok, false);
    assert.ok(!replay.ok);
    assert.equal(replay.reason, "reused");
  });

  it("revokes the whole family when a rotated token resurfaces", async () => {
    const first = await issuer.issue(CLAIMS);
    const second = await issuer.rotate(first.refreshToken);
    assert.ok(second.ok);

    // The captured token is replayed; the session must die with it, so the
    // attacker's copy and the legitimate holder's copy both stop working.
    await issuer.rotate(first.refreshToken);
    assert.equal(Object.keys(store.sessions).length, 0);

    const afterRevocation = await issuer.rotate(second.tokens.refreshToken);
    assert.equal(afterRevocation.ok, false);
    assert.ok(!afterRevocation.ok);
    assert.equal(afterRevocation.reason, "unknown_session");
  });

  it("supports repeated rotation", async () => {
    let current = (await issuer.issue(CLAIMS)).refreshToken;
    for (let i = 0; i < 5; i += 1) {
      const rotated = await issuer.rotate(current);
      assert.ok(rotated.ok, `rotation ${i} failed`);
      current = rotated.tokens.refreshToken;
    }
    assert.equal(Object.keys(store.sessions).length, 1);
  });

  it("refuses an access token presented at the refresh grant", async () => {
    const first = await issuer.issue(CLAIMS);
    const result = await issuer.rotate(first.accessToken);
    assert.equal(result.ok, false);
    assert.ok(!result.ok);
    assert.equal(result.reason, "wrong_use");
  });

  it("refuses an expired refresh token", async () => {
    const expiring = await makeIssuer({ refreshTokenTtl: -10 });
    const first = await expiring.issuer.issue(CLAIMS);
    const result = await expiring.issuer.rotate(first.refreshToken);
    assert.equal(result.ok, false);
    assert.ok(!result.ok);
    assert.equal(result.reason, "expired_token");
  });

  it("refuses a refresh token whose session is gone", async () => {
    const first = await issuer.issue(CLAIMS);
    for (const sid of Object.keys(store.sessions)) store.deleteSession(sid);
    const result = await issuer.rotate(first.refreshToken);
    assert.equal(result.ok, false);
    assert.ok(!result.ok);
    assert.equal(result.reason, "unknown_session");
  });

  it("refuses garbage without throwing", async () => {
    const result = await issuer.rotate("nonsense");
    assert.equal(result.ok, false);
  });
});

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

test("a legacy token missing the epoch claim is rejected once the store's epoch has moved", async () => {
  const store = await Store.open(null, silentLogger);
  // revokeEverything() runs before c1 is registered, so bumping tokenEpoch does
  // not also stamp c1 with a revokedAt. That isolates this case to the epoch
  // fallback specifically: if the `typeof` guard were dropped and a missing
  // `epoch` stayed `undefined`, `undefined < tokenEpoch` is always false and the
  // token would wrongly keep verifying, with no other check left to catch it.
  store.revokeEverything(Math.floor(Date.now() / 1000));
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
    .setJti("legacy-after-revocation")
    .sign(KEY);
  const result = await issuer.verifyAccessToken(legacy, RESOURCE);
  assert.equal(result.ok, false);
});

test("an access token stops verifying once its own session is revoked", async () => {
  const store = await Store.open(null, silentLogger);
  store.putClient(clientRecord("c1"));
  const issuer = new TokenIssuer(issuerOptions(store));
  const { accessToken } = await issuer.issue(accessClaims({ clientId: "c1" }));

  assert.equal((await issuer.verifyAccessToken(accessToken, RESOURCE)).ok, true);

  // Exactly what /settings/sessions/:sid/revoke does, and all it does: no epoch
  // bump and no revokedAt, so the sid claim is the only thing left to catch this.
  const [sid] = Object.keys(store.sessions);
  store.deleteSession(sid);

  const after = await issuer.verifyAccessToken(accessToken, RESOURCE);
  assert.equal(after.ok, false);
  assert.ok(!after.ok);
  assert.equal(after.reason, "revoked_session");
});

test("revoking one session leaves the other session's access token working", async () => {
  const store = await Store.open(null, silentLogger);
  store.putClient(clientRecord("c1"));
  const issuer = new TokenIssuer(issuerOptions(store));
  const first = await issuer.issue(accessClaims({ clientId: "c1" }));
  const second = await issuer.issue(accessClaims({ clientId: "c1" }));

  // Both sessions belong to the same client, which is the case the client-level
  // revocation cannot express: it would take the other one down with it.
  const [firstSid] = Object.keys(store.sessions);
  store.deleteSession(firstSid);

  assert.equal((await issuer.verifyAccessToken(first.accessToken, RESOURCE)).ok, false);
  assert.equal((await issuer.verifyAccessToken(second.accessToken, RESOURCE)).ok, true);
});

test("an access token minted by a refresh dies with the session too", async () => {
  const store = await Store.open(null, silentLogger);
  store.putClient(clientRecord("c1"));
  const issuer = new TokenIssuer(issuerOptions(store));
  const first = await issuer.issue(accessClaims({ clientId: "c1" }));
  const rotated = await issuer.rotate(first.refreshToken);
  assert.ok(rotated.ok);

  // Rotation reuses the sid rather than opening a second session, so the rotated
  // access token has to carry the sid the operator sees listed — not a new one.
  const [sid] = Object.keys(store.sessions);
  store.deleteSession(sid);

  const after = await issuer.verifyAccessToken(rotated.tokens.accessToken, RESOURCE);
  assert.equal(after.ok, false);
  assert.ok(!after.ok);
  assert.equal(after.reason, "revoked_session");
});

test("a token minted before the sid claim existed still verifies", async () => {
  // Same tolerance the epoch claim gets: an upgrade must not sign every connected
  // client out, and the window closes on its own within one access-token lifetime.
  const store = await Store.open(null, silentLogger);
  store.putClient(clientRecord("c1"));
  const issuer = new TokenIssuer(issuerOptions(store));
  const legacy = await new SignJWT({
    token_use: "access",
    client_id: "c1",
    scope: "mcp",
    epoch: 0,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(ISSUER)
    .setAudience(RESOURCE)
    .setSubject("operator")
    .setIssuedAt()
    .setExpirationTime("1h")
    .setJti("legacy-no-sid")
    .sign(KEY);
  assert.equal((await issuer.verifyAccessToken(legacy, RESOURCE)).ok, true);
});

test("a token naming a session that never existed is refused", async () => {
  const store = await Store.open(null, silentLogger);
  store.putClient(clientRecord("c1"));
  const issuer = new TokenIssuer(issuerOptions(store));
  const forged = await new SignJWT({
    token_use: "access",
    client_id: "c1",
    scope: "mcp",
    epoch: 0,
    sid: "a-session-that-was-never-opened",
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(ISSUER)
    .setAudience(RESOURCE)
    .setSubject("operator")
    .setIssuedAt()
    .setExpirationTime("1h")
    .setJti("unknown-sid")
    .sign(KEY);
  const result = await issuer.verifyAccessToken(forged, RESOURCE);
  assert.equal(result.ok, false);
  assert.ok(!result.ok);
  assert.equal(result.reason, "revoked_session");
});
