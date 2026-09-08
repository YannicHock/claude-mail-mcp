# OAuth 2.1 layer for claude-mail-mcp — design

Status: approved 2026-09-08. Supersedes the endpoint list in `docs/DEPLOYMENT.md`
("Option B — claude.ai web"), which is incomplete and partly wrong (see §1).

## 0. Problem

`claude-mail-mcp` authenticates `POST /mcp` with a single static Bearer token from
`AUTH_TOKEN` (`src/app.ts`, `bearerAuth`). Claude's hosted surfaces — claude.ai web,
Desktop, mobile and Cowork — connect to a custom connector from Anthropic's
infrastructure and cannot be given a custom HTTP header, so a static token is not
transferable. They expect OAuth discovery.

This document specifies a separate service that sits in front of the connector,
speaks OAuth 2.1 to Claude, authenticates the operator, and forwards `/mcp` traffic
upstream with the connector's static token substituted in.

The connector is not modified.

## 1. Findings — what the Claude client actually requires

Researched 2026-09-08 against the sources listed in §9. The endpoint list currently
in `docs/DEPLOYMENT.md` came from the upstream project's documentation and is wrong
in two directions.

| `docs/DEPLOYMENT.md` claim | Reality |
| --- | --- |
| `/.well-known/oauth-authorization-server` | Correct. `/.well-known/openid-configuration` is an accepted alternative; Claude tries RFC 8414 first, then OIDC. Only one must answer. |
| `/authorize`, `/token` | Correct. |
| `/register` | One of three options — see §1.2. |
| `/jwks.json` | **Not needed.** Nothing outside this service validates the tokens it issues; it is its own resource server. No client and no Anthropic component fetches JWKS. |
| — | **Missing: `/.well-known/oauth-protected-resource` (RFC 9728).** "MCP servers **MUST** implement OAuth 2.0 Protected Resource Metadata." |
| — | **Missing: `401` with `WWW-Authenticate: Bearer resource_metadata="…"`.** Without it the client cannot locate the authorization server. |
| — | **Missing: RFC 8707 `resource` parameter handling and audience binding.** |

Omitting protected resource metadata or the `WWW-Authenticate` pointer produces
"Couldn't reach the MCP server" with no actionable detail — Anthropic documents this
exact symptom as "your MCP server receives the initial request but your authorization
server sees no traffic at all".

### 1.1 Discovery sequence

    POST /mcp                       (no token)  -> 401 + WWW-Authenticate: Bearer resource_metadata="…"
    GET  <resource_metadata URL>                -> PRM: resource, authorization_servers[0], scopes_supported
    GET  <issuer>/.well-known/oauth-authorization-server
    [ client registration ]
    GET  /authorize?…code_challenge…&resource=… (from the operator's browser)
    POST /token                                 (form-urlencoded, from Anthropic's network)
    POST /mcp  Authorization: Bearer <token>

If the `resource_metadata` pointer is absent, Claude probes the MCP origin for
`/.well-known/oauth-protected-resource/<mcp path>` first, then
`/.well-known/oauth-protected-resource`. This service serves the header **and** both
paths; the redundancy costs nothing and removes a whole class of failure.

`authorization_servers[0]` is the only entry Claude uses — it does not fall back to
later entries.

### 1.2 Client registration

Claude accepts three mechanisms: dynamic client registration (RFC 7591), Client ID
Metadata Documents, or a client ID pre-registered by the operator in the connector's
"Advanced settings" (where the client secret field is optional). CIMD is selected only
when authorization server metadata advertises both `client_id_metadata_document_supported: true`
and `"none"` in `token_endpoint_auth_methods_supported`; otherwise Claude falls back to
looking for a `registration_endpoint`.

**Decision: DCR with a redirect-URI allowlist.** It works with no manual setup step,
needs no outbound HTTP from this service, and the allowlist removes most of the
exposure an open registration endpoint would otherwise carry.

### 1.3 PKCE, grants, redirect URIs

Claude sends `code_challenge` with `code_challenge_method=S256` on every authorization
request regardless of registration mechanism, and metadata must advertise
`code_challenge_methods_supported: ["S256"]`. Grants: `authorization_code` and
`refresh_token`; `response_types: ["code"]`. A pure `client_credentials` grant is
explicitly unsupported by Claude — every connection requires user consent.

Redirect URIs to accept:

- `https://claude.ai/api/mcp/auth_callback` — claude.ai web, Desktop, mobile, Cowork
- `https://claude.com/api/mcp/auth_callback` — Anthropic asks that this be allowlisted
  too, because the callback may move
- optional, off by default: `http://localhost/callback` and `http://127.0.0.1/callback`
  compared **with the port ignored**, for Claude Code

### 1.4 Operational constraints that shape the implementation

1. `/token` is `application/x-www-form-urlencoded`; `/register` is `application/json`.
   A single `express.json()` mount — what the connector uses — makes `/token` fail.
   Parsers are mounted per route. No parser is mounted on `/mcp`: the body must reach
   the upstream unparsed.
2. Connectors are IPv4-only. "A hostname that only publishes `AAAA` records can't be
   reached." The public hostname needs an A record. This is the inbound counterpart to
   the known Hetzner IPv6 workaround for outbound IMAP, which is unrelated.
3. No cross-host redirect on the MCP URL: a `301`/`302` to another host makes clients
   drop the `Authorization` header, surfacing as "Authorization with the MCP server failed".
4. Timeouts: Claude waits 10 s for discovery, `/register` and `/token`; 30 s for refresh.
   The password check must not sit in the `/token` path — it does not.
5. Anthropic's egress is `160.79.104.0/21`, but `/authorize` is loaded by the operator's
   **browser**, not from that range. An IP allowlist on `/authorize` would break the flow.
6. Refresh tokens must be rotated for public clients, and a dead refresh token must
   produce RFC 6749 `invalid_grant` — not `invalid_request` or a custom code.

### 1.5 Open assumption

Whether Claude always prefers DCR when a `registration_endpoint` is present, or whether
an operator-entered static client ID takes precedence, is not stated in the
documentation. Both paths work; this only determines which code path runs in
production, and the answer will be visible in the service's logs on first connect.

## 2. Architecture

A separate service in this repository under `oauth/`, with its own `package.json`,
`tsconfig.json`, `Dockerfile` and GHCR image `ghcr.io/yannichock/claude-mail-mcp-oauth`.
The connector's `src/` is untouched.

Same stack as the connector — Node 22 Alpine, TypeScript ESM, Express 5 — so the
repository gains no second toolchain. One dependency beyond Express: `jose`, for JWT
signing and verification. It is pure JS with no native build, and it covers the places
where hand-rolled token crypto typically goes wrong (algorithm confusion, `exp`
handling, constant-time comparison). Proxying uses `node:http` with `pipe()`: no
buffering, no additional package.

### Modules

| File | Responsibility |
| --- | --- |
| `src/index.ts` | Entry point: load config, build app, bind, handle shutdown |
| `src/app.ts` | Express app factory — the whole request path, testable without a socket |
| `src/config.ts` | Environment and `*_FILE` secret loading, validation |
| `src/metadata.ts` | Protected resource metadata and authorization server metadata |
| `src/clients.ts` | DCR, redirect-URI allowlist, client records |
| `src/codes.ts` | Authorization codes: issue, redeem once, expire |
| `src/tokens.ts` | Access and refresh tokens: sign, verify, rotate, detect reuse |
| `src/pkce.ts` | S256 challenge verification |
| `src/passwords.ts` | scrypt hashing, parsing and constant-time verification |
| `src/login.ts` | Login form rendering and CSRF |
| `src/throttle.ts` | Per-IP login attempt throttle |
| `src/proxy.ts` | Streaming MCP proxy with token substitution |
| `src/store.ts` | Atomic JSON persistence |
| `src/hash-password.ts` | `npm run hash-password` CLI |

The `app.ts` split mirrors the connector's, and for the same reason recorded there:
tests exercise the real middleware chain rather than a re-implementation of it.

## 3. Endpoints

| Route | Purpose |
| --- | --- |
| `GET /.well-known/oauth-protected-resource` and `…/mcp` | RFC 9728, both paths |
| `GET /.well-known/oauth-authorization-server` | RFC 8414, advertises S256 |
| `POST /register` | RFC 7591, `application/json`, redirect allowlist enforced |
| `GET /authorize` | Login form |
| `POST /authorize` | CSRF-guarded; issues the authorization code |
| `POST /token` | `application/x-www-form-urlencoded`; both grants |
| `ALL /mcp` | Verify token, substitute upstream token, stream |
| `GET /health` | This service's own health |
| everything else | 404 |

`/jwks.json` is deliberately absent (§1). The connector's `GET /health` is deliberately
**not** proxied: it discloses server name, version, mailbox count and the path to the
credentials file. Only this service's own health is reachable from outside.

## 4. Tokens and state

- **Access token**: JWT HS256. `iss` = `PUBLIC_URL`, `aud` = the canonical MCP URL
  (the `resource` value), `sub` = the operator's username, `jti`, 1 h lifetime. Claude
  refreshes proactively five minutes before expiry, so a short lifetime is free.
- **Refresh token**: JWT, 30 days, **rotated on every use**. Presenting a rotated `jti`
  revokes the family and returns `invalid_grant`.
- **Authorization codes**: in memory only, 60 s, single use, bound to `code_challenge`,
  `redirect_uri`, `client_id` and `resource`.
- **Persistence**: one small JSON file (`/data/oauth-state.json`, written atomically)
  holding registered clients and spent refresh `jti` values. The signing key comes from
  a mounted secret so a restart does not invalidate live sessions.

### Audience handling

The token's `aud` is the canonical resource URI. On `/mcp` the audience is checked
against it. When Claude sends `resource`, it is compared canonically — lowercased
scheme and host, no trailing slash, no fragment — rather than byte-for-byte against
whatever the operator typed, which is what Anthropic's troubleshooting guidance calls for.
An absent `resource` defaults to this service's own resource rather than failing.

## 5. Human authentication

One operator account: `AUTH_USERNAME` plus `AUTH_PASSWORD_HASH` in the format
`scrypt$N$r$p$salt$hash`, generated by the bundled `npm run hash-password`. Verification
is constant-time. This uses `node:crypto` only — no native build under Alpine, no
additional dependency.

Failed attempts are throttled in process (5 per 15 minutes per IP) and logged in the
shape `docs/HARDENING.md` currently sketches as an illustration, so the fail2ban filter
documented there becomes real rather than hypothetical.

`POST /authorize` is protected by an Origin/Referer check plus a signed request token
bound to the authorization request, satisfying the CSRF requirement in
`docs/HARDENING.md`.

There is no self-registration and no open sign-up.

## 6. Deployment

The target host runs **Nginx Proxy Manager** in a container, not the hand-written nginx
described in `docs/DEPLOYMENT.md`. NPM cannot reach the host's `127.0.0.1`, and the
other applications on that host publish ports on `0.0.0.0` — which for this service
would be weaker than the loopback binding the connector documents.

The arrangement chosen is stricter than either:

    ~/mail-mcp/
      docker-compose.yml
      secrets/{auth_token,oauth_signing_key,auth_password_hash}.txt
      data/accounts.json          (mailbox credentials, mode 600, owned by 100:101)
      data/oauth-state.json

- `mail-oauth` joins the external `proxy_default` network **and** an internal network
- `mail-mcp` joins **only** the internal network
- **no port is published to the host at all**
- NPM terminates TLS and proxies `https://<host>` to `http://mail-oauth:8080`

The connector is then unreachable from the host network entirely — tighter than binding
to loopback — and it reuses the existing proxy rather than standing a second nginx
beside it. The repository's `docker-compose.yml` keeps its loopback form for deployments
that do use a hand-written nginx; the host arrangement is documented as a second variant.

Secrets follow the file-based Docker secrets pattern already used by the other
applications on that host.

Two prerequisites are the operator's, not this service's:

1. A DNS **A** record (IPv4 — see §1.4.2) for the public hostname.
2. `accounts.json` with real mailbox credentials, placed on the host directly.

## 7. Testing

Unit coverage: discovery documents including exact `resource` matching; PKCE S256
verification with its failure cases (wrong verifier, `plain` method, missing challenge);
authorization codes single-use and expiring; token issuance, audience and expiry;
refresh rotation and reuse detection returning `invalid_grant`; redirect allowlist
rejecting foreign URIs; scrypt verification; CSRF rejection; login throttling.

Integration coverage against a stub upstream: an unauthenticated `POST /mcp` returning
401 with a correct `WWW-Authenticate`; the full `authorize -> token -> /mcp` path; proof
that the upstream receives `Bearer <UPSTREAM_AUTH_TOKEN>` **and that the token appears
in nothing the client can see**; `text/event-stream` forwarded without buffering.

Everything is run in a `node:22-alpine` container before being reported as passing —
the development machine runs Node 24, and that difference has already surfaced late in
CI once in this project.

## 8. CI

`_test.yml` gains a second job covering `oauth/` (typecheck, unit, integration).
`release.yml` gains a second build-and-push job for the OAuth image, gated on the same
`needs: test`, so publication stays coupled to tests passing in the same run. `ci.yml`
gains the matching Docker build smoke test.

## 9. Sources

- MCP Authorization, revision 2025-06-18 —
  <https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization>
- MCP Authorization, draft —
  <https://modelcontextprotocol.io/specification/draft/basic/authorization>
- MCP versioning (current revision 2026-07-28) —
  <https://modelcontextprotocol.io/specification/versioning>
- Authentication for connectors —
  <https://claude.com/docs/connectors/building/authentication>
- Lazy authentication —
  <https://claude.com/docs/connectors/building/lazy-authentication>
- Troubleshooting connectors —
  <https://claude.com/docs/connectors/building/troubleshooting>
- RFC 9728 Protected Resource Metadata, RFC 8414 Authorization Server Metadata,
  RFC 8707 Resource Indicators, RFC 7591 Dynamic Client Registration,
  RFC 7636 PKCE, RFC 6749 error codes, RFC 8252 §7.3 loopback redirects
