# Security Policy

## Supported versions

Until v1.0, only the latest minor release is supported with security fixes.

| Version | Supported |
|---------|-----------|
| 0.2.x   | yes       |
| 0.1.x   | no — upgrade to 0.2.1 (see [CHANGELOG.md](CHANGELOG.md)) |

## Reporting a vulnerability

**Please do not open a public GitHub issue for security problems.**

Preferred channel:

1. **GitHub Private Vulnerability Reporting** — open a private advisory at
   <https://github.com/maxx3250/claude-mail-mcp/security/advisories/new>

Alternative channel:

2. Email **security@markusstoeger.com**. PGP is not required.

## What to include

- A description of the issue and its impact
- Steps to reproduce (or a proof of concept)
- The affected version / commit
- Whether the issue is already public anywhere

## Response timeline

- **Acknowledgement** within 48 hours
- **Initial assessment** within 7 days
- **Fix or status update** within 14 days

If the report is valid, a fix is published as a patch release and a GitHub Security Advisory with a CVE (where applicable) is opened. Reporters are credited unless they request otherwise.

## Threat model

**Assets we protect:**
- Mailbox credentials (IMAP/SMTP/CalDAV passwords in `accounts.json`)
- Email content (read access, write access, deletion)
- Calendar data
- The Bearer token gating `/mcp`

If you add an OAuth layer in front of this server (see [docs/HARDENING.md](docs/HARDENING.md)) to serve remote clients like claude.ai web, that layer's own signing keys and any credentials it manages become additional assets — this document doesn't cover them, since that layer isn't part of this repository.

**Adversaries we consider:**
- Random internet attacker (port scan, brute force against the Bearer token or the reverse proxy)
- Compromised network path between an MCP client and the connector (MITM)
- A compromised MCP client (malicious tool calls)
- Local-system attacker (other processes on the same host)

If you add an OAuth layer in front (not part of this repository — see [docs/HARDENING.md](docs/HARDENING.md)), it introduces its own adversary: a malicious page loaded in the operator's browser attempting CSRF against that layer's login or settings UI. This server has no browser-facing endpoints of its own, so that scenario doesn't apply today.

**Out of scope:**
- A root-level compromise of the host. With root, all credentials are recoverable from `/var/lib/mail-mcp/accounts.json` — same security boundary as `~/.ssh/id_rsa` or `/etc/shadow`. We do not attempt at-rest encryption that depends on a key also stored on the same host.
- Compromise of the upstream mailbox provider.
- Phishing of the operator's login credentials for any OAuth layer they've added in front (not part of this repository).

## What this project does

### Transport
- TLS terminated by nginx, certificate from Let's Encrypt (90-day rotation by `certbot.timer`).
- HSTS, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex` on every response, set at the nginx server level (see the reverse-proxy config in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)).
- Backend bound to `127.0.0.1` only; nginx is the only thing that can reach it from outside.

### Authentication
- `/mcp` is gated by a single static Bearer token (`AUTH_TOKEN`), checked on every request. There is no per-user auth, no token expiry, and no OAuth flow in this repository — the whole deployment shares one secret.
- `/mcp` is additionally rate-limited by nginx (`limit_req`, 10 req/min per IP with a burst of 5) — see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). `/health` is deliberately not rate-limited, since uptime checkers poll it and it carries no credentials.
- `/health` is unauthenticated by design (liveness probe + a non-sensitive account summary — no credentials).

**If you expose this server to a remote MCP client over the public internet** — for example claude.ai web, which requires OAuth 2.1 discovery — you need to put an OAuth 2.1 layer in front that authenticates the human and forwards the Bearer token to this server on their behalf. **That layer is not part of this repository.** An earlier version of this document described it as already deployed and linked to a "reference implementation" (`markusstoeger/mcp-oauth-shim`); that repository does not exist, and no substitute is provided here. See [docs/HARDENING.md](docs/HARDENING.md) for what such a layer should satisfy if you build or adopt one — OAuth 2.1 + DCR + PKCE, short-lived signed tokens, a brute-force-throttled login, and a CSRF guard on any state-changing endpoint it exposes. Those are properties the *layer* needs, not properties this project has today.

### Process isolation
- The backend runs as the dedicated non-root `mailmcp` system user (no shell, no home directory).
- systemd hardening: `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`, `PrivateDevices`, `ProtectKernel*`, `ProtectControlGroups`, `ProtectClock`, `ProtectHostname`, `ProtectProc=invisible`, `RestrictNamespaces`, `RestrictRealtime`, `RestrictSUIDSGID`, `LockPersonality`, `SystemCallFilter=@system-service ~@privileged @resources`.
- Writable filesystem limited to `/var/lib/mail-mcp` (state dir).
- Memory and task caps via `MemoryMax`, `TasksMax`, `LimitNOFILE`.
- If you add an OAuth layer in front, apply the same systemd hardening and dedicated non-root user to it — it isn't covered by this project's install steps.

### Credentials at rest
- `accounts.json` is owned by `mailmcp:mailmcp` and chmod 600, at `/var/lib/mail-mcp/accounts.json` — the `ACCOUNTS_FILE` default in `.env.example` and the path [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) step 4 creates. Under the container deployment in that same document it is `./data/accounts.json` on the host, mounted read-only at `/data/accounts.json` and owned by the container's uid 100 / gid 101.
- `.env` (holds `AUTH_TOKEN` and, for single-account setups, mailbox credentials) is `root:mailmcp` 640 (root can edit, the service can read).
- If you add an OAuth layer that keeps its own state (signing keys, refresh-token hashes, an htpasswd file), apply the same ownership/permission discipline to it — it isn't part of this project's code or install steps.

### Input validation
- Every MCP tool input validated with [Zod](https://zod.dev) schemas.
- `accounts.json` schema-validated on every load (id pattern, port ranges, required fields).

### Output filtering
- `list_accounts` returns id/label/default/From/imap_host/caldav_enabled — never credentials.
- `/health` shows the same public summary.
- Server logs never include passwords or Bearer tokens.

## Hardening checklist for operators

These are not vulnerabilities in this project, but operators should:

- [x] Run behind HTTPS with a valid certificate (the included nginx vhost + certbot does this).
- [x] Bind the Node process to `127.0.0.1` and let nginx handle public traffic.
- [x] Run the systemd unit as a dedicated non-root user.
- [x] Use a host firewall (UFW or equivalent) with default-deny incoming.
- [ ] Rotate `AUTH_TOKEN` periodically. Restart the service after rotation (and any OAuth layer you've added that caches a copy of the token).
- [ ] Use app-specific passwords on providers that support them — never your main account password.
- [ ] Restrict who can reach the connector at the network level (VPN, IP allowlist, or an OAuth/access-control layer you add in front — see [docs/HARDENING.md](docs/HARDENING.md); this is not included in the repository).
- [ ] If you add an OAuth/login layer in front, run a fail2ban jail against its auth-fail log lines for additional brute-force protection — see [docs/HARDENING.md](docs/HARDENING.md).
- [ ] Keep `accounts.json` out of any backups that leave the host unencrypted.
- [ ] Subscribe to GitHub Security Advisories for this repo and the dependencies (`imapflow`, `nodemailer`, `tsdav`, `@modelcontextprotocol/sdk`).

See [docs/HARDENING.md](docs/HARDENING.md) for the full operator checklist and threat-model walkthrough.
