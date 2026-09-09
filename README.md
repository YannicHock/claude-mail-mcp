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
- One Bearer token gates every MCP call, and the instance generates it itself
- Set up from the browser, then add the URL to Claude.ai once, done

---

## Quick start

Four steps, about ten minutes. You will not build anything, write any JSON, or generate any secret: the stack creates its own tokens and keys on first boot, and a browser wizard sets the operator password and the first mailbox.

### Before you start

Three things this project assumes and cannot arrange for you:

- **A server with a public domain name.** The hostname needs an **A record** — Claude connectors are IPv4-only, and a name that publishes AAAA records only cannot be reached at all.
- **A reverse proxy terminating TLS in front of it,** forwarding to `127.0.0.1:8080` — nginx, Caddy, Traefik, Nginx Proxy Manager, whichever you already run. **claude.ai will not connect over plain HTTP**, and this is the single most likely reason a first attempt fails. [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) has a working nginx recipe, and the variant for a proxy that runs in a container itself and so cannot reach the host's loopback.
- **Docker Engine with the Compose plugin.** No Node toolchain on the server — the two images are pulled from GHCR.

Port `8080` is the OAuth layer, and it is the one the proxy fronts. The connector on `3220` stays unreachable from outside; both are published to loopback only.

### 1. Configure

```bash
git clone https://github.com/YannicHock/claude-mail-mcp.git
cd claude-mail-mcp

cp .env.docker.example .env
cp oauth/.env.example .env.oauth
```

Set `PUBLIC_URL` in **both** files to the address your proxy serves — scheme and host, no path, no trailing slash. The two values must match exactly: it is the issuer the connector checks on every request the OAuth layer signs, and a mismatch fails that check silently.

Then create the two secrets directories and the group that owns them. This is the one thing to do before the first `docker compose up`: Docker creates a missing bind-mount source itself, as `root` and without the setgid bit, and the containers — which run unprivileged, as two different users — then cannot write in it.

```bash
mkdir -p secrets/shared secrets/oauth
sudo groupadd --system mailsecrets
sudo chgrp mailsecrets secrets/shared secrets/oauth
sudo chmod 2770 secrets/shared secrets/oauth
echo "SECRETS_GID=$(getent group mailsecrets | cut -d: -f3)" >> .env
```

That group is the one thing the two services share, so each can read a secret the other wrote; `docker compose up` refuses to start without `SECRETS_GID`. Why it has to be a group you created rather than one that came with the distribution is in [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) and [`docs/HARDENING.md`](docs/HARDENING.md).

The two directories the services *write* — mailbox credentials, and the OAuth layer's own bookkeeping — need nothing from you at all. `docker-compose.yml` keeps them in Docker named volumes, which Docker creates on the first start with the ownership each image already gives its own `/data`. Look inside one with `docker compose exec mail-mcp ls -ln /data`; [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) has the backup and restore recipes, and the migration if you are upgrading an install that has `./data` and `./oauth-data` directories today.

`PUBLIC_URL` and `SECRETS_GID` are the only values you supply. The Bearer token for `/mcp`, the OAuth signing key and the settings signing key are **generated on the first boot that finds them missing** and written under `secrets/`. A file that is already there always wins, so upgrading an existing install rotates nothing.

### 2. Start it

```bash
docker compose up -d
```

Two services come up: `mail-mcp`, the connector, and `mail-oauth`, the layer claude.ai signs in against.

### 3. Open the setup URL

An instance nobody has configured yet prints a complete, clickable setup link to its logs on every boot, and answers nothing else — `/mcp` returns 503 and every other path returns 404 — until setup finishes:

```bash
docker compose logs mail-oauth
```

```
────────────────────────────────────────────────────────────────
  Setup required. Open this once to configure the instance:

    https://mcp-mail.example.com/setup/<token>

  Anyone with this link can claim this instance. It stops
  working as soon as setup completes.
────────────────────────────────────────────────────────────────
```

The link in that banner is a bearer credential — anyone holding it can claim the instance — so open it yourself rather than pasting it anywhere. It survives a restart and is reprinted on every boot until you finish, so an interrupted setup is not a lost one.

### 4. Work through the wizard

Three screens:

1. **Operator account** — a username and a password of at least 12 characters. This is what you sign in to the settings UI with, and what Claude signs in against.
2. **First mailbox** — type the address and its password; the settings for that domain are looked up and shown for you to confirm rather than silently applied. If nothing is found you get a provider list, and behind that the full IMAP/SMTP/CalDAV form. IMAP and SMTP are tested against the real server before anything is stored. *Skip for now* is on every one of these screens — mailboxes can be added later from the settings UI.
3. **The MCP URL** — confirm it is the address the outside world reaches this instance at, and press **Finish**.

Finish deletes the claim token and closes `/setup` permanently. Add the MCP URL as a custom connector in claude.ai — Settings → Connectors → Add custom connector — and it answers immediately; the MCP endpoint needs no restart.

The settings UI does need one. It is mounted when the process starts, and this process started before there was an operator account to mount it against:

```bash
docker compose restart mail-oauth
```

Then sign in at `https://<your domain>/settings` to add mailboxes, test credentials, and review or revoke connected Claude clients. The wizard's last screen says all of this too, so you do not need this page open while you work.

That is the whole of it. [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) covers the reverse proxy in full, what lives on the two data volumes, backups and updating; [`docs/HARDENING.md`](docs/HARDENING.md) covers the threat model and the operator checklist.

---

## The images

Two multi-arch (amd64/arm64) images are published to GHCR: `ghcr.io/yannichock/claude-mail-mcp` and `ghcr.io/yannichock/claude-mail-mcp-oauth`. They are released together, from one commit, and `scripts/check-versions.sh` fails the build if the tree stops agreeing with itself about which version that is — so the two tags always name the same source.

A push to `main` publishes them tagged `sha-<short>` and nothing else; a `v*` tag publishes `X.Y.Z` and moves `latest`. So **`:latest` always names a release**, and `sha-<short>` is how you run an unreleased commit — it names one commit and can never move. Both images carry a build-provenance attestation:

```bash
gh attestation verify --owner YannicHock oci://ghcr.io/yannichock/claude-mail-mcp:latest
```

`docker-compose.test.yml` has nothing to do with running any of this — it gives the integration suite a disposable [GreenMail](https://greenmail-mail-test.github.io/greenmail/) server to talk to. See [Development](#development).

---

## Other ways to run it

**Just the connector, without the OAuth layer.** Claude Desktop, and any MCP client that lets you set a custom header, can call `/mcp` directly with `Authorization: Bearer <token>` and needs none of `mail-oauth`. Comment that service out of `docker-compose.yml`, read the token back with `cat secrets/shared/auth_token.txt`, and point your proxy at `127.0.0.1:3220` instead. There is no wizard on this path and no settings UI, so you write `accounts.json` onto the connector's data volume yourself — [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) has the format, the one command that puts it there, and the Claude Desktop config snippet.

**From source.** `npm install && npm run build && npm start` runs the connector on its own for local development. It is not the way to deploy this — see [CONTRIBUTING.md](CONTRIBUTING.md) and [Development](#development) below.

---

## Connecting from Claude.ai

The connector speaks the **Streamable HTTP MCP transport**, gated by a single static Bearer token — generated on first boot into `secrets/shared/auth_token.txt`. Since 0.4.0 the repository also ships an OAuth 2.1 layer in `oauth/`, published as a second image, for the clients that cannot send a Bearer token themselves.

- **Claude Desktop**, or any MCP client that lets you set a custom header, can call `/mcp` directly with `Authorization: Bearer <token>` — see [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) for the config snippet. No extra layer needed.
- **Claude.ai (web)** only connects to remote MCP servers that advertise OAuth 2.1 discovery (Dynamic Client Registration + PKCE), which the connector itself doesn't implement. The `oauth/` layer does: discovery, dynamic client registration, PKCE, refresh rotation, and an authenticated proxy in front of `/mcp`. `docker-compose.yml` runs it as `mail-oauth`; your reverse proxy fronts it instead of the connector, which stays unreachable from outside. That is the path the [Quick start](#quick-start) sets up. See [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) for the wiring and [`docs/HARDENING.md`](docs/HARDENING.md) for what it has to satisfy.

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

If your provider doesn't speak CalDAV, leave the CalDAV fields blank in the setup wizard or the settings UI — the calendar tools are always registered, but they return a clear error for any account with no `caldav` configured. Mail still works regardless.

---

## Architecture

```
Claude Desktop / any Bearer-capable MCP client
    │  HTTPS + Authorization: Bearer <AUTH_TOKEN>
    ▼
your reverse proxy (TLS termination, security headers, rate-limit on /mcp)
    │
    ├──▶ /mcp    ─▶ this server (Port 3220, Bearer-auth gated)
    └──▶ /health ─▶ this server (Port 3220)

this server
    ├── ImapClient   ──▶  imapflow  ──▶  IMAP server (993/143)
    ├── SmtpClient   ──▶  nodemailer ─▶  SMTP server (465/587)
    └── CalDavClient ──▶  tsdav     ──▶  CalDAV server
```

Everything is one Node process. IMAP holds a single long-lived connection with per-call mailbox locks. SMTP and CalDAV are stateless per call.

Claude.ai (web) isn't in this diagram: it reaches the connector through the OAuth 2.1 layer in `oauth/`, a second Node process that the proxy fronts in the connector's place. That is the arrangement the [Quick start](#quick-start) builds — see [Connecting from Claude.ai](#connecting-from-claudeai) above.

---

## Security model

**[SECURITY.md](SECURITY.md)** is the threat model; **[docs/HARDENING.md](docs/HARDENING.md)** is the operator checklist, and it is where the detail lives. The shape of it, so you know what you are agreeing to:

- **You hold the credentials.** Mailbox passwords live in an `accounts.json` on your own disk and nowhere else. `list_accounts` returns id, label and From — never a credential — and logs carry neither passwords nor tokens.
- **TLS, security headers and rate limits are the reverse proxy's job,** and you supply the proxy. [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) carries an nginx recipe that does all three, including a login-grade limit scoped to the two endpoints that check the operator password.
- **Both services bind loopback only.** The proxy is the only thing that can reach either of them from outside.
- **`/mcp` is gated by one static Bearer token,** generated on first boot, which the OAuth layer substitutes into every request it proxies and never hands to a client.
- **An unclaimed instance is claimable only from its own logs.** Until setup completes, `/mcp` answers 503 and everything but `/health` and the setup URL answers 404, so the window between `docker compose up` and the first sign-in is not an open form on the public internet. It reduces takeover to an attacker who can already read your container logs.
- **The two services run unprivileged, as two different users,** sharing exactly one group: the one that owns `secrets/`, so each can read a secret the other wrote. The OAuth signing key and the operator's password hash are in the half of `secrets/` that is never mounted into the process parsing inbound MIME.
- **Destructive tools** (`delete_message`) document their irreversibility, so Claude surfaces a confirmation step. Prefer `move_message` to a Trash folder.

The Docker deployment is the one this project supports, and it takes its isolation from the container runtime: two unprivileged users, one shared group, and no path from the connector to the OAuth layer's secrets. [docs/HARDENING.md](docs/HARDENING.md) has the full threat model, the OAuth layer's own, and the operator checklist. Reporting issues: [SECURITY.md](SECURITY.md).

---

## Development

Working on the code, not deploying it — the [Quick start](#quick-start) is that, and [CONTRIBUTING.md](CONTRIBUTING.md) has the rest of this.

```bash
npm install
npm run build       # tsc
npm test            # alias for test:unit
```

`npm run test:unit` runs offline — no network, no Docker required.

`npm run test:integration` adds the cases a mocked client cannot reach: the IMAP/SMTP tools end-to-end against a disposable [GreenMail](https://greenmail-mail-test.github.io/greenmail/) container started from `docker-compose.test.yml`, the connection probe against a real server, and the MCP protocol surface (auth rejection, `initialize`, `tools/list`, `/health`). The suite manages the GreenMail container itself — no manual `docker compose up` needed — and skips cleanly instead of failing when the Docker daemon isn't reachable. It binds fixed host ports, so only one checkout at a time can run it.

```bash
npm run test:integration
```

CI runs typecheck (`tsc --noEmit`), the unit suite and the integration suite for both packages on every pull request and every push to `main`, alongside `scripts/check-versions.sh` — which fails the run if the eight places this repository states its version stop agreeing. A pull request also builds both images without pushing, so a broken `Dockerfile` fails the PR rather than surfacing at release time.

Releases are cut by pushing a `v*` tag. That runs the same suite, re-runs the version check with the tag as the expected value, publishes both images, and creates the GitHub release from the matching `## [x.y.z]` section of [`CHANGELOG.md`](CHANGELOG.md) — so a tag whose version the tree does not carry, or that has no changelog section, fails before anything is built. Run `scripts/check-versions.sh v0.5.0` yourself before tagging to find that out sooner.

---

## Roadmap

✅ marks a released version. What shipped, in order:

- **v0.1** ✅ — Single account configured through `.env`; IMAP, SMTP and CalDAV tools over MCP
- **v0.2** ✅ — Multi-account per deployment, configured by hand-editing `accounts.json`
- **v0.3** ✅ — Docker image on GHCR, test foundation (25 unit, 14 integration), CI and release pipeline
- **v0.4** ✅ — OAuth 2.1 layer in `oauth/` for claude.ai web and Cowork: discovery, dynamic client registration, PKCE, refresh rotation, and an authenticated proxy in front of `/mcp`
- **v0.5** ✅ — Node 24 and a dependency refresh across both packages; separate pipelines for branches and releases, with a version-consistency gate and build-provenance attestations
- **v0.6** ✅ — Browser settings UI: manage mailboxes, verify IMAP/SMTP/CalDAV credentials before saving, review and revoke connected Claude clients

What is planned lives in the [milestones](https://github.com/YannicHock/claude-mail-mcp/milestones), each with the issues it is made of. It is not repeated here — the copy that used to be went stale and started contradicting them.

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
