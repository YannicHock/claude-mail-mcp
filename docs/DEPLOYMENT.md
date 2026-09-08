# Deployment

A typical production deployment behind nginx with pm2 as the process manager. Adapt to your stack as needed.

## Requirements

- Node.js ≥ 20
- A public DNS name pointing at your server (HTTPS is required by Claude.ai)
- An IMAP + SMTP capable mailbox
- Optionally a CalDAV endpoint

## 1. Clone and build

```bash
cd /var/www
git clone https://github.com/maxx3250/claude-mail-mcp.git mail-mcp
cd mail-mcp
npm ci
npm run build
```

## 2. Configure

```bash
cp .env.example .env
# generate the Bearer token clients will send to /mcp
echo "AUTH_TOKEN=$(openssl rand -hex 32)" >> .env
# edit .env and fill in IMAP_*, SMTP_*, DEFAULT_FROM, PUBLIC_URL, and optionally CALDAV_*
```

For two-factor mailboxes (Gmail, iCloud, Fastmail) use an **app-specific password**, never your main account password. See the table in the [README](../README.md#app-passwords-mandatory-on-2fa-accounts) for direct links.

## 3. Create the dedicated service user

```bash
useradd --system --no-create-home --shell /usr/sbin/nologin --comment "claude-mail-mcp" mailmcp
mkdir -p /var/lib/mail-mcp/oauth-state
chown -R mailmcp:mailmcp /var/lib/mail-mcp
chmod 700 /var/lib/mail-mcp /var/lib/mail-mcp/oauth-state
chgrp mailmcp /var/www/mail-mcp/.env
chmod 640 /var/www/mail-mcp/.env
```

If you build or deploy an OAuth shim (see step 6, Option B below — none ships in this repository) and it authenticates against an htpasswd file, give its service user group-read access:

```bash
chgrp mailmcp /etc/nginx/.htpasswd_mail
chmod 640 /etc/nginx/.htpasswd_mail
```

## 4. Run via hardened systemd unit

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

## 5. Reverse proxy (nginx)

```nginx
server {
    listen 80;
    server_name mcp-mail.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
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

    location / {
        proxy_pass http://127.0.0.1:3220;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Authorization     $http_authorization;
        proxy_set_header Transfer-Encoding "";
    }
}
```

```bash
certbot --nginx -d mcp-mail.example.com
```

## 6. Add to Claude

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

## 7. Verify

```bash
# health
curl https://mcp-mail.example.com/health
# → {"status":"ok",…,"caldav_enabled":true}

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

## 8. Updating

```bash
cd /var/www/mail-mcp
git pull
npm ci
npm run build
systemctl restart claude-mail-mcp.service
```

## 9. Operational notes

**Credentials.** Rotate `AUTH_TOKEN` periodically. If you use an app-specific password (Gmail, iCloud, Fastmail), revoke it from the provider's UI when the connector is decommissioned.

**Backup.** The service is stateless. Just keep `.env` safe.

**Monitoring.** Hit `/health` from your uptime checker. Alert on non-200 responses or pm2 restart loops. The endpoint also reports `caldav_enabled` so you can detect misconfiguration.

**Connection idle.** The IMAP connection auto-reconnects on demand. If your provider closes idle connections aggressively (some do after 10 minutes), the next tool call simply reopens the socket.

## Container deployment (Docker)

An alternative to the systemd path above: pull the prebuilt image from GHCR and run it with `docker compose`, instead of building from source and managing a systemd unit yourself. Steps 5 and 6 above (nginx reverse proxy, adding to Claude) apply unchanged either way — the container listens on `127.0.0.1:3220`, the same address the systemd-run process listens on.

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
chmod 600 data/accounts.json
```

`docker-compose.yml` bind-mounts `./data` read-only at `/data` inside the container. The backend picks up edits to `data/accounts.json` via `fs.watch` — no restart needed, same behavior as the systemd deployment's `accounts.json`.

### 4. Start it

```bash
docker compose up -d
docker compose logs -f
curl http://127.0.0.1:3220/health
```

`docker-compose.yml` already publishes the port as `127.0.0.1:3220:3220`, loopback only — see the warning comment in that file and in the `Dockerfile`. Never change that to a bare `3220:3220` or `0.0.0.0:3220:3220`: the container binds `0.0.0.0` *inside* itself out of necessity (Docker's port publishing requires it), so the host-side exposure is controlled entirely by this setting, and `GET /health` is unauthenticated.

### 5. Reverse proxy and adding to Claude

Same as steps 5 and 6 above: nginx terminates TLS on the public hostname and proxies to `http://127.0.0.1:3220`. Option A (Claude Desktop, Bearer auth) works as soon as the container is reachable through nginx; Option B (claude.ai web) still needs the OAuth 2.1 shim discussed there — none ships with this repository, container or not.

### 6. Updating

```bash
docker compose pull
docker compose up -d
```

### 7. Operational notes

Same as the systemd operational notes above (`AUTH_TOKEN` rotation, `/health` monitoring), plus: the container is stateless like the systemd process — back up `.env` and `data/accounts.json`. `docker-compose.test.yml` in the repo is unrelated to this deployment; it only exists to give the integration test suite (`npm run test:integration`) a disposable mail server to talk to.
