# Deployment

A typical production deployment behind nginx, running under a hardened systemd unit. Adapt to your stack as needed. There is also a [container deployment](#container-deployment-docker) further down, and a pm2 config in the repository for local development only — pm2 is not recommended for production and gets none of the systemd isolation below.

## Requirements

- Node.js 20.19+ or 22.7+ — older releases cannot load the `tsdav`
  dependency, which ships an ESM file inside a CommonJS package. The Docker
  image ships Node 22.
- A public DNS name pointing at your server (HTTPS is required by Claude.ai)
- An IMAP + SMTP capable mailbox
- Optionally a CalDAV endpoint

## 1. Clone and build

```bash
cd /var/www
git clone https://github.com/YannicHock/claude-mail-mcp.git mail-mcp
cd mail-mcp
npm ci
npm run build
```

## 2. Configure

```bash
cp .env.example .env
# generate the Bearer token clients will send to /mcp
echo "AUTH_TOKEN=$(openssl rand -hex 32)" >> .env
# edit .env and set PUBLIC_URL to the public HTTPS name you configure in step 6
```

That is the whole of it. This server reads exactly six environment variables —
`PORT`, `HOST`, `LOG_LEVEL`, `ACCOUNTS_FILE`, `AUTH_TOKEN` and `PUBLIC_URL`
(`src/config.ts`) — and `.env.example` ships all of them with defaults that suit
this deployment, including `ACCOUNTS_FILE=/var/lib/mail-mcp/accounts.json`.

**Mailbox credentials are not environment variables.** `IMAP_*`, `SMTP_*`,
`CALDAV_*`, `DEFAULT_FROM`, `DRAFTS_FOLDER` and `SENT_FOLDER` were removed in
0.2.0 (a documented BREAKING change — see [CHANGELOG.md](../CHANGELOG.md)); they
live in `accounts.json`, which you create in step 4 below.

For two-factor mailboxes (Gmail, iCloud, Fastmail) use an **app-specific password**, never your main account password. See the table in the [README](../README.md#app-passwords-mandatory-on-2fa-accounts) for direct links.

## 3. Create the dedicated service user

```bash
useradd --system --no-create-home --shell /usr/sbin/nologin --comment "claude-mail-mcp" mailmcp
# State directory. This is where accounts.json lives (step 4) and the only
# path the systemd unit in step 5 can write to (ReadWritePaths=).
mkdir -p /var/lib/mail-mcp
chown mailmcp:mailmcp /var/lib/mail-mcp
chmod 700 /var/lib/mail-mcp
chgrp mailmcp /var/www/mail-mcp/.env
chmod 640 /var/www/mail-mcp/.env
```

If you build or deploy an OAuth shim (see step 7, Option B below — none ships in this repository) and it authenticates against an htpasswd file, give its service user group-read access:

```bash
chgrp mailmcp /etc/nginx/.htpasswd_mail
chmod 640 /etc/nginx/.htpasswd_mail
```

## 4. Create `accounts.json`

Mailbox credentials live in a JSON file, not in `.env`. `ACCOUNTS_FILE` in
`.env.example` points at `/var/lib/mail-mcp/accounts.json` — the state directory
you created in step 3, and the one path the systemd unit's
`ProtectSystem=strict` leaves writable. `docs/HARDENING.md` and `SECURITY.md`
describe the same location.

```bash
install -o mailmcp -g mailmcp -m 600 /dev/null /var/lib/mail-mcp/accounts.json
cat > /var/lib/mail-mcp/accounts.json <<'JSON'
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
JSON
```

`install` creates the file already owned by `mailmcp` and already at mode 600, so
the credentials are never briefly world-readable between `cat` and a later
`chmod`. Verify:

```bash
ls -l /var/lib/mail-mcp/accounts.json
# -rw------- 1 mailmcp mailmcp ... /var/lib/mail-mcp/accounts.json
```

Add a `"caldav": { "url": ..., "user": ..., "pass": ... }` block per account if
your provider speaks CalDAV; omit it and the calendar tools return a clear error
for that account while mail keeps working. Multiple accounts go in the same
array — see the [README](../README.md#what-it-does) for the multi-account model.

Starting with **no** accounts is also valid: write
`{"version": 1, "accounts": []}` and the server boots with an empty account list
(`/health` reports `"accounts": []`). The file is re-read via `fs.watch`, so
adding an account later needs no restart. A *missing* file is likewise treated as
"no accounts yet" — but an unreadable one is fatal, which is why the ownership
above matters.

## 5. Run via hardened systemd unit

`/etc/systemd/system/claude-mail-mcp.service`:

```ini
[Unit]
Description=claude-mail-mcp — IMAP/SMTP/CalDAV MCP backend
After=network.target
Wants=network.target

[Service]
Type=simple
User=mailmcp
Group=mailmcp
WorkingDirectory=/var/www/mail-mcp
Environment=NODE_ENV=production
ExecStart=/usr/bin/node --env-file=/var/www/mail-mcp/.env --enable-source-maps /var/www/mail-mcp/dist/index.js
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

# Hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectKernelLogs=true
ProtectControlGroups=true
ProtectClock=true
ProtectHostname=true
ProtectProc=invisible
RestrictSUIDSGID=true
RestrictNamespaces=true
RestrictRealtime=true
LockPersonality=true
SystemCallArchitectures=native
SystemCallFilter=@system-service
SystemCallFilter=~@privileged @resources
ReadWritePaths=/var/lib/mail-mcp
MemoryMax=512M
TasksMax=128
LimitNOFILE=4096
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable --now claude-mail-mcp.service
systemctl status claude-mail-mcp.service
journalctl -u claude-mail-mcp.service -f
```

### Alternative: pm2 (local dev only)

The repo ships `ecosystem.config.cjs` for `pm2 start ecosystem.config.cjs`. Not recommended for production — pm2 runs as the invoking user (typically root) and provides none of the systemd isolation above.

## 6. Reverse proxy (nginx)

`limit_req_zone` has to live in the `http {}` context — it does nothing inside a `server` or `location` block. Add it once, outside any `server` block, e.g. in its own file that your `nginx.conf`'s `http {}` block already includes (`/etc/nginx/conf.d/*.conf` on most distros):

```nginx
# /etc/nginx/conf.d/mail-mcp-limits.conf
limit_req_zone $binary_remote_addr zone=mailmcp_auth:10m rate=120r/m;
```

**Do not lower this to a login-form rate.** `/mcp` is a JSON-RPC endpoint, not a
login form: `src/index.ts` runs the Streamable HTTP transport with
`sessionIdGenerator: undefined` and `enableJsonResponse: true`, so **every
JSON-RPC message is its own `POST /mcp`**. Simply connecting a client spends
`initialize` + `notifications/initialized` + `tools/list` before the user has
typed anything, and a request like "read my last four emails" spends several
more. At 10r/m the connector starts returning 503 in the middle of a
conversation, with nothing in the client to explain why.

120r/m with a burst of 60 leaves normal use untouched while still capping a
guessing loop at two attempts per second per IP. That cap is defence in depth
rather than the actual defence: `AUTH_TOKEN` is 128 bits of entropy, so
throttling changes a brute-force from infeasible to infeasible.

Then the site itself:

```nginx
server {
    listen 80;
    server_name mcp-mail.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    # `listen ... http2` has been deprecated since nginx 1.25.1; HTTP/2 is a
    # server-level directive now. On nginx < 1.25.1, use `listen 443 ssl http2;`
    # and drop this line.
    http2 on;
    server_name mcp-mail.example.com;

    ssl_certificate     /etc/letsencrypt/live/mcp-mail.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/mcp-mail.example.com/privkey.pem;

    server_tokens off;

    # Streamable HTTP can keep connections open longer than the nginx default
    proxy_read_timeout 600s;
    proxy_send_timeout 600s;
    proxy_buffering    off;

    # Email bodies and attachments can be large
    client_max_body_size 25M;

    # Security headers on every response. None of the location blocks below
    # define their own `add_header`, so these are inherited by all of them —
    # `add_header` only stops inheriting once a *more specific* block adds
    # its own directives. If you ever add a location with its own
    # `add_header`, repeat these lines there too, or they'll silently drop
    # for that location.
    add_header Strict-Transport-Security "max-age=63072000; includeSubDomains" always;
    add_header X-Content-Type-Options    "nosniff" always;
    add_header X-Frame-Options           "DENY" always;
    add_header Referrer-Policy           "no-referrer" always;
    add_header X-Robots-Tag              "noindex" always;

    location /mcp {
        # AUTH_TOKEN is the only thing gating this endpoint — throttle
        # guessing attempts against it. Sized for JSON-RPC, not for a login
        # form: every MCP message is a separate POST here (see the note above
        # the zone definition). Lowering this breaks live conversations.
        limit_req zone=mailmcp_auth burst=60 nodelay;

        proxy_pass http://127.0.0.1:3220;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Authorization     $http_authorization;
        proxy_set_header Transfer-Encoding "";
    }

    location /health {
        # No rate limit here on purpose — uptime checkers poll this often,
        # and it carries no credentials worth throttling access to.
        proxy_pass http://127.0.0.1:3220;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location / {
        return 404;
    }
}
```

```bash
certbot --nginx -d mcp-mail.example.com
```

## 7. Add to Claude

### Option A — Claude Desktop (Bearer auth, simplest)

1. Open **Claude Desktop → Settings → Developer → Edit Config**
2. Add an entry:
   ```json
   {
     "mcpServers": {
       "mail": {
         "url": "https://mcp-mail.example.com/mcp",
         "transport": "http",
         "headers": { "Authorization": "Bearer YOUR_AUTH_TOKEN" }
       }
     }
   }
   ```
3. Restart Claude Desktop. The mail and (optionally) calendar tools appear under "mail".

### Option B — claude.ai web (OAuth 2.1 + DCR)

claude.ai will only connect to remote MCP servers that advertise OAuth 2.1 discovery, and this server only speaks plain Bearer auth. **This is an open point, not a shipped component: no OAuth shim is bundled with or referenced by this repository.** To use claude.ai's web/mobile client (as opposed to Claude Desktop, Option A above) you have to build or source that OAuth 2.1 + DCR + PKCE layer yourself and run it in front of the connector.

At minimum, that layer needs to:
- Implement `/.well-known/oauth-authorization-server`, `/authorize`, `/token`, `/register`, `/jwks.json`
- Validate Claude's PKCE flow + Dynamic Client Registration
- Forward `/mcp` traffic to this connector with the upstream `AUTH_TOKEN` Bearer header injected
- Authenticate the human in `/authorize` (an htpasswd file is one option)

Until you have one running, use **Option A (Claude Desktop)** above — it talks to this server's Bearer auth directly and needs no OAuth layer at all.

Once you have an OAuth shim of your own in front:

1. claude.ai → **Settings → Connectors → Add custom connector**
2. URL: `https://mcp-mail.example.com/mcp` (the shim's public URL)
3. claude.ai discovers the OAuth endpoints automatically
4. Whatever login your shim implements runs
5. The tools appear in the connector

## 8. Verify

```bash
# health
curl https://mcp-mail.example.com/health
# → {"status":"ok","server":"claude-mail-mcp","version":"0.2.1",
#    "accounts":[{"id":"main","label":"Main","default":true,
#                 "smtp_from":"you@example.com","imap_host":"imap.mailbox.org",
#                 "caldav_enabled":false}],
#    "accounts_file":"/var/lib/mail-mcp/accounts.json"}
#
# Note `caldav_enabled` is per account, inside accounts[] — there is no
# top-level field of that name. `accounts` is [] when none are configured,
# and the endpoint still answers 200 in that state.

# unauthenticated request should be rejected
curl -i -X POST https://mcp-mail.example.com/mcp -H 'Content-Type: application/json' -d '{}'
# → HTTP/1.1 401 Unauthorized

# tools/list with auth
curl -X POST https://mcp-mail.example.com/mcp \
  -H "Authorization: Bearer $AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
# → JSON with 14 tools (1 account + 9 mail + 4 calendar), unconditionally —
#   calendar tools are always registered; they error per-call for any
#   account with no `caldav` block in accounts.json
```

## 9. Updating

```bash
cd /var/www/mail-mcp
git pull
npm ci
npm run build
systemctl restart claude-mail-mcp.service
```

## 10. Operational notes

**Credentials.** Rotate `AUTH_TOKEN` periodically. If you use an app-specific password (Gmail, iCloud, Fastmail), revoke it from the provider's UI when the connector is decommissioned.

**Backup.** The service is **not** stateless: `/var/lib/mail-mcp/accounts.json` holds every mailbox credential, and losing it means re-entering all of them by hand. Back up that directory *and* `.env` (which holds `AUTH_TOKEN`), encrypted at rest — `restic`, `borgbackup` or a `tar | gpg` pipeline. See [HARDENING.md](HARDENING.md#backup-strategy).

**Monitoring.** Hit `/health` from your uptime checker and alert on non-200 responses. Under systemd, also alert on restart loops (`systemctl show -p NRestarts claude-mail-mcp.service`); under Docker, on the container's health status. To catch a silently empty configuration, assert that `accounts` in the response is a non-empty array — the endpoint returns 200 with `"accounts":[]` when the credentials file is missing, so a plain status check would not notice. Per-account CalDAV configuration shows up as `caldav_enabled` *inside* each `accounts[]` entry.

**Connection idle.** The IMAP connection auto-reconnects on demand. If your provider closes idle connections aggressively (some do after 10 minutes), the next tool call simply reopens the socket.

## Container deployment (Docker)

An alternative to the systemd path above: pull the prebuilt image from GHCR and run it with `docker compose`, instead of building from source and managing a systemd unit yourself. Steps 6 and 7 above (nginx reverse proxy, adding to Claude) apply unchanged either way — the container listens on `127.0.0.1:3220`, the same address the systemd-run process listens on.

### 1. Get the compose file and pull the image

```bash
mkdir -p /opt/mail-mcp && cd /opt/mail-mcp
# clone the repo as in step 1 above and cd into it, or just copy
# docker-compose.yml and .env.docker.example from your own checkout
docker login ghcr.io   # only if the package isn't public for your account
docker compose pull
```

### 2. Configure `.env`

```bash
cp .env.docker.example .env
# generate the Bearer token clients will send to /mcp
echo "AUTH_TOKEN=$(openssl rand -hex 32)" >> .env
# edit .env: PUBLIC_URL, LOG_LEVEL
```

`HOST`, `PORT` and `ACCOUNTS_FILE` are fixed by the image and `docker-compose.yml` — they're not set in `.env` (see the comments in `.env.docker.example`).

### 3. Create `accounts.json`

The container runs as the non-root user `mailmcp`, **uid 100 / gid 101**. Those
numbers are pinned in the `Dockerfile` and are part of the image's published
contract; confirm them against the image you actually pulled with:

```bash
docker run --rm --entrypoint id ghcr.io/yannichock/claude-mail-mcp:latest
# uid=100(mailmcp) gid=101(mailmcp) groups=101(mailmcp)
```

The credentials file has to be readable by that uid *and* unreadable to every
other user on the host, so it needs an ownership change as well as the mode:

```bash
mkdir -p data
cat > data/accounts.json <<'JSON'
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
JSON
chown 100:101 data/accounts.json   # uid/gid of `mailmcp` inside the container
chmod 600 data/accounts.json
```

Do both, in that order. `chmod 600` on its own leaves the file owned by the host
user that created it — root, if you followed these steps as root — which uid 100
cannot read. `src/accounts.ts` rethrows every error that is not `ENOENT`, so
`main()` exits 1 and `restart: unless-stopped` in `docker-compose.yml` turns that
into an endless crash loop; `docker compose logs` shows nothing but:

```
Fatal startup error: Error: EACCES: permission denied, open '/data/accounts.json'
```

The `data/` directory itself keeps its default mode (`755`) — uid 100 only needs
to traverse it, and the directory name carries no secret. If `chown` reports
"Operation not permitted", you are not root: prefix both commands with `sudo`.

`docker-compose.yml` bind-mounts `./data` read-only at `/data` inside the container. The backend picks up edits to `data/accounts.json` via `fs.watch` — no restart needed, same behavior as the systemd deployment's `accounts.json`.

> Hot reload relies on inotify events crossing the bind mount, which they do on a Linux host — the deployment this document describes. They do **not** cross a Docker Desktop bind mount on Windows or macOS: the container reads the updated file correctly, but no watch event ever fires, so the running process keeps the accounts it started with. If you develop on one of those, `docker compose restart` after editing `accounts.json`.

### 4. Start it

```bash
docker compose up -d
docker compose logs -f
curl http://127.0.0.1:3220/health
```

`docker-compose.yml` already publishes the port as `127.0.0.1:3220:3220`, loopback only — see the warning comment in that file and in the `Dockerfile`. Never change that to a bare `3220:3220` or `0.0.0.0:3220:3220`: the container binds `0.0.0.0` *inside* itself out of necessity (Docker's port publishing requires it), so the host-side exposure is controlled entirely by this setting, and `GET /health` is unauthenticated.

### 5. Reverse proxy and adding to Claude

Same as steps 6 and 7 above: nginx terminates TLS on the public hostname and proxies to `http://127.0.0.1:3220`. Option A (Claude Desktop, Bearer auth) works as soon as the container is reachable through nginx; Option B (claude.ai web) still needs the OAuth 2.1 shim discussed there — none ships with this repository, container or not.

### 6. Updating

```bash
docker compose pull
docker compose up -d
```

### 7. Operational notes

Same as the systemd operational notes above (`AUTH_TOKEN` rotation, `/health` monitoring), plus: back up `.env` and `data/accounts.json` — the latter holds every mailbox credential and is not recoverable from anywhere else. `docker-compose.test.yml` in the repo is unrelated to this deployment; it only exists to give the integration test suite (`npm run test:integration`) a disposable mail server to talk to.
