# claude-mail-mcp

Self-hosted **IMAP / SMTP / CalDAV connector for Claude** with multi-account support. A Streamable HTTP MCP server that lets [Claude.ai](https://claude.ai) read and write your email + calendar against any RFC-compliant mailbox.

> Built because every other Claude email connector targets Gmail. This one is for the rest of us — Mailbox.org, Fastmail, iCloud, Mailcow, iRedMail, Migadu, Nextcloud, your own Postfix box. If your provider speaks IMAP, SMTP and CalDAV, this works. One connector, all your inboxes.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE) [![Node](https://img.shields.io/badge/node-24%2B-brightgreen.svg)](https://nodejs.org)

> **Node requirement:** `>=24.0.0` (see `engines` in [`package.json`](package.json)). Node 24 is the active LTS line; both images are built on `node:24-alpine` and CI runs the suites on 24, so that is the only version this project claims to work on. Node 26 becomes LTS in October 2026 and is the intended next step.

> **This is a maintained fork** of [maxx3250/claude-mail-mcp](https://github.com/maxx3250/claude-mail-mcp), living at [YannicHock/claude-mail-mcp](https://github.com/YannicHock/claude-mail-mcp). The Docker image, `docker-compose.yml`, the test suites and the CI/CD pipeline described below exist only in this fork, so clone from here, open issues here, and report security problems here — see [SECURITY.md](SECURITY.md).

---

## What it does

Exposes 14 MCP tools to Claude:

**Accounts (1)**

| Tool | Purpose |
|------|---------|
| `list_accounts` | List all configured mailboxes — id, label, default flag, From, CalDAV-enabled. Never returns credentials. |

**Mail (9)**

| Tool | Purpose |
|------|---------|
| `list_folders` | Enumerate IMAP mailboxes (`INBOX`, `Sent`, …) |
| `list_messages` | Newest N messages in a folder |
| `search_messages` | Server-side IMAP search (from/to/subject/body/date/flags) |
| `get_message` | Full body + headers + attachment metadata |
| `send_message` | Send via SMTP, optionally copy to Sent folder |
| `create_draft` | Build RFC-822 and APPEND to Drafts |
| `mark_read` | Toggle `\Seen` flag |
| `move_message` | Move between folders |
| `delete_message` | Delete (destructive — prefer move to Trash) |

**Calendar (4)**

| Tool | Purpose |
|------|---------|
| `list_calendars` | Discover CalDAV calendars |
| `list_events` | Events in a time window (recurrences expanded) |
| `create_event` | Add new event (writes to CalDAV) |
| `find_free_slot` | Compute free intervals across one or more calendars |

Every tool accepts an optional `account: "<id>"` parameter to pick a mailbox; omit it to use the default account. So "list unread in INBOX of work account" vs "compare today's calendar across work and personal" both work in one connector.

---

## Why bring-your-own-server?

Hosted email-AI services need full mailbox access. That's a lot of trust to hand to a vendor. This connector flips the model: **you run it, you hold the credentials, no third party between Claude and your inbox**.

- One Node process for all your mailboxes
- Credentials in a single `accounts.json` you own, on your own disk
- One Bearer token gates every MCP call
- Add the URL to Claude.ai once, done

---

## Quick start

```bash
git clone https://github.com/YannicHock/claude-mail-mcp.git
cd claude-mail-mcp
npm install
cp .env.example .env
# Generate an AUTH_TOKEN and fill it into .env:
#   echo "AUTH_TOKEN=$(openssl rand -hex 32)" >> .env
npm run build
npm start
```

The server boots with **no mailboxes configured** — that's fine. Hand-craft an `accounts.json` (no setup UI ships with this repo yet — see [Deployment](docs/DEPLOYMENT.md) for the OAuth-shim caveat):

```json
{
  "version": 1,
  "accounts": [
    {
      "id": "main",
      "label": "Main",
      "default": true,
      "imap": { "host": "imap.mailbox.org", "port": 993, "user": "you@example.com", "pass": "secret", "tls": true },
      "smtp": { "host": "smtp.mailbox.org", "port": 465, "user": "you@example.com", "pass": "secret", "tls": true },
      "mail": { "defaultFrom": "you@example.com", "draftsFolder": "Drafts", "sentFolder": "Sent" }
    }
  ]
}
```

For local development, save it in your checkout and set `ACCOUNTS_FILE=./accounts.json` in `.env` (`accounts.json` and `data/` are git-ignored, so it can't be committed by accident). On a server, `.env.example` already points `ACCOUNTS_FILE` at `/var/lib/mail-mcp/accounts.json`, owned by the `mailmcp` service user at mode 600 — see [Deployment](docs/DEPLOYMENT.md) step 4. The backend re-reads via `fs.watch`, no restart needed.

Smoke test:

```bash
curl http://localhost:3220/health
# {"status":"ok","server":"claude-mail-mcp","version":"0.5.0","accounts":[{…}],…}
```

---

## Run with Docker

Two multi-arch (amd64/arm64) images are published to GHCR: `ghcr.io/yannichock/claude-mail-mcp` and `ghcr.io/yannichock/claude-mail-mcp-oauth`. A push to `main` publishes them tagged `sha-<short>` and nothing else; a `v*` tag publishes `X.Y.Z` and moves `latest`. So **`:latest` always names a release**, and `sha-<short>` is how you run an unreleased commit — it names one commit and can never move. Both images carry a build-provenance attestation, checkable with `gh attestation verify --owner YannicHock oci://ghcr.io/yannichock/claude-mail-mcp:latest`.

The package is newly created and not guaranteed to be public — if `docker pull` gets rejected, `docker login ghcr.io` first with a GitHub token that has `read:packages`.

Either path needs the same two things as the Quick start above: an `AUTH_TOKEN` and an `accounts.json` (an empty one is fine to boot with).

### `docker run`

```bash
mkdir -p data
echo '{"version":1,"accounts":[]}' > data/accounts.json   # or a real one, see Quick start
# Once it holds real credentials, lock it down. The container runs as uid 100 /
# gid 101 (`mailmcp`), so it needs the ownership change as well as the mode —
# `chmod 600` alone makes the file unreadable to the container and the server
# crash-loops on EACCES. See docs/DEPLOYMENT.md, "Container deployment" step 3.
chown 100:101 data/accounts.json && chmod 600 data/accounts.json

docker run -d \
  --name claude-mail-mcp \
  -p 127.0.0.1:3220:3220 \
  -e AUTH_TOKEN="$(openssl rand -hex 32)" \
  -e PUBLIC_URL=https://mcp-mail.example.com \
  -v "$(pwd)/data:/data:ro" \
  ghcr.io/yannichock/claude-mail-mcp:latest

curl http://127.0.0.1:3220/health
# {"status":"ok","server":"claude-mail-mcp","version":"0.5.0","accounts":[],"accounts_file":"/data/accounts.json"}
```

Always publish with an explicit loopback host IP, `-p 127.0.0.1:3220:3220` — **never a bare `-p 3220:3220`**. The image binds `0.0.0.0` *inside* the container out of necessity (that's how Docker's port publishing reaches it at all); the host-side exposure is controlled entirely by how you publish the port. A bare publish puts the unauthenticated `GET /health` endpoint — it leaks the server name, version, account count and `accounts_file` path — on every interface, including the public internet on a host like Hetzner. The `Dockerfile` carries the same warning inline.

### docker-compose

`docker-compose.yml` in this repo already pins the port publish above and mounts `/data` read-only:

```bash
cp .env.docker.example .env
# fill in AUTH_TOKEN, PUBLIC_URL, LOG_LEVEL
mkdir -p data
echo '{"version":1,"accounts":[]}' > data/accounts.json   # or a real one, see Quick start
chown 100:101 data/accounts.json && chmod 600 data/accounts.json   # see note above
docker compose up -d
docker compose logs -f
```

`docker-compose.test.yml` is a separate file for local development only — it spins up a disposable [GreenMail](https://greenmail-mail-test.github.io/greenmail/) server for the integration test suite (see [Development](#development) below) and has nothing to do with running the connector itself.

Neither path includes an OAuth shim — see [Connecting from Claude.ai](#connecting-from-claudeai) and [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) for that prerequisite and for putting nginx in front on a real host.

---

## Connecting from Claude.ai

The server speaks the **Streamable HTTP MCP transport**, gated by a single static Bearer token (`AUTH_TOKEN`). That's everything this repository ships — no OAuth flow, no login UI, no per-user sessions.

- **Claude Desktop**, or any MCP client that lets you set a custom header, can call `/mcp` directly with `Authorization: Bearer <AUTH_TOKEN>` — see [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) for the config snippet. No extra layer needed.
- **Claude.ai (web)** only connects to remote MCP servers that advertise OAuth 2.1 discovery (Dynamic Client Registration + PKCE), which this server doesn't implement. To use it from Claude.ai web you have to put an OAuth 2.1 layer in front yourself — **this repository does not include one, and there is currently no reference implementation to point you at.** See [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) (Option B) and [`docs/HARDENING.md`](docs/HARDENING.md) for what such a layer would need to satisfy.

---

## Provider notes

### App passwords (mandatory on 2FA accounts)

| Provider | IMAP host | SMTP host | App password page |
|----------|-----------|-----------|---------------------|
| Mailbox.org | `imap.mailbox.org:993` | `smtp.mailbox.org:465` | App passwords aren't needed; main password works |
| Fastmail | `imap.fastmail.com:993` | `smtp.fastmail.com:465` | <https://app.fastmail.com/settings/security/devicekeys> |
| iCloud | `imap.mail.me.com:993` | `smtp.mail.me.com:587` (STARTTLS) | <https://appleid.apple.com> → App-Specific Passwords |
| Gmail | `imap.gmail.com:993` | `smtp.gmail.com:465` | <https://myaccount.google.com/apppasswords> |
| Mailcow / iRedMail / Postfix | your server | your server | n/a |

### CalDAV endpoints

| Provider | URL |
|----------|-----|
| Fastmail | `https://caldav.fastmail.com/dav/principals/user/USER@fastmail.com/` |
| Mailbox.org | `https://dav.mailbox.org/caldav/` |
| iCloud | `https://caldav.icloud.com/` |
| Nextcloud | `https://cloud.example.com/remote.php/dav/principals/users/USER/` |

If your provider doesn't speak CalDAV, just omit the `caldav` block from that account in `accounts.json` — the calendar tools are always registered, but they return a clear error for any account with no `caldav` configured. Mail still works regardless.

---

## Architecture

```
Claude Desktop / any Bearer-capable MCP client
    │  HTTPS + Authorization: Bearer <AUTH_TOKEN>
    ▼
nginx (TLS termination, security headers, rate-limit on /mcp)
    │
    ├──▶ /mcp    ─▶ this server (Port 3220, Bearer-auth gated)
    └──▶ /health ─▶ this server (Port 3220)

this server
    ├── ImapClient   ──▶  imapflow  ──▶  IMAP server (993/143)
    ├── SmtpClient   ──▶  nodemailer ─▶  SMTP server (465/587)
    └── CalDavClient ──▶  tsdav     ──▶  CalDAV server
```

Everything is one Node process. IMAP holds a single long-lived connection with per-call mailbox locks. SMTP and CalDAV are stateless per call.

Claude.ai (web) isn't in this diagram: it needs an OAuth 2.1 layer between itself and nginx that this repository doesn't provide — see [Connecting from Claude.ai](#connecting-from-claudeai) above.

---

## Security model

See **[SECURITY.md](SECURITY.md)** for the threat model and **[docs/HARDENING.md](docs/HARDENING.md)** for the full operator checklist.

In one sentence: TLS via Let's Encrypt + HSTS/security headers + a rate-limited static Bearer token + loopback-only binding + a credentials file readable only by the service. **No OAuth, no sessions, and no `/settings` route ship with this repository** — see below.

### Quick summary

The transport, auth, network and output rows below apply to **both** deployments. The **process** and **storage** rows describe the **systemd** deployment in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) specifically — `ProtectSystem=strict`, `ProtectHome`, `SystemCallFilter` and `MemoryMax` are systemd unit settings and have no equivalent in the Docker path, which gets its isolation from the container runtime instead. Each row says which.

- **Transport:** TLS 1.3 (Let's Encrypt, auto-renew), HSTS, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex` — delivered by the nginx config in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).
- **Auth:** `/mcp` is gated by a single static Bearer token (`AUTH_TOKEN`), checked on every request — no OAuth, no per-user sessions, no token expiry. Rate-limited at nginx (120 req/min per IP on `/mcp`, `/health` is unthrottled) — sized for JSON-RPC, where each MCP message is a separate POST, rather than for a login form.
- **Process (systemd path):** Runs as a dedicated non-root `mailmcp` system user (no shell). Full systemd hardening: `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome`, `ProtectKernel*`, `ProtectClock`, `ProtectHostname`, `ProtectProc=invisible`, `RestrictNamespaces`, `LockPersonality`, `SystemCallFilter=@system-service ~@privileged @resources`, `MemoryMax=512M`.
- **Process (Docker path):** Runs as the non-root `mailmcp` user (uid 100) inside the container, with `dist/` and `node_modules/` owned by root so the runtime user cannot rewrite its own code, and `/data` mounted read-only. None of the systemd settings above apply; add container-level limits (`--memory`, `--read-only`, `--cap-drop ALL`) if you want their equivalents.
- **Network:** Backend bound to `127.0.0.1` only — nginx is the only thing that can reach it from outside. UFW default-deny on the host.
- **Storage (systemd path):** Credentials chmod 600, owned by `mailmcp`, in `/var/lib/mail-mcp/`. `.env` chmod 640 `root:mailmcp`. **(Docker path):** `./data/accounts.json` chmod 600, owned by the container's uid 100 / gid 101, bind-mounted read-only at `/data`.
- **Output:** `list_accounts` returns id/label/From — never credentials. Logs never include passwords or Bearer tokens.
- **Destructive tools** (`delete_message`) document irreversibility so Claude.ai surfaces a confirmation step. Prefer `move_message` to a Trash folder for reversibility.

Remote or multi-client access (e.g. Claude.ai web) needs an OAuth 2.1 layer in front that is **not part of this repository** — see [Connecting from Claude.ai](#connecting-from-claudeai) above and [docs/HARDENING.md](docs/HARDENING.md#optional-adding-an-oauth-layer-for-remotemulti-client-access) for what that layer would need to provide.

Full threat-model walkthrough and operator hardening checklist in [docs/HARDENING.md](docs/HARDENING.md). Reporting issues: see [SECURITY.md](SECURITY.md).

---

## Development

```bash
npm install
npm run build       # tsc
npm test            # alias for test:unit
```

`npm run test:unit` runs 25 tests, offline — no network, no Docker required.

`npm run test:integration` runs 14 more: 9 exercise the IMAP/SMTP tools end-to-end against a disposable [GreenMail](https://greenmail-mail-test.github.io/greenmail/) container started from `docker-compose.test.yml`, 5 exercise the MCP protocol surface (auth rejection, `initialize`, `tools/list`, `/health`). The suite manages the GreenMail container itself — no manual `docker compose up` needed — and skips cleanly instead of failing when the Docker daemon isn't reachable.

```bash
npm run test:integration
```

CI runs typecheck (`tsc --noEmit`), the unit suite and the integration suite for both packages on every pull request and every push to `main`, alongside `scripts/check-versions.sh` — which fails the run if the eight places this repository states its version stop agreeing. A pull request also builds both images without pushing, so a broken `Dockerfile` fails the PR rather than surfacing at release time.

Releases are cut by pushing a `v*` tag. That runs the same suite, re-runs the version check with the tag as the expected value, publishes both images, and creates the GitHub release from the matching `## [x.y.z]` section of [`CHANGELOG.md`](CHANGELOG.md) — so a tag whose version the tree does not carry, or that has no changelog section, fails before anything is built. Run `scripts/check-versions.sh v0.5.0` yourself before tagging to find that out sooner.

---

## Roadmap

✅ marks a released version.

- **v0.1** ✅ — Single account configured through `.env`; IMAP, SMTP and CalDAV tools over MCP
- **v0.2** ✅ — Multi-account per deployment. No browser setup flow: accounts are configured by editing `accounts.json` — see [Connecting from Claude.ai](#connecting-from-claudeai).
- **v0.3** ✅ — Docker image on GHCR, test foundation (25 unit, 14 integration), CI and release pipeline
- **v0.4** ✅ — OAuth 2.1 layer in `oauth/` for claude.ai web and Cowork: discovery, dynamic client registration, PKCE, refresh rotation, and an authenticated proxy in front of `/mcp`
- **v0.5** ✅ — Node 24 and a dependency refresh across both packages; separate pipelines for branches and releases, with a version-consistency gate and build-provenance attestations
- **v0.6** — Browser settings UI: manage mailboxes, verify IMAP/SMTP/CalDAV credentials before saving, review and revoke connected Claude clients
- **v0.7** — Threading-aware `list_threads` tool, attachment download as base64, calendar invitation (iMIP) sending
- **v0.8** — CardDAV (contacts), JMAP support as an alternative to IMAP for Fastmail/Topicbox
- **v1.0** — Audit log, Prometheus metrics, rate limiting, hardened deployment guide

---

## License

MIT — see [LICENSE](LICENSE).

## Acknowledgements

- [imapflow](https://imapflow.com/) — modern Promise-based IMAP client
- [nodemailer](https://nodemailer.com/) — the only Node SMTP client worth using
- [tsdav](https://github.com/natelindev/tsdav) — clean TypeScript WebDAV/CalDAV/CardDAV
- [ical.js](https://github.com/kewisch/ical.js) — battle-tested iCalendar parser
- [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk) — Anthropic's official MCP SDK

---

Originally built by [Markus Stöger](https://markusstoeger.com) — WooCommerce, headless commerce and AI integration. Maintained as a fork at [YannicHock/claude-mail-mcp](https://github.com/YannicHock/claude-mail-mcp).
