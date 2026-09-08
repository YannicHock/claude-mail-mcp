# Hardening guide

This document covers the security posture of a default `claude-mail-mcp` deployment and the choices an operator should make.

It is opinionated and assumes the deployment layout from [DEPLOYMENT.md](DEPLOYMENT.md) (Linux + nginx + systemd + Let's Encrypt). If you're running something else, treat this as a checklist of properties to recreate.

## What the default deployment gives you

When you follow [DEPLOYMENT.md](DEPLOYMENT.md), you end up with:

```
┌────────────────────────────────────────────────────────────┐
│ Internet → nginx (TLS, HSTS, security headers, rate-limit) │
└──────┬─────────────────────────────────────────────────────┘
       │
       │  proxy_pass http://127.0.0.1:3220  (/mcp, Bearer-auth gated)
       │  proxy_pass http://127.0.0.1:3220  (/health)
       ▼
┌────────────────────────────────┐
│ claude-mail-mcp.service        │
│ user=mailmcp                   │
│ bound 127.0.0.1:3220           │
│ NoNewPrivileges, ProtectSystem │
│ ReadWritePaths=/var/lib/mail-… │
│ MemoryMax=512M                 │
│ SystemCallFilter=@system-…     │
└──────┬─────────────────────────┘
       │
       ▼ reads /var/lib/mail-mcp/accounts.json (chmod 600, owner mailmcp)
```

That path is where `ACCOUNTS_FILE` in `.env.example` points and where
[DEPLOYMENT.md](DEPLOYMENT.md) step 4 creates the file. The container
deployment in that same document is the one variation: there the file is
`./data/accounts.json` on the host, bind-mounted read-only to
`/data/accounts.json` and owned by the container's uid 100 / gid 101. Every
other property below applies to the systemd deployment described here.

This is the whole deployment as it ships: one process, bound to loopback, gated by a single static Bearer token that it checks on every `/mcp` request. There is no separate OAuth/login process in front of it by default. If you need to expose this server to a remote client that requires OAuth 2.1 discovery (see "Optional: adding an OAuth layer" below), that layer is something you add yourself — it is not part of this repository, and there is currently no reference implementation to point you at. An earlier version of this document linked to one (`markusstoeger/mcp-oauth-shim`); that repository no longer exists.

### Properties this gives you

| Layer | Property | Mechanism |
|-------|----------|-----------|
| Transport | TLS 1.3, auto-renewed | certbot + Let's Encrypt |
| Transport | HSTS 2 years, frame-deny, nosniff, no-referrer, noindex | nginx `add_header … always`, server-level (see [DEPLOYMENT.md](DEPLOYMENT.md)) |
| Transport | Brute-force throttling on `/mcp` | nginx `limit_req zone=mailmcp_auth rate=120r/m burst=60 nodelay`, scoped to the `/mcp` location only — `/health` is not throttled |
| Network | Backend never reachable from the public internet | bind 127.0.0.1 + UFW default-deny |
| Process | No privilege escalation | `NoNewPrivileges` |
| Process | Read-only filesystem except `/var/lib/mail-mcp` | `ProtectSystem=strict` + `ReadWritePaths=` |
| Process | No access to other users' home dirs | `ProtectHome=true` |
| Process | Cannot tamper with kernel state | `ProtectKernel*`, `ProtectControlGroups`, `ProtectClock` |
| Process | Cannot inspect other processes | `ProtectProc=invisible` |
| Process | Cannot make pages executable | `LockPersonality` |
| Process | Limited syscall surface | `SystemCallFilter=@system-service ~@privileged @resources` |
| Process | Resource caps | `MemoryMax=512M`, `TasksMax=128`, `LimitNOFILE=4096` |
| Auth | Static Bearer token gates `/mcp` | `AUTH_TOKEN` env var, checked on every request |
| Storage | `/var/lib/mail-mcp/accounts.json` chmod 600, owned by `mailmcp` | `install -o mailmcp -g mailmcp -m 600`, [DEPLOYMENT.md](DEPLOYMENT.md) step 4 |

OAuth 2.1, JWT-based sessions, CSRF guards and subprocess-hardened login checks would all belong to an OAuth layer placed in front of this server — none of that exists in this repository today. See "Optional: adding an OAuth layer" below for what such a layer would need to provide.

## What it does *not* give you

These are deliberate scope decisions. If your threat model demands more, address them yourself.

### At-rest encryption of `accounts.json`

The credentials file is plain JSON, chmod 600. An attacker with root on the host can read it. This is the same security boundary as `/etc/shadow` or `~/.ssh/id_rsa`.

Adding app-level encryption would require either:
1. A key stored on the same host (which doesn't protect against a root compromise), or
2. A key provided at process start (which would have to be entered manually after every restart — operationally painful).

If you need (2), the cleanest approach is to put `/var/lib/mail-mcp` on a LUKS-encrypted volume that requires manual unlock, then accept the trade-off that an unattended restart leaves the service down until you unlock.

### Backup strategy

The service is stateful (state in `/var/lib/mail-mcp/`). Losing it means re-entering every account's credentials by hand-editing `accounts.json` (or through whatever account-management UI you've built or added — none ships with this repository). If you run an OAuth layer that stores its own signing key under this directory, losing it would also invalidate tokens *that layer* issued; that doesn't apply if you're only using the static `AUTH_TOKEN`.

Recommendation: include `/var/lib/mail-mcp/` in your normal backup rotation **with encryption-at-rest** (e.g. `restic`, `borgbackup`, or a `tar | gpg` pipeline). Do not back up to a cloud bucket without encryption.

### Audit log for write operations

The server logs MCP requests as structured JSON to journald (`journalctl -u claude-mail-mcp`), including authentication failures and tool invocations. It does not write a dedicated "write op X happened" log line.

For compliance-relevant deployments, consider adding a `mcp-audit.log` either via a custom log destination or by parsing the journal stream.

### Outbound network controls

The backend speaks to your mailbox provider's IMAP, SMTP and CalDAV. We don't restrict the set of hosts it can reach (`accounts.json` decides). If you want to enforce an allowlist, use a host-level egress firewall or run the service with `IPAddressAllow=` set to the IPs of your provider.

### Multi-operator scenarios

v0.2 is single-tenant: one shared `AUTH_TOKEN` grants access to every configured account, and this server has no per-user login of its own. If you add an OAuth layer in front for multi-user access, its login step becomes the real access-control boundary between humans — this server can't tell them apart. If your use case needs distinguishable humans, deploy multiple instances, each with its own `AUTH_TOKEN` and, if applicable, its own OAuth-layer login. Multi-tenancy is not on the roadmap.

## Recommended additions

These improve the default but require operator action:

### 1. AUTH_TOKEN rotation

Rotate every 90 days (or after staff turnover):

```bash
NEW=$(openssl rand -hex 32)
sed -i "s/^AUTH_TOKEN=.*/AUTH_TOKEN=$NEW/" /var/www/mail-mcp/.env

systemctl restart claude-mail-mcp
```

If you run a separate OAuth layer in front that also holds a copy of this token (e.g. to inject it into the requests it forwards), update and restart that too. How you do so depends entirely on what you built or deployed, since it isn't part of this repository.

### 2. Outbound allowlist (optional, hardening++)

If you only ever talk to one mail provider, restrict egress:

```ini
# In claude-mail-mcp.service
IPAddressDeny=any
IPAddressAllow=127.0.0.1/32
IPAddressAllow=80.241.60.0/24   # mailbox.org range — replace with yours
```

This catches the case where a (hypothetical) RCE in a dependency tries to exfiltrate to a foreign host.

### 3. Application-layer logging to file

If you don't want to rely on journald (e.g. for SIEM ingestion), wire a syslog forwarder or pipe `journalctl -u claude-mail-mcp -f` to your log shipper.

## Optional: adding an OAuth layer for remote/multi-client access

Everything above describes the whole deployment as it ships: one process, bound to loopback, gated by a single static `AUTH_TOKEN`. That's sufficient for Claude Desktop and any MCP client that lets you set a custom `Authorization` header.

claude.ai's web connector, however, only connects to remote MCP servers that advertise OAuth 2.1 discovery (`/.well-known/oauth-authorization-server`, Dynamic Client Registration, PKCE). To support that client you need a small proxy in front of this server that speaks OAuth on the outside and forwards Bearer-authenticated requests to `/mcp` on the inside.

**This repository does not include that layer, and there is currently no reference implementation to point you at.** An earlier version of this document referenced `markusstoeger/mcp-oauth-shim`; that repository does not exist. If you build or adopt one, treat the following as a specification of what it should satisfy — not as a description of anything currently deployed:

- Bind to loopback only, same as the backend, and sit behind the same nginx/TLS front door.
- Implement OAuth 2.1 + Dynamic Client Registration (RFC 7591) + PKCE (S256).
- Issue short-lived, signed access tokens (e.g. JWT, ~1h TTL) plus longer-lived refresh tokens, stored as hashes rather than plaintext.
- Gate any human login (e.g. an account-settings UI) behind its own credential check, brute-force throttled at the edge (nginx `limit_req`) and by a fail2ban jail on its auth-fail log lines.
- Protect any state-changing endpoint it exposes (e.g. a settings-save form) with a CSRF guard (Origin/Referer check).
- Run as its own dedicated non-root user with the same systemd hardening (`NoNewPrivileges`, `ProtectSystem=strict`, syscall filtering, resource caps) applied to `claude-mail-mcp.service` above.
- Never log or persist mailbox credentials itself — it should only ever handle the single `AUTH_TOKEN` it forwards.

If you do stand up such a layer, its fail2ban filter, jail, and log format are yours to define to match what you built. For illustration only (not something this repo ships or assumes):

```ini
[Definition]
failregex = ^\[your-oauth-layer\] login fail .+ ip=<HOST>$
journalmatch = _SYSTEMD_UNIT=your-oauth-layer.service
```

```ini
[your-oauth-layer]
enabled = true
filter = your-oauth-layer
backend = systemd
maxretry = 5
findtime = 600
bantime = 3600
```

## Threat scenarios walked through

### Scenario: brute force against the Bearer token

Path: attacker hits `POST /mcp` with guessed tokens.
Mitigations: `AUTH_TOKEN` is a 32-byte random hex string (128 bits of entropy) — not practically brute-forceable. The nginx recipe in [DEPLOYMENT.md](DEPLOYMENT.md) also throttles `/mcp` to 120 req/min per IP (`limit_req zone=mailmcp_auth burst=60 nodelay`). That ceiling is deliberately well above a login form's: every MCP message is its own `POST /mcp`, so a login-form rate would cut live conversations off with a 503. It contributes almost nothing against guessing — the entropy does that work — and exists to bound the damage of a client stuck in a retry loop.
Residual risk: negligible, assuming the token was generated as documented (`openssl rand -hex 32`) and never leaked (logs, git history, screenshots).

### Scenario: brute force against an OAuth layer's login (if you add one)

Path: attacker hits that layer's login endpoint with guessed username/password.
Mitigations: entirely dependent on what you build — see "Optional: adding an OAuth layer" above for what such a layer should provide (rate limiting, fail2ban, bcrypt-hashed passwords).
Residual risk: not assessable here, since the layer isn't part of this repository.

### Scenario: attacker tricks an operator into visiting evil.example.com (CSRF)

This server has no browser-facing, cookie- or session-authenticated endpoints — `/mcp` requires an explicit `Authorization: Bearer` header that a cross-site form submission cannot supply, so classic CSRF doesn't apply to it today.

If you add an OAuth layer with its own account-settings UI, that UI becomes a new CSRF surface and needs its own Origin/Referer guard on state-changing requests — see "Optional: adding an OAuth layer" above.

### Scenario: dependency compromise (`imapflow`, `nodemailer`)

Path: malicious npm package update tries to read `accounts.json` or exfiltrate.
Mitigations: `ProtectSystem=strict` blocks writes outside `/var/lib/mail-mcp`. `IPAddressAllow` (if configured) blocks egress to unknown hosts. Reading credentials is still possible — at-rest encryption is the only true defence here, with the trade-offs noted above.
Residual risk: medium. Pin dependency versions in `package-lock.json` (already done), subscribe to GHSA notifications, run `npm audit` regularly.

### Scenario: MITM between Claude.ai and the connector

Path: attacker on the network path forges responses or steals the Bearer token (or any tokens issued by an OAuth layer, if you've added one).
Mitigations: TLS with valid Let's Encrypt cert, HSTS, no fallback to HTTP.
Residual risk: very low (would require breaking TLS or compromising the CA).

### Scenario: root on the host

Path: attacker gains root via unrelated channel.
Mitigations: none at the application layer — all credentials are recoverable.
Residual risk: total compromise of all configured mailboxes. This is why you keep the host patched, don't share root SSH keys, and use SSH key-based auth only.

## Reporting issues

See [SECURITY.md](../SECURITY.md).
