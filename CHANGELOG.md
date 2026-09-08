# Changelog

All notable changes are documented here. This project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
