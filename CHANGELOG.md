# Changelog

All notable changes are documented here. This project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **The three random secrets generate themselves on first boot.** `auth_token`, `oauth_signing_key` and `settings_signing_key` are read from their configured `*_FILE` path if it is there, and created at that path if it is not — mode `640`, in the group both images share. `PUBLIC_URL` and the operator's password hash are the only values left to supply by hand, and the hash goes away with the setup wizard. Each service logs one `secret resolved` line per secret saying whether it read the file or created it. The connector gained `AUTH_TOKEN_FILE` for this; it previously took `AUTH_TOKEN` inline only.

  **A present file always wins**, which is what makes this safe for an instance that is already running: an upgrade reads the secrets it already has and rotates nothing. An inline `AUTH_TOKEN` with no file yet is written to the file rather than replaced, so an install that kept its token in `.env` keeps that token and hands the OAuth layer the same one.

- **A shared group, `mailsecrets` (gid 105), in both images.** The connector runs as uid 100/gid 101 and the OAuth layer as uid 102/gid 103, deliberately sharing nothing; this one group is the exception, and it is what lets each read a secret the other wrote without those files being world-readable. The gid is pinned in both `Dockerfile`s and published as a `secrets-gid` label; a unit test compares the two against the constant in the code.

### Changed

- **`docker-compose.yml` mounts `./secrets` as a directory** instead of declaring four Docker file-secrets. Compose refuses to start a stack whose file-secret does not exist, which is exactly the state a first boot is in. The same `secrets/*.txt` files are used, now at `/secrets/<name>.txt` rather than `/run/secrets/<name>`; existing deployments keep their values.

  The directory must be group-owned by gid 105 and **setgid**: `chgrp 105 secrets && chmod 2770 secrets`. The setgid bit is what makes a file created by one service land in the shared group instead of the creator's own. `2770` also keeps other accounts on the host out — with "a present file wins", a directory anyone could write to would let a local user choose the `auth_token` the connector adopts. Pre-creating the files by hand and mounting `./secrets` read-only remains an option.

### Fixed

- **A mailbox already configured as `new` or `test` now says why editing it does nothing.** Those two ids are literal segments in the settings routes, so an account under one of them cannot be edited in place — the edit form for `test` posts to the create form's connection probe and silently never persists, and `new` opens the "Add mailbox" form instead. Creating such an account has been refused since 0.6.0, but one that already exists keeps loading on purpose (refusing the file would take every other mailbox down with it), and nothing told its operator what was wrong. The server now warns once at startup, naming the account, and the mailbox list page repeats it on that account's own row. Delete and "Make default" are unaffected and remain the way out: delete the mailbox and recreate it under another id.

- **A wrong password in the connection test reported `Command failed`.** Telling "these credentials are wrong" apart from "this host is unreachable" is the reason the connection test exists, and it got the common case backwards: the probe recognised only imapflow's `AuthenticationFailure`, which that library throws in a handful of narrow situations that do not include the ordinary rejection. A server answering `LOGIN` with a tagged `NO` — what a mistyped password actually looks like — surfaced as a generic `Command failed`, which reads like a connectivity problem. The probe now classifies on the authentication stage itself (imapflow's `authenticationFailed` together with a real `NO`/`BAD` from the server, or RFC 5530's `AUTHENTICATIONFAILED` response code) and reports "the server rejected these credentials". A connection that dies mid-login still reads as a connectivity failure, which is asserted in both directions. Closes the known limitation noted under 0.6.0.

## [0.6.3] — 2026-09-09

Both fixes below are the same defect as 0.6.1 and 0.6.2, found by auditing every security header this project emits against what a browser actually does with it, rather than against what the string says.

### Fixed

- **The reference nginx config would have silently reverted the 0.6.1 fix.** `docs/DEPLOYMENT.md` set `Referrer-Policy: no-referrer` with `add_header` at the server level, and the same document tells the operator to point that server block at the OAuth service. nginx's `add_header` *appends* rather than replacing a header the proxied response already carries, so a browser would receive two policies — the application's `same-origin` and nginx's `no-referrer` — and the last valid token wins. Any deployment following this repository's own hardening guidance would have reproduced the "Request blocked" sign-in failure with correct code underneath. The blanket header is gone, with an explanation and the `proxy_hide_header` remedy for anyone who wants a policy on non-HTML endpoints. `SECURITY.md`, `README.md` and `docs/HARDENING.md` claimed the same thing as shipped fact and are corrected.

- **The connector's settings pages still sent `no-referrer`,** contradicting the comment directly above them claiming a byte-for-byte mirror of the OAuth layer's header set. Not exploitable today — the connector verifies CSRF against the proxied assertion's `csrf` claim and never reads `Origin` or `Referer` — but it was a trap for anyone who later adds such a check while trusting that comment.

## [0.6.2] — 2026-09-09

### Fixed

- **The authorization flow could not complete in Chrome.** The consent screen served `form-action 'self'`, and submitting it redirects to the client's registered `redirect_uri`. Chrome enforces `form-action` against the **redirect target** as well as the action URL, so the hand-off to `https://claude.ai/...` was blocked and the flow died on its last step with nothing but a console error — the server had already issued the authorization code. The consent page's `form-action` now lists the origins of the registered redirect allowlist alongside `'self'`, which is exactly the set of destinations an authorization code could already legitimately be sent to. The settings pages, which never redirect off-origin, keep the tighter `'self'`.

## [0.6.1] — 2026-09-09

### Fixed

- **Signing in through a browser was impossible.** Both the settings sign-in and the `/authorize` consent screen served `Referrer-Policy: no-referrer`, and their POST handlers verify the request came from this site with `isSameOrigin()`, which reads `Origin` and falls back to `Referer`. Chrome sends no `Origin` header on a *same-origin* form POST, so the policy removed the only remaining signal and every submission was refused with "Request blocked". Both pages now send `Referrer-Policy: same-origin`, which still withholds the referrer from any cross-origin destination — the property that mattered — while leaving the same-origin check something to read.

  The consent-screen half of this has been present since 0.4.0 and is why no client had ever completed a browser sign-in.

## [0.6.0] — 2026-09-09

A browser settings UI. Mailboxes can be added, tested, edited and removed without a shell on the server; connected Claude clients can be reviewed and revoked; the operator password can be changed.

Three error messages in this repository had promised that page since 0.2.0 and sent anyone who followed them to a 404. They now name the real one.

### Added

- **Mailbox management at `/settings/mailboxes`.** Create, edit, delete and set the default account from the browser. Writes go through an atomic, round-trip-validated path: the serialised file is handed back to the same parser the loader uses, written to a `0600` temp file, `fsync`ed and renamed into place, so the connector can never write a file it would refuse to read. A hidden size-and-mtime stamp catches a concurrent hand edit and re-renders instead of clobbering it.
- **A connection test before saving.** IMAP, SMTP and CalDAV are probed concurrently against the submitted values, merged with stored passwords where a field was left blank, so an existing account can be tested without retyping. Nothing is persisted. Every probe is bounded at the library level and torn down when its budget expires.
- **Connected clients at `/settings/clients`.** Registered clients and live refresh sessions, each revocable. Revoking a client takes effect on its already-issued access tokens immediately, via a token epoch and a per-client `revokedAt` compared at verification — not an hour later when the token would have expired anyway.
- **Operator password change at `/settings/password`,** with an opt-in checkbox to disconnect every Claude client at the same time. Changing the password invalidates every browser session, including the one making the change.
- **A stateless operator session.** `__Host-`prefixed cookie, HS256, 60-minute absolute lifetime re-issued on each authenticated GET. The only server-side state is one integer, `sessionEpoch`, which every token carries a copy of — bumping it is what makes "sign out everywhere" and a password change mean anything.

### Changed

- **The connector's `./data` mount is writable.** It is the only process that writes `accounts.json`, and already the only one that reads the credentials in it. The **directory** must be writable by uid 100, not merely the file — saving renames a temp file into place, so missing this is an `EACCES` on first save rather than at startup.
- **The live operator password hash moved** from the read-only `/run/secrets` mount to `oauth-data/operator.json`. `AUTH_PASSWORD_HASH` now seeds that record once and is ignored afterwards; the service logs which source is live and warns by name when the two differ. `OPERATOR_FILE=none` restores the previous behaviour and disables the password-change page.
- **The proxy strips `Cookie` before forwarding.** The session cookie is `Path=/` by virtue of the `__Host-` prefix, so the browser sends it to `/mcp` and `/token` as well. The connector authenticates settings requests by assertion alone and must never be able to read browser state.
- `docs/DEPLOYMENT.md` gained a step for enabling the UI, and four claims that stopped being true when the OAuth layer shipped in 0.4.0 were corrected.

### Security

- A new Docker secret, `settings_signing_key`, mounted into **both** services. It signs a 30-second HMAC assertion binding each proxied settings request to its method and path. Deliberately not the OAuth signing key: a compromised connector must not be able to mint access tokens for `/mcp`. Without the secret the connector refuses `/settings/*` outright and the UI is not mounted — the feature is off, not half-on.
- CSRF is checked twice over: a same-origin check and a token, and for the proxied mailbox routes the connector verifies that token against the assertion's own `csrf` claim, having never seen the session cookie.
- No stored password ever reaches the rendered HTML. The password field helper takes no value parameter, so it cannot emit one, and the error re-render strips password keys before the values reach the template.

### Known limitations

- Revoking a single **session** stops it refreshing but leaves its current access token valid until it expires; revoking the **client** is immediate for both. See issue #2.
- The connection test does not yet distinguish a rejected password from an unreachable host in the most common case. See issue #3.

## [0.5.0] — 2026-09-08

Runtime and dependency refresh, together with the release pipeline that is meant to keep it from drifting this far again. Not a patch release: the Node floor moves from 20/22 to 24, and four dependencies cross a major boundary.

The only source change the whole refresh required was one type in `src/smtp-client.ts`. All 297 tests pass unchanged.

### Changed

- **Node 24 is the only supported runtime.** `engines.node` becomes `>=24.0.0` in both packages, both Dockerfiles build on `node:24-alpine`, and CI runs the suites on 24. Node 24 is the active LTS line ("Krypton"), maintained into 2028. Node 26 already exists but does not become LTS until October 2026; the move happens then, in both Dockerfiles, both `engines` fields and `_test.yml` at once, and a note in `Dockerfile` says so. Previously the floor admitted Node 20.19 and 22.7 — versions nothing tested.
- **Connector dependencies.** Four of these cross a major boundary; none of them needed a code change:

  | | from | to |
  | --- | --- | --- |
  | `@modelcontextprotocol/sdk` | ^1.6.1 | ^1.30.0 |
  | `express` | ^5.0.1 | ^5.2.1 |
  | `ical.js` | ^2.1.0 | ^2.2.1 |
  | `imapflow` | ^1.0.180 | **^2.0.0** |
  | `mailparser` | ^3.7.2 | ^3.9.23 |
  | `nodemailer` | ^8.0.7 | **^10.0.1** |
  | `tsdav` | ^2.1.5 | ^2.3.3 |
  | `zod` | ^3.23.8 | **^4.5.4** |
  | `@types/express` | ^5.0.0 | ^5.0.6 |
  | `@types/mailparser` | ^3.4.5 | ^3.4.6 |
  | `@types/node` | ^22.10.0 | ^24.13.3 |
  | `tsx` | ^4.23.1 | ^4.23.13 |
  | `typescript` | ^5.7.2 | **^7.0.2** |

  `zod` 4 is safe here because the MCP SDK declares `zod: "^3.25 || ^4.0"` — the connector's tool schemas and the SDK now agree on the same major.

- **OAuth layer dependencies.** `@types/node` ^22.20.1 → ^24.13.3 and `typescript` ^5.9.3 → ^7.0.2. `express` and `jose` were already current.
- **`SendResult.response` is optional.** nodemailer's own types, which replaced `@types/nodemailer`, declare the server's final SMTP reply as optional, because not every transport produces one. The absence is passed through rather than replaced with an empty string: the field reaches the model, and an empty reply reads as a reply that was empty.
- **`main` and version tags now have separate pipelines.** `ci.yml` owns branches: it runs the suite and, on `main`, publishes both images tagged `sha-<short>` and nothing else. `release.yml` triggers only on `v*` and owns `X.Y.Z` and `latest`. Previously both workflows triggered on `main`, so every push ran the whole suite twice and built both images three times over — and `latest` tracked the last merge rather than the last release. `:latest` now always names a release; `sha-<short>` is how an unreleased commit is run.
- **The `{{major}}` and `{{major}}.{{minor}}` image tags are gone.** They came from `docker/metadata-action`'s example configuration, which encodes the convention of the official base images: independent consumers tracking a minor line and receiving patches without editing anything. Nothing in this repository referred to them — `docker-compose.yml`, the README and `docs/DEPLOYMENT.md` all use `latest`. For a 0.x project `0` also claims a compatibility line SemVer explicitly withholds. And moving tags are the only tags an older release can overwrite: pushing `v0.3.0` and `v0.4.0` together once left `0` pointing wherever the race landed, because the concurrency group is keyed per ref.

### Added

- **`scripts/check-versions.sh`** — fails when the eight places this repository states its version stop agreeing (`package.json`, `oauth/package.json`, both lockfiles at two positions each, and the `VERSION` constant in each `app.ts`). Given a tag it also requires the tree to match it and `CHANGELOG.md` to carry the matching `## [x.y.z]` section. Both workflows run it before anything is built; run it by hand before tagging.
- **A GitHub release per tag**, with the matching CHANGELOG section as its body. Cut with the runner's preinstalled `gh` rather than a third-party action.
- **Build provenance and an SBOM for every published image.** Provenance comes from `actions/attest-build-provenance` rather than buildx, which writes its attestations into the manifest index where registry interfaces show them as an `unknown/unknown` platform; verify with `gh attestation verify`.
- **Every GitHub Action is pinned to a commit sha**, with the version in a trailing comment, and every pin moved to its current major — the tree was between one and three majors behind on all seven. A major-version tag is mutable by whoever controls the action's repository.
- **Dependabot now covers npm and Docker**, not just Actions. Its absence for npm is the direct reason the dependency set drifted far enough to need one large refresh instead of a stream of small ones. Major updates of the Node base image are ignored on purpose: which Node line this runs on is a decision about long-term support, not a number to chase.
- **`.gitattributes`** keeping `*.sh` at LF. This repository is developed on Windows with `core.autocrlf=true`, and a shell script checked out with CRLF fails on Linux with `bash: \r: command not found` — including `scripts/check-versions.sh`, which now gates every release.

### Removed

- **`@types/nodemailer`** — nodemailer ships its own type definitions from version 10 on, and they are stricter than the community package they replace.

## [0.4.0] — 2026-09-08

OAuth 2.1 authorization layer, so Claude's hosted surfaces can connect. No change to the connector's own behavior: Claude Desktop and Claude Code still talk to it directly with the static `AUTH_TOKEN` and need none of this.

From this release the connector and the OAuth layer are versioned and released together, from the same commit and the same workflow run — `release.yml` already tagged their images in lockstep, and the in-tree versions now agree with it. That is why `oauth/package.json` moves from 0.1.0 straight to 0.4.0.

### Added

- **`oauth/` — a second service**, published as `ghcr.io/yannichock/claude-mail-mcp-oauth`. It exists because claude.ai web and Cowork cannot send a custom `Authorization` header: they require OAuth discovery and a browser sign-in, which the connector does not speak. It runs as uid 102 / gid 103 — deliberately not the connector's 100/101, so neither container can read the other's data — and is the only one of the two on the reverse proxy's network.
- **Discovery** — RFC 9728 protected-resource metadata and RFC 8414 authorization-server metadata. The protected-resource document is served both at the bare well-known path and at the path-suffixed variant Claude probes first, so neither probe order misses.
- **Dynamic client registration** (RFC 7591) against a redirect-URI allowlist. Claude's two hosted callbacks are always allowed; loopback redirects are off by default, because the client that would use them (Claude Code) has the simpler static-token path available. Registrations are capped at 200, oldest evicted first.
- **Authorization endpoint with PKCE S256**, required rather than optional. The operator signs in with a username and an scrypt password hash. The step holds no server-side state: the authorization request is signed into a hidden form field that doubles as the CSRF token, which also pins the redirect URI between the two requests. An Origin/Referer check runs alongside it, and failed sign-ins are throttled at 5 per 15 minutes per client address.
- **Token endpoint** — `authorization_code` and `refresh_token`. Refresh tokens rotate on every use, and presenting a rotated token revokes the whole family: a replayed refresh token is evidence of theft, not of a retry.
- **Authenticated proxy in front of `POST /mcp`.** The client's bearer token is verified and then *replaced* with the connector's static `AUTH_TOKEN`; neither credential is ever passed through to the other side. Nothing is buffered, so a streamed response reaches the client as it is produced; hop-by-hop headers are dropped in both directions and the connector's own `WWW-Authenticate` is suppressed, since sending its static-token challenge to an OAuth client would start a flow that cannot succeed.
- **State file** (`oauth-state.json`) for registered clients and live refresh sessions — written to a sibling temp file and renamed into place, so a crash mid-write leaves the previous version intact. An unreadable file is moved aside and the service starts empty rather than refusing to boot.
- **`hash-password` CLI** (`dist/hash-password.js`) for generating the operator's scrypt hash.
- **Docker file-secrets** for the connector token, the signing key and the password hash: mounted read-only under `/run/secrets`, invisible to `docker inspect` and absent from the process environment.
- **CI** — `_test.yml` gains a job for the new package, and `release.yml` publishes both images behind the same `needs: test` gate. 201 unit and 57 integration tests.

### Fixed

- **The login throttle is keyed on the address the proxy observed.** `trust proxy` is a hop count, never `true`: `true` takes the leftmost `X-Forwarded-For` entry, which the client writes, so an attacker could pick a fresh `req.ip` per attempt and never be throttled — and could write an address of their choosing into the log line a fail2ban filter reads.
- **The documented `hash-password` invocation now works.** The image's `ENTRYPOINT` is `node dist/index.js`, so a trailing command is appended as arguments and starts the server instead of the hashing tool; the procedure needs `--entrypoint node`.

## [0.3.0] — 2026-09-08

Test foundation, Docker packaging and CI. No runtime behavior changes.

### Added

- **Unit test suite** (`npm run test:unit`, also `npm test`) — 25 offline tests covering account loading/validation, `resolve()`, `publicSummaries()` credential redaction, hot reload, and the `ClientPool`, plus config defaults/overrides/validation. No network, no Docker required.
- **Integration test suite** (`npm run test:integration`) — 14 tests: 9 exercise the IMAP/SMTP tools end-to-end against a disposable [GreenMail](https://greenmail-mail-test.github.io/greenmail/) container, 5 exercise the MCP protocol surface (auth rejection, `initialize`, `tools/list`, `/health`). Starts and tears down its own GreenMail container; skips cleanly instead of failing when the Docker daemon isn't reachable.
- **`docker-compose.test.yml`** — the disposable GreenMail fixture the integration suite runs against. Not part of the application's own deployment.
- **`Dockerfile`** — multi-stage Node 22 Alpine build (~284 MB final image), runs as a non-root `mailmcp` user, `HEALTHCHECK` against `/health`, container-appropriate defaults (`HOST=0.0.0.0`, `ACCOUNTS_FILE=/data/accounts.json`) with an inline warning against publishing the port on anything but `127.0.0.1`.
- **`docker-compose.yml`** — reference deployment for the image: publishes `127.0.0.1:3220:3220` only, mounts `/data` read-only, reads secrets from `.env`. Includes a commented anchor for where a future OAuth shim would attach as a second service.
- **`.env.docker.example`** — container-side environment template for `docker-compose.yml`.
- **CI** (`.github/workflows/`): `_test.yml` (reusable — typecheck, unit tests, integration tests against GreenMail), `ci.yml` (runs `_test.yml` on every push to `main` and every pull request, plus a Docker build smoke test with no push), `release.yml` (runs `_test.yml` as a gate, then builds and pushes a multi-arch amd64/arm64 image to `ghcr.io/yannichock/claude-mail-mcp` on push to `main` and on `v*` tags).
- **`createApp()`** exported from `src/app.ts` (re-exported from `src/index.ts`) — builds the Express app, so the integration tests exercise the shipped routes and Bearer check instead of a hand-maintained copy in `test/helpers/mcp-app.ts`. No behaviour change.
- **`tsconfig.test.json` and `npm run typecheck:test`** — `tsc --noEmit` compiled nothing under `test/`, and `tsx` strips types without checking them, so the test suite was never typechecked anywhere. CI now runs it.
- **README**: "Run with Docker" section (`docker run` and `docker compose` paths, GHCR image) and "Development" section (`npm run test:unit` / `npm run test:integration`).
- **`docs/DEPLOYMENT.md`**: new "Container deployment (Docker)" section alongside the existing systemd path — pull the image, configure `.env` and `accounts.json`, start compose, same nginx/Claude steps as the systemd deployment.

### Fixed

- **`.gitignore`** now covers `accounts.json` and `data/`. Both README and `docs/DEPLOYMENT.md` tell operators to create a plaintext-credential `accounts.json` inside a git checkout; neither location was ignored, so `git add -A` would have committed live mailbox passwords.
- **The documented Docker deployment no longer crash-loops.** `chmod 600 data/accounts.json` alone leaves the file unreadable to the container's non-root user, which is a fatal startup error and, with `restart: unless-stopped`, an endless restart loop. The procedure now `chown`s to the container's uid/gid as well, and those ids are pinned in the `Dockerfile` (uid 100, gid 101) instead of being whatever busybox allocated.
- **The documented systemd deployment is now followable.** `ACCOUNTS_FILE` defaulted to `/root/.config/mail-mcp/accounts.json`, unreachable under `User=mailmcp` + `ProtectHome=true`; step 2 told the reader to fill in variables removed in 0.2.0; and no step ever created `accounts.json`. `/var/lib/mail-mcp/accounts.json` is now the single documented location, agreed on by `.env.example`, `docs/DEPLOYMENT.md`, `docs/HARDENING.md` and `SECURITY.md`.
- **nginx rate limit on `/mcp` raised from 10r/m to 120r/m** (`burst=60`). Every MCP message is a separate `POST /mcp`, so the old login-form rate returned 503 mid-conversation. Restated in `SECURITY.md`, `docs/HARDENING.md` and `README.md`.
- **`.env.example`, `.env.docker.example` and `CONTRIBUTING.md`** no longer describe an OAuth shim's `/settings` UI, an `UPSTREAM_BEARER_FILE`, or the `IMAP_*`/`SMTP_*`/`DEFAULT_FROM` variables removed in 0.2.0.
- **`docs/DEPLOYMENT.md`'s `/health` sample** matched no real response (`caldav_enabled` is per account inside `accounts[]`, never top-level), and its backup note called the service stateless while `docs/HARDENING.md` called it stateful. Following the former would have lost every mailbox credential.
- **`README.md`**: "one Node process per mailbox" and "credentials in a single `.env` file" were both wrong; the roadmap still claimed a browser setup flow that does not exist; and the security summary presented systemd-only properties as defaults of the Docker-first deployment.
- **`docs/HARDENING.md`** rotated `AUTH_TOKEN` in `/var/www/mcp-mail.markusstoeger.com/.env` while `docs/DEPLOYMENT.md` installs to `/var/www/mail-mcp/`; the `sed -i` errored and the operator believed the token had rotated. `ecosystem.config.cjs` had the same stale path.
- **`docker-compose.test.yml`** pins GreenMail to `2.1.13` by digest instead of `:latest`, so an upstream release cannot break CI on a day nobody touched the repository.
- **`docs/DEPLOYMENT.md`**'s nginx vhost uses `listen 443 ssl;` plus `http2 on;` — `listen ... http2` has been deprecated since nginx 1.25.1.
- **`docs/DEPLOYMENT.md`** no longer describes a "bundled OAuth shim" — none ships with this repository. The claude.ai web (Option B) section and the htpasswd note in the service-user setup now say plainly that the OAuth 2.1 + DCR + PKCE layer is a prerequisite the operator has to supply, not a shipped component, and no longer link to a reference implementation that doesn't exist (the previously linked repository 404s).

- **`npm run test:unit` now passes on Node 22, the version the Docker image ships.** `tsx` 4.22.3's ESM `resolve` hook reported `format: "commonjs"` for `tsdav`'s `dist/tsdav.esm.js` — an ESM file inside a package with no `"type": "module"`. A hook-supplied format suppresses Node's module-syntax detection, so the file was instantiated as a CommonJS record whose named exports are recovered by `cjs-module-lexer`, which finds none in ESM syntax; `import { createDAVClient } from "tsdav"` then failed at instantiation. tsx only takes that code path below Node 24.11.1, where it falls back from `module.registerHooks()` to `module.register()` — which is why the same suite passed on Node 24. Fixed upstream in tsx 4.23.1; the dev dependency floor is now `^4.23.1`. No `src/` change: the compiled `dist/` was never affected.
- **`engines.node` was not true.** `>=20` admitted Node versions on which the compiled `dist/` cannot load at all: below Node 20.19 / 22.7 the same `tsdav` packaging defect makes `import { createDAVClient } from "tsdav"` throw `Named export 'createDAVClient' not found`. Verified failing on 20.10.0, 20.18.3 and 22.6.0, and passing on 20.19.6, 22.7.0 and 24.20.0. The floor is now `^20.19.0 || >=22.7.0`; `docs/DEPLOYMENT.md` says the same.

## [0.2.1] — 2026-05-21

Security hardening pass. No new features; no breaking API changes.

### Security

> **Note added later:** three of the bullets below — the CSRF guard on
> `/settings/*`, the rate limit on `/authorize` and `/settings`, and the
> systemd hardening of "the OAuth shim" — describe an OAuth shim that is **not
> part of this repository** and never has been. This server exposes no
> `/settings` or `/authorize` route and has no browser-facing, cookie- or
> session-authenticated endpoint at all. The entries are left as written
> because a changelog records what was claimed at the time; treat them as
> historical, not as a description of anything this project ships. See
> [SECURITY.md](SECURITY.md) and [docs/HARDENING.md](docs/HARDENING.md) for
> what actually exists.

- **Upgraded `nodemailer` to 8.0.7** — fixes 4 high-severity CVEs (GHSA-mm7p-fcc7-pg87 wrong-domain, GHSA-rcmh-qjqh-p98v DoS via addressparser, GHSA-c7w3-x93f-qmm8 SMTP injection via envelope.size, GHSA-vvjj-xcjg-gr5g SMTP injection via transport name).
- **Backend now binds to `127.0.0.1` by default** (`HOST` env var, default `127.0.0.1`). Defense-in-depth on top of UFW.
- **CSRF guard on `/settings/save`, `/settings/delete`, `/settings/set-default`** — Origin/Referer header must match the configured issuer. Rejects state-changing cross-origin POSTs.
- **nginx security headers added**: `Strict-Transport-Security: max-age=63072000; includeSubDomains`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex, nofollow, noarchive`.
- **nginx rate-limit on auth endpoints**: 10 req/min per IP with burst of 5 on `/authorize` and `/settings`. Brute-force htpasswd attempts return 429.
- **Backend and OAuth shim now run as a dedicated non-root `mailmcp` system user** (no shell, no home directory). Both services have full systemd hardening: `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome=true`, `ProtectKernel*`, `ProtectClock`, `ProtectHostname`, `ProtectProc=invisible`, `RestrictNamespaces`, `RestrictRealtime`, `RestrictSUIDSGID`, `LockPersonality`, `SystemCallFilter=@system-service ~@privileged @resources`.
- **Backend migrated from pm2 to a hardened systemd unit** (`claude-mail-mcp.service`). pm2 still works for local dev; production uses systemd.
- **State directory moved to `/var/lib/mail-mcp/`** (owned by `mailmcp`, chmod 700) from `/root/.config/mail-mcp/`. The htpasswd file is now `chmod 640 root:mailmcp` (was `644`).
- **New [SECURITY.md](SECURITY.md) and [docs/HARDENING.md](docs/HARDENING.md)** — full threat model, defaults explained, operator hardening checklist, walked-through scenarios.

### Added

- `HOST` env var for the listen interface (default `127.0.0.1`).

### Changed

- The DEPLOYMENT.md recipe now uses systemd for the backend (not pm2), runs as `mailmcp`, and stores state under `/var/lib/mail-mcp/`. The pm2 example is kept for local dev.

## [0.2.0] — 2026-05-21

Multi-account per deployment. Browser-based setup flow.

### Added

- **`list_accounts` tool** — returns all configured accounts (id, label, default flag, From-address, CalDAV-enabled flag), never credentials
- **Optional `account` parameter on every tool** — selects which mailbox to act on; omit for the default account
- **`accounts.json` credential store** — JSON file replaces v0.1's IMAP/SMTP env vars; chmod 600, hot-reloaded via `fs.watch`
- **Browser-based setup UI** in the bundled OAuth shim — add / edit / delete accounts through a form, no SSH required
- Friendly error when no accounts are configured: `list_accounts` returns an explanatory note; other tools surface a clear "open /settings" message

### Changed

- **BREAKING:** `.env` no longer contains IMAP_, SMTP_, CALDAV_, DEFAULT_FROM_, DRAFTS_FOLDER, SENT_FOLDER. Those move to `accounts.json`. Only PORT, PUBLIC_URL, LOG_LEVEL, AUTH_TOKEN, ACCOUNTS_FILE remain.
- Calendar tools (`list_calendars`, `list_events`, `create_event`, `find_free_slot`) are now always registered; they error with a clear message if the resolved account has no CalDAV configured.
- IMAP/SMTP/CalDAV clients are instantiated per account via a lazy `ClientPool`. Reset on every `accounts.json` change.

### Migration from v0.1

Before:
```env
IMAP_HOST=imap.mailbox.org
IMAP_USER=hi@example.com
IMAP_PASS=secret
... etc
```

After (`accounts.json`, chmod 600):
```json
{
  "version": 1,
  "accounts": [
    {
      "id": "main",
      "label": "Main mailbox",
      "default": true,
      "imap": { "host": "imap.mailbox.org", "port": 993, "user": "hi@example.com", "pass": "secret", "tls": true },
      "smtp": { "host": "smtp.mailbox.org", "port": 465, "user": "hi@example.com", "pass": "secret", "tls": true },
      "mail": { "defaultFrom": "hi@example.com", "draftsFolder": "Drafts", "sentFolder": "Sent" }
    }
  ]
}
```

Or visit `/settings` on the deployed connector and fill in the form.

## [0.1.0] — 2026-05-21

Initial release. Single-tenant alpha.

### Added

- **Mail tools (9):** `list_folders`, `list_messages`, `search_messages`, `get_message`, `send_message`, `create_draft`, `mark_read`, `move_message`, `delete_message`
- **Calendar tools (4):** `list_calendars`, `list_events`, `create_event`, `find_free_slot` — only registered if `CALDAV_URL` is set
- IMAP via `imapflow` (single long-lived connection + per-mailbox locks)
- SMTP via `nodemailer` (optional best-effort copy to Sent folder)
- CalDAV via `tsdav` + iCalendar parsing via `ical.js`
- Bearer-token auth on `/mcp`, public `/health` endpoint
- Streamable HTTP MCP transport (compatible with Claude.ai web)
- pm2 ecosystem config for production deployment

### Known limitations

- Single-tenant: one IMAP/SMTP/CalDAV credential set per deployment
- `find_free_slot` working-hours window is interpreted in UTC — pass ISO with offset for local-time anchoring
- CalDAV does not send iMIP invitations automatically (attendees on `create_event` are stored but not notified)
- No threading view (`list_threads` planned for v0.3)
