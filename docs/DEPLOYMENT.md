# Deployment

The full reference for putting this connector on a server: what the two services
are, how they find each other, where their secrets live, what has to sit in front
of them, and what to do to it afterwards.

If you are deploying for the first time, start with the four-step
[Quick start](../README.md#quick-start) in the README and come back here for
depth — this page is the reference it points at, not a second copy of it.

Security posture and threat reasoning live in [HARDENING.md](HARDENING.md). This
page says what to do; that one says why it is safe.

---

## What you deploy

Two services, from two images, brought up together by the `docker-compose.yml` in
this repository:

| service | image | listens on | reachable from |
|---------|-------|-----------|----------------|
| `mail-mcp` | `ghcr.io/yannichock/claude-mail-mcp` | `0.0.0.0:3220` in the container, published to `127.0.0.1:3220` | the compose network, and the host's loopback |
| `mail-oauth` | `ghcr.io/yannichock/claude-mail-mcp-oauth` | `0.0.0.0:8080` in the container, published to `127.0.0.1:8080` | your reverse proxy |

**`mail-mcp` is the connector.** It holds the mailbox credentials, speaks IMAP,
SMTP and CalDAV, and serves the MCP tools at `POST /mcp` behind a single static
Bearer token. It is the process that parses MIME arriving from the public
internet, and nothing about the deployment should let the internet reach it
directly.

**`mail-oauth` is the OAuth 2.1 layer**, and it is the service your public
hostname points at. It implements the discovery documents, Dynamic Client
Registration and PKCE that claude.ai and Cowork require, forwards `/mcp` to the
connector with the connector's own token substituted in, serves the setup wizard
that configures a fresh instance, and serves the settings UI afterwards. It
reaches the connector as `http://mail-mcp:3220` on the compose network.

The two are **released together**. `scripts/check-versions.sh` fails a release
whose eight version strings — `package.json`, both lockfile entries and
`src/app.ts` on each side — disagree, CI runs it on every pull request and on
every `v*` tag, and the release workflow publishes both images from one run. So
`:latest` always names a release and always names the same release on both sides.
**Never pin one service to a tag the other is not on.**

Everything below assumes the compose file in this repository. If you run your own,
[the section on that](#if-your-host-does-not-run-this-repositorys-compose-file)
lists what has to be true of it.

### Running the connector on its own

If you only ever use Claude Desktop — or another MCP client that can send a custom
`Authorization` header — you do not need the OAuth layer. Comment the `mail-oauth`
service out of `docker-compose.yml` and front `127.0.0.1:3220` with your proxy
instead of `127.0.0.1:8080`.

What you give up is worth knowing before you choose it: **there is no setup wizard
and no settings UI without `mail-oauth`.** Both are served from its public origin.
Mailboxes then go into `accounts.json` by hand, as
[step 3](#3-the-data-volumes-and-accountsjson) describes, and `secrets/oauth/`
stays unused.

---

## Prerequisites

- **A Linux host with Docker Engine and Compose v2.** `docker compose version`
  must answer. The instructions below are written for a Linux host; the
  ownership and setgid rules that the secrets directories depend on are
  Linux filesystem semantics and do not survive a Docker Desktop bind mount on
  Windows or macOS.
- **A public DNS name with an A record.** Claude's connectors are IPv4-only: a
  hostname that publishes only AAAA records cannot be reached at all.
- **A TLS-terminating reverse proxy, which is yours to run.** Nothing in this
  repository terminates TLS, obtains a certificate or renews one. Both services
  bind plain HTTP on loopback and expect something in front. claude.ai will not
  connect to an `http://` origin, and the OAuth layer refuses to start with a
  non-HTTPS `PUBLIC_URL`. [Step 4](#4-reverse-proxy-and-tls) gives a worked nginx
  recipe; Caddy, Traefik or Nginx Proxy Manager are equally fine as long as they
  deliver the same properties.
- **An IMAP + SMTP capable mailbox.** On any provider with two-factor
  authentication — Gmail, iCloud, Fastmail — use an **app-specific password**,
  never the account password. The [README](../README.md#app-passwords-mandatory-on-2fa-accounts)
  has the direct links.
- Optionally, a CalDAV endpoint. Omit it and the calendar tools return a clear
  error for that mailbox while mail keeps working.

---

## 1. Get the compose file and the images

```bash
# Owned by you, not by root: every mkdir, cp and sed below runs unprivileged,
# and only the chgrp/chown/chmod calls need sudo.
sudo install -d -o "$USER" -g "$USER" /opt/mail-mcp
cd /opt/mail-mcp
# Clone the repository here, or copy just docker-compose.yml,
# .env.docker.example and oauth/.env.example out of a checkout.
git clone https://github.com/YannicHock/claude-mail-mcp.git .

docker login ghcr.io   # only if the packages are not public for your account
docker compose pull
```

Both images are multi-arch (amd64/arm64) and carry a build-provenance
attestation:

```bash
gh attestation verify --owner YannicHock oci://ghcr.io/yannichock/claude-mail-mcp:latest
gh attestation verify --owner YannicHock oci://ghcr.io/yannichock/claude-mail-mcp-oauth:latest
```

A push to `main` publishes `sha-<short>` and nothing else; a `v*` tag publishes
`X.Y.Z` and moves `latest`. Use `sha-<short>` — on **both** services — if you need
an unreleased commit; it names one commit and can never move.

---

## 2. Configure `.env`, `.env.oauth` and the secrets directories

```bash
cp .env.docker.example .env
cp oauth/.env.example .env.oauth

# A group for these secrets and nothing else, and the two directories it owns.
sudo groupadd --system mailsecrets
mkdir -p secrets/shared secrets/oauth
sudo chgrp mailsecrets secrets/shared secrets/oauth
sudo chmod 2770 secrets/shared secrets/oauth

# Tell Compose the gid your host assigned.
sed -i "s/^SECRETS_GID=.*/SECRETS_GID=$(getent group mailsecrets | cut -d: -f3)/" .env
grep '^SECRETS_GID=' .env
```

Then edit both files. **`PUBLIC_URL` must name the same address in the two of
them** — see [the note below](#public_url-has-to-match-on-both-sides) — and `SECRETS_GID`
must be in `.env`, because Compose interpolates `${...}` from the project's `.env`
only and never from a service's `env_file`.

Leave the rest alone. `ACCOUNTS_FILE` and every `*_FILE` path are set by
`docker-compose.yml`, whose `environment:` block wins over anything an `env_file`
says; `HOST` and `PORT` are the images' own defaults and the values the example
files carry are those same defaults.

**`PUBLIC_URL` and `SECRETS_GID` are the only two values you have to supply.** A
container cannot discover its own external address, and it cannot know which gid
your host handed the group you just made. Everything else has a working default.

Check the result before starting anything:

```bash
docker compose config >/dev/null && echo "compose file is valid"
```

Leave `SECRETS_GID` empty and that command fails with the reason, rather than the
stack coming up without the group:

```
error while interpolating services.mail-mcp.group_add.[]: required variable
SECRETS_GID is missing a value: set SECRETS_GID in .env to the gid of the group
that owns ./secrets/shared and ./secrets/oauth — see docs/DEPLOYMENT.md step 2
```

### The secrets generate themselves

Three of the four secrets are random bytes with no meaning outside this
deployment, and the first boot that finds one missing creates it:

| file | lives in | `mail-mcp` | `mail-oauth` |
|------|----------|-----------|--------------|
| `auth_token.txt` | `secrets/shared/` | reads, creates | reads, creates |
| `settings_signing_key.txt` | `secrets/shared/` | reads, creates | reads, creates |
| `oauth_signing_key.txt` | `secrets/oauth/` | not mounted | reads, creates |
| `auth_password_hash.txt` | `secrets/oauth/` | not mounted | reads, never creates |

The rule is one sentence and the whole design: **a present file wins, an absent
one is generated.** An upgrade therefore rotates nothing — the token your Claude
Desktop clients already hold is read back and reused. Setting `AUTH_TOKEN` inline
in `.env` before the first start *seeds* the file with your value rather than
being replaced by a generated one, so an install migrating from an
environment-only setup keeps its token.

A file that exists and holds **nothing** is not a present file. It is removed,
replaced with a fresh value, and reported at `warn`:

```
{"level":"warn","msg":"secret file was empty, replaced","secret":"AUTH_TOKEN",
 "source":"replaced","path":"/secrets/shared/auth_token.txt",
 "note":"the file was present but held nothing, so a new secret was written to it. …"}
```

On a first boot that is a file somebody `touch`ed. On any other boot it means a
live secret has just been rotated out from under whatever was holding it, and both
services need a restart so they read the same value.

Each service logs one line per secret at startup naming the source, which is the
fastest way to confirm the two agree:

```
{"level":"info","msg":"secret resolved","secret":"AUTH_TOKEN","source":"generated","path":"/secrets/shared/auth_token.txt"}
{"level":"info","msg":"secret resolved","secret":"UPSTREAM_AUTH_TOKEN","source":"file","path":"/secrets/shared/auth_token.txt"}
```

Read the Bearer token back with `sudo cat secrets/shared/auth_token.txt` when you need
it for a Claude Desktop client.

**`auth_password_hash.txt` is the exception and is never generated** — it is the
one secret with a meaning outside this deployment. You do not have to supply it
either: the [setup wizard](#5-start-the-stack-and-claim-the-instance) sets the
operator password in the browser, and that is the default path. Supplying it by
hand is the manual alternative, described [below](#setting-the-operator-password-by-hand).

### Two directories, because the two services are not the same audience

`docker-compose.yml` bind-mounts `./secrets/shared` into both services and
`./secrets/oauth` into `mail-oauth` alone. Each service is mounted only the half
it has business with.

Up to v0.6 there was one flat `./secrets` mounted read-write into both. The
connector's environment named only the shared pair, but the mount handed it all
four — the OAuth signing key, which is enough to mint an access token for `/mcp`,
and the operator's password hash, which is enough to attack offline and then sign
in at `/authorize` and `/settings`. The split is what puts those two out of the
connector's reach. Nothing else in the stack changed, and it costs one extra
`mkdir`.

Confirm it on a running stack — the second command is the one that matters:

```bash
docker compose exec mail-mcp ls -ln /secrets /secrets/shared
docker compose exec mail-mcp cat /secrets/oauth/oauth_signing_key.txt
# → cat: can't open '/secrets/oauth/oauth_signing_key.txt': No such file or directory
docker compose exec mail-oauth ls -ln /secrets/shared /secrets/oauth
```

**Create both subdirectories yourself before the first `docker compose up`.**
Docker creates a missing bind-mount source on its own, but as `root:root`, mode
`755` and without the setgid bit — neither container can write in it, and the
first secret either tries to create fails with `EACCES`.

### Why a group you create, rather than a number this page picks

Both containers create files in `secrets/shared` and they run as **different**
non-root uids, so they need one group in common:

```bash
docker run --rm --entrypoint id ghcr.io/yannichock/claude-mail-mcp:latest
# uid=100(mailmcp) gid=101(mailmcp) groups=101(mailmcp),101(mailmcp)
docker run --rm --entrypoint id ghcr.io/yannichock/claude-mail-mcp-oauth:latest
# uid=102(mailoauth) gid=103(mailoauth) groups=103(mailoauth),103(mailoauth)
docker compose exec mail-mcp id
# uid=100(mailmcp) gid=101(mailmcp) groups=101(mailmcp),<SECRETS_GID>
docker compose exec mail-oauth id
# uid=102(mailoauth) gid=103(mailoauth) groups=103(mailoauth),<SECRETS_GID>
```

The bare `docker run` shows no shared group at all — correct, and the reason
`group_add` is not optional.

`2770` gives that group `rwx` on the directory, and directory write permission is
what permits `unlink`: every member of the owning group can delete
`auth_token.txt` and put its own there. Since a present file always wins, that
planted token is the one both services adopt on the next restart. The files
themselves land at `640` in the same group, so a member can simply read the token
gating `POST /mcp` instead.

That is safe only when the group has no members but these two containers, which is
what `groupadd --system mailsecrets` gives you and what a pre-existing group does
not. **An earlier version of this page told you to run `sudo chgrp 105 secrets`**,
because gid 105 was pinned into both images and verified free *in
`node:24-alpine`*. The `chgrp` runs on the host, where 100–999 is the system
range: on a stock Debian 12 or Ubuntu 22.04–24.04, `getent group 105` usually
returns a real system group with a daemon in it, and the instruction handed that
group everything above. Neither image pins a gid any longer, and
`docker-compose.yml` puts both container processes in *your* group with
`group_add: ["${SECRETS_GID}"]`.

`secrets/oauth` is owned by the same group, for the same practical reason: the
OAuth container has to be able to create files there. That group membership is
*not* what keeps the connector out of it — the mount is. The connector has no path
to that directory at all, whatever group it is in, which is why one group for both
directories is enough and a second gid would only be a second thing to get wrong.

The **setgid** bit — the `2` in `2770` — is what makes a file created by one
service land in the directory's group rather than in the creator's own, which is
what lets the other service read it. `chmod 770` without it leaves the connector's
file in gid 101 at mode `640`, and the OAuth layer crash-loops on `EACCES`. Write
the mode correctly on **both** directories: the setgid directory is the only thing
providing this, and nothing else stands behind it.

`2770` equally means **no account outside that group can write here**, and that is
not incidental — see the takeover path two paragraphs up. A world-writable
`secrets/shared` is not an acceptable shortcut, and neither is reusing a group that
came with the distribution. `secrets/` itself is an ordinary directory owned by
whoever made it; nothing is mounted from it and no container ever traverses it.

Generated files land at mode `640`, owner and group only. `600` is the intuitive
choice and the one that crash-loops both containers, because neither runtime uid
owns a file the *other* service wrote; `644` would work but hands every account on
the host the connector's Bearer token.

### Pre-creating the secrets by hand

Nothing is ever generated over a file that already exists, so you can write the
three random ones yourself instead — the fourth is the password hash, which is the
next section:

```bash
openssl rand -hex 32     > secrets/shared/auth_token.txt
openssl rand -base64 48  > secrets/shared/settings_signing_key.txt
openssl rand -base64 48  > secrets/oauth/oauth_signing_key.txt
sudo chgrp mailsecrets secrets/shared/*.txt secrets/oauth/*.txt
chmod 640 secrets/shared/*.txt secrets/oauth/*.txt
```

The connector's mount can then be made read-only (`:ro`). **The OAuth layer's
cannot**: it replaces a secret file somebody truncated to nothing, and telling "no
password hash" from "hash unreadable" depends on that directory staying writable.

`secrets/` is already in `.gitignore`. Never commit any of these.

### Setting the operator password by hand

The wizard is the default path and this is the alternative to it. Write the scrypt
hash before the first start and the instance is configured from the outset — no
claim token is minted, no setup URL is printed, and `/setup` is 404 from the first
request:

```bash
read -rs PW && printf '%s\n' "$PW" | docker compose run --rm -T \
  --entrypoint node mail-oauth dist/hash-password.js \
  > secrets/oauth/auth_password_hash.txt; unset PW
sudo chgrp mailsecrets secrets/oauth/auth_password_hash.txt
chmod 640 secrets/oauth/auth_password_hash.txt
```

The `--entrypoint` override is required: the image's `ENTRYPOINT` is
`node dist/index.js`, so a trailing command is appended to it as arguments and
starts the server instead of the hashing tool. `read -rs` keeps the password off
the terminal and out of shell history.

`AUTH_PASSWORD_HASH` only **seeds** the operator record, once, on that record's
first creation. After that the live credential is `operator.json` on the OAuth
layer's data volume and the secret is not read again — [see below](#where-the-operator-password-actually-lives).

---

## 3. The data volumes, and `accounts.json`

**There is nothing to create here.** Both services keep their state on a Docker
named volume — `mail-data` and `oauth-data` in `docker-compose.yml`, which Compose
creates on the first start as `<project>_mail-data` and `<project>_oauth-data` —
and Docker initialises an empty named volume from the image, ownership included.
Both images pre-create `/data` owned by their own runtime user, so it comes out
right without an operator step and without any instruction here naming a uid.

Up to v0.6 these were bind mounts, `./data` and `./oauth-data`, and neither
directory is tracked in git. So on a clean clone Docker created both itself, as
`root:root` mode 755, and the two services — uid 100 and uid 102 — could write in
neither. The connector failed quietly, on the first mailbox somebody tried to
save; the OAuth layer failed on the one boot that matters, unable to write the
claim token and therefore unable to print a setup URL at all, in a restart loop
(#105). [The migration](#migrating-from-data-and-oauth-data) is below and loses
nothing.

**The connector's volume** holds `accounts.json`, every mailbox credential you
own. The connector writes it — the settings UI and the setup wizard both save
through it — so the *directory* has to be writable too, not just the file: saving
writes a temp file next to `accounts.json` and renames it into place.

**The OAuth layer's volume** holds `oauth-state.json` (registered clients and live
refresh sessions), `operator.json` (the live operator credential), and, while the
instance is unclaimed, `claim-token.txt` and `setup-wizard.json`.

Look inside either of them through the service that owns it:

```bash
docker compose exec mail-mcp   ls -ln /data
docker compose exec mail-oauth ls -ln /data
docker volume ls                  # what Compose called them on your host
```

Both services check that directory at startup now, and neither leaves you to find
out later. If you swap a volume back to a bind mount and forget to hand the
directory over, the OAuth layer refuses to start and the connector — on an install
that has no `accounts.json` yet — does too, each printing the exact `mkdir` and
`chown` for its own uid rather than a number written down here:

```
/data is not writable by this service (uid 102, gid 103). It holds the claim
token, the live operator record, and the registered clients and refresh sessions
in the OAuth state file. … If you have replaced that with a bind mount, create
the host directory and hand it to this service before starting again:

    mkdir -p ./oauth-data && sudo chown 102:103 ./oauth-data
```

A connector that already has an `accounts.json` warns instead of exiting: it can
still serve every mailbox it has, it just cannot save a new one.

### Writing `accounts.json` by hand

You do not need to. The wizard's step 2 configures the first mailbox and the
settings UI manages the rest. Write it yourself when you are running the connector
without the OAuth layer, or when you are restoring a single file from a backup.

Pipe it in through the connector's own image. The `--entrypoint` override means
the service does not start — this container exists only to hold the volume — and
because it runs as the image's own user the file lands owned by the connector,
with no `chown` and no uid to get wrong:

```bash
docker compose run --rm --no-deps -T --entrypoint sh mail-mcp \
  -c 'cat > /data/accounts.json && chmod 600 /data/accounts.json' <<'JSON'
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

docker compose exec mail-mcp ls -ln /data/accounts.json
# -rw------- 1 100 101 … /data/accounts.json
```

**Writing that file from the host is the trap this replaces.** A file created with
`sudo` stays owned by root, `chmod 600` then means uid 100 cannot read it, and the
connector rethrows every error that is not `ENOENT` — so it exits 1 and
`restart: unless-stopped` turns that into an endless crash loop with nothing in
`docker compose logs` but:

```
Fatal startup error: Error: EACCES: permission denied, open '/data/accounts.json'
```

Writing it through the image cannot produce that: the process doing the writing is
the process that has to read it back.

Add a `"caldav": { "url": …, "user": …, "pass": … }` block per account if your
provider speaks CalDAV. Multiple accounts go in the same array — see the
[README](../README.md#what-it-does) for the multi-account model. `"new"` and
`"test"` are **reserved ids**: an account using one cannot be edited from the
settings UI, because its edit page collides with a literal settings route.

Starting with no accounts is valid: `{"version": 1, "accounts": []}` boots with an
empty list and `/health` reports `"accounts": []`. A *missing* file means the same
thing. An unreadable one is fatal, which is why the ownership above matters.

The file is re-read via `fs.watch`, so adding a mailbox needs no restart.

> Hot reload relies on inotify events reaching the container, which they do from a
> named volume and from a bind mount on a Linux host — the deployment this
> document describes. They do **not** cross a Docker Desktop *bind mount* on
> Windows or macOS: the container reads the updated file correctly, but no watch
> event ever fires, so the running process keeps the accounts it started with. If
> you develop on one of those and have swapped in a bind mount,
> `docker compose restart mail-mcp` after editing `accounts.json`.

### Migrating from `./data` and `./oauth-data`

An install from v0.6 or earlier has both directories in the checkout. Nothing in
them is thrown away and nothing is regenerated: the two commands below copy them
onto the named volumes, and the old directories stay where they are until you have
seen the stack come back up on their contents.

**Copy before you start anything.** The `--entrypoint` override is what makes that
possible — it creates the container, which is what makes Docker create and
initialise the volume, while the service itself never runs. That ordering matters
for `mail-oauth` in particular: booting it against an empty volume would find no
operator record, mint a *new* claim token, and leave you with a configured instance
that thinks it is unclaimed once the real `operator.json` is copied in beside it.

```bash
docker compose down

docker compose run --rm --no-deps -v "$PWD/data:/old:ro" --entrypoint sh mail-mcp \
  -c 'cp -r /old/. /data/ && ls -ln /data'
docker compose run --rm --no-deps -v "$PWD/oauth-data:/old:ro" --entrypoint sh mail-oauth \
  -c 'cp -r /old/. /data/ && ls -ln /data'
```

`cp -r` rather than `cp -a`, deliberately: each copy runs as the service's own
user, so every file arrives owned by the process that has to read it, whatever it
was owned by on the host. Modes come across — `accounts.json` stays `600`.

Then start, and check that what came back is what you had:

```bash
docker compose up -d
docker compose exec mail-mcp   ls -ln /data
docker compose exec mail-oauth ls -ln /data
docker compose logs mail-oauth | tail -n 20
```

A migrated OAuth volume prints **no** setup banner — `operator.json` came across
with everything else, so the instance is claimed and `/setup` is 404, exactly as it
was. Your Claude clients stay connected: `oauth-state.json` holds their
registrations and refresh sessions, and none of the secrets under `secrets/` were
touched.

Once you are satisfied, back the two directories up somewhere off the host and
remove them. If something is wrong instead, `docker compose down`, put the bind
mounts back in `docker-compose.yml` — `- ./data:/data` and `- ./oauth-data:/data` —
and you are exactly where you started.

---

## 4. Reverse proxy and TLS

**Your public hostname points at `mail-oauth`, on `127.0.0.1:8080`.** Every path
Claude touches lives there: `/mcp`, the two discovery documents, `/authorize`,
`/token`, `/register`, the setup wizard at `/setup/<token>` and the settings UI at
`/settings`. The connector is never reachable from outside.

TLS is yours. The recipe below is nginx on the host; anything that terminates TLS,
forwards the original client address and preserves the request body will do. That
first requirement is stricter than it sounds if your terminator is a container —
see [If your TLS terminator is itself a container](#if-your-tls-terminator-is-itself-a-container)
below, and do not skip it.

### The rate-limit zones

`limit_req_zone` has to live in the `http {}` context — it does nothing inside a
`server` or `location` block. Add it once, outside any `server` block, e.g. in its
own file that your `nginx.conf`'s `http {}` block already includes
(`/etc/nginx/conf.d/*.conf` on most distros):

```nginx
# /etc/nginx/conf.d/mail-mcp-limits.conf
limit_req_zone $binary_remote_addr zone=mailmcp_auth:10m rate=120r/m;

# The key is the client address for POST and *empty* for every other method.
# nginx does not account a request whose key evaluates to empty, so this is
# what keeps `GET /settings/password` — merely opening the change-password
# form — out of the zone, while the POST that submits it is counted.
map $request_method $mcp_mail_login_key {
    POST    $binary_remote_addr;
    default "";
}

limit_req_zone $mcp_mail_login_key zone=mcp_mail_login:10m rate=10r/m;
```

**Do not lower `mailmcp_auth` to a login-form rate.** `/mcp` is a JSON-RPC
endpoint, not a login form: the connector runs the Streamable HTTP transport with
`sessionIdGenerator: undefined` and `enableJsonResponse: true`, so **every
JSON-RPC message is its own `POST /mcp`**. Simply connecting a client spends
`initialize` + `notifications/initialized` + `tools/list` before the user has
typed anything, and a request like "read my last four emails" spends several more.
At 10r/m the connector starts returning 503 in the middle of a conversation, with
nothing in the client to explain why.

120r/m with a burst of 60 leaves normal use untouched while still capping a
guessing loop at two attempts per second per IP. That cap is defence in depth
rather than the actual defence: the token behind it carries at least 128 bits of
entropy — 48 random bytes when the stack generated it, 32 if you supplied your own
with `openssl rand -hex 32` — so throttling changes a brute-force from infeasible
to infeasible.

### The site

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
    # Deliberately NOT set here. The application sets its own Referrer-Policy —
    # `same-origin` on every page that carries a form, because its CSRF checks
    # read Referer as a fallback when Chrome omits Origin on a same-origin form
    # POST. nginx's add_header *appends* rather than replacing a header the
    # proxied response already carries, so re-adding a blanket "no-referrer"
    # here would put two values on the wire, and the last one wins — silently
    # reverting the application's choice and breaking every sign-in with
    # "Request blocked". If you want a policy for endpoints that serve no HTML,
    # add `proxy_hide_header Referrer-Policy;` first, in that location only.
    add_header X-Robots-Tag              "noindex" always;

    location /mcp {
        # Sized for JSON-RPC, not for a login form: every MCP message is a
        # separate POST here (see the note above the zone definition).
        # Lowering this breaks live conversations.
        limit_req zone=mailmcp_auth burst=60 nodelay;

        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Authorization     $http_authorization;
        proxy_set_header Transfer-Encoding "";
    }

    location /health {
        # No rate limit here on purpose — uptime checkers poll this often, and
        # the OAuth layer's /health carries nothing but a status, a service
        # name and a version. It deliberately says nothing about the connector
        # behind it, whose own /health is not proxied and must not be.
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # --- Exactly these two paths, and nothing else under /settings. ---
    #
    # `location =` is an exact match, and nginx prefers an exact match over
    # every prefix match, so these two blocks are entered by
    # `/settings/login` and `/settings/password` and by no other URI.
    # `/settings/mailboxes`, `/settings/mailboxes/new`,
    # `/settings/clients/<id>/revoke`, `/settings/logout` and the rest keep
    # falling through to the catch-all below — and they must. Editing several
    # mailboxes is a burst of perfectly ordinary requests, and the design
    # document is emphatic on this point because a login-grade limit on a
    # non-login path has already taken this project down once.
    #
    # Do not "simplify" these into one `location /settings`. That is the outage.
    #
    # Neither block sets `add_header`, deliberately: they therefore inherit the
    # server-level security headers above, and the application's own
    # `Referrer-Policy` still reaches the browser untouched. If you ever add an
    # `add_header` here, repeat all the server-level ones too — and do not add
    # a `Referrer-Policy`, for the reason given up there.

    location = /settings/login {
        limit_req        zone=mcp_mail_login burst=5 nodelay;
        limit_req_status 429;

        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location = /settings/password {
        limit_req        zone=mcp_mail_login burst=5 nodelay;
        limit_req_status 429;

        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Everything else the OAuth layer serves: the two discovery documents,
    # /authorize, /token, /register, /settings/* and — while the instance is
    # unclaimed — /setup/<token>. This is not a place for a blanket 404: the
    # setup URL printed on the first boot is under /setup, and an unclaimed
    # instance already 404s every path it does not serve, from its own gate.
    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```bash
nginx -t && systemctl reload nginx
certbot --nginx -d mcp-mail.example.com
```

### Rate-limiting the settings sign-in

`10r/m` with `burst=5 nodelay` allows five attempts straight away and then one
every six seconds. That is deliberately **looser** than the application's own
throttle, which stops at five failures in fifteen minutes: the application stays
the thing that decides when the account is locked and the thing that says so on
the page, and nginx only caps the flood before it gets there. A limit tighter than
the application's would replace a sign-in page that explains itself with a bare
error from the proxy. `limit_req_status 429` is there for the same reason — the
default 503 reads as "the service is down" on a login form.

Both paths share the one zone, so rejected sign-ins also spend the budget for a
password change from that address. That mirrors what the application already does:
the sign-in shares its throttle with the `/authorize` consent screen on purpose,
because both guard the same credential.

The zone keys on `$binary_remote_addr` — the address **this** nginx sees. In this
recipe it is the internet-facing edge, so that is the client. If you put anything
in front of it that does not preserve the source address (another reverse proxy, or
Docker's own port publishing), every request arrives from one address and the whole
internet shares a single bucket. The application-side throttle collapses in exactly
the same way and for the same reason, so this is one condition, not two:
[The client address](HARDENING.md#the-client-address-15) in HARDENING.md states it
in full, including how to recognise a deployment that does not meet it.

`TRUST_PROXY` in `.env.oauth` is the other half of this. It is the number of proxy
hops in front of the OAuth layer, and it decides which `X-Forwarded-For` entry
becomes the client address the application's own throttle buckets on. `1` is
correct for the single TLS terminator above. Raise it only for a genuinely extra
trusted hop such as a CDN: setting it higher than the real chain lets a client
forge its own address again.

### If your TLS terminator is itself a container

Nginx Proxy Manager, Traefik or Caddy running in Docker: **give it
`network_mode: host`.** That is the supported arrangement, and it is what the
reference deployment runs.

```yaml
services:
  npm:
    image: jc21/nginx-proxy-manager:latest
    network_mode: host          # binds 80, 443 and 81 on the host itself
    # no ports: block — on host networking there is nothing to publish
```

A host-networked proxy reaches `127.0.0.1:8080` like the host recipe above, so
every `proxy_pass` in this section applies to it unchanged, and `TRUST_PROXY=1`
stays correct.

**Why not leave it on a bridge network and publish 80/443?** Because then it never
sees a client. Docker's `docker-proxy` rewrites the source address to the bridge
gateway before the proxy's socket, so `$remote_addr` — and therefore
`X-Forwarded-For`, the `limit_req` zone above, the application's login throttle and
the `ip` field a fail2ban jail reads — is one `172.x.x.x` address for the whole
internet. [The client address](HARDENING.md#the-client-address-15) in HARDENING.md
has the evidence, the one-line check in the proxy's own access log, and why
`"userland-proxy": false` is not the shortcut it looks like.

Two things change with host networking, and both bite on the first restart rather
than later:

- **Container names stop resolving.** Anything the proxy addressed as
  `mail-oauth:8080`, or as a compose service name — including its *own* database,
  if it has one — has to become a host-reachable address. Walk every proxy host on
  the box before you switch, not only the one that fronts this stack.
- **The `ports:` block has to go.** On host networking there is nothing to publish,
  and leaving it in is a compose error rather than a no-op.

If you genuinely cannot run the proxy on the host network, the alternative is to
drop the `ports:` block from `mail-oauth`, put both services on the proxy's network
and address `mail-oauth:8080` by service name. It publishes nothing to the host,
which is tighter in one respect — and it keeps the client address problem above in
full, which is why it is no longer the recommendation.

### If you also want static-Bearer clients

Claude Desktop authenticates with the connector's static `AUTH_TOKEN`, which the
OAuth layer's `/mcp` will not accept — it verifies only access tokens it issued
itself. To serve both, add a **second** `server {}` block on its own hostname whose
`/mcp` proxies to `http://127.0.0.1:3220`, with the same `limit_req zone=mailmcp_auth
burst=60 nodelay` and the same `proxy_set_header` lines. Do **not** expose the
connector's `/health` there: unlike the OAuth layer's, it discloses the server
name, the version, every configured mailbox's id, label and IMAP host, and the
path to the credentials file.

---

## 5. Start the stack and claim the instance

```bash
docker compose up -d
docker compose logs -f
```

A fresh instance is **unbootstrapped**: nobody has claimed it. In that state the
OAuth layer answers almost nothing, and the only way in is a claim token it prints
to its own log — the mechanism Jupyter uses. The whole route table:

| path | unbootstrapped | claimed |
|------|----------------|---------|
| `GET /health` | 200 | 200 |
| `POST /mcp` | **503** `not_configured` | normal |
| `GET /setup/<token>` | the wizard | 404 |
| `GET /setup/<anything else>` | 404 | 404 |
| `GET /authorize`, `/token`, `/register`, `/.well-known/…` | 404 | normal |
| `GET /settings/*` | 404 — there is no operator yet | normal |

`/mcp` answers 503 rather than 401 because an instance with no credentials cannot
reject anything meaningfully. A wrong claim token gets the *same* 404 a claimed
instance serves, byte for byte, so scanning cannot tell the two apart.

### The setup URL

The first boot generates the claim token, writes it to
`/data/claim-token.txt` on its own volume at mode `600`, and prints the complete link — built
from `PUBLIC_URL`, so you copy a link rather than assembling one:

```
{"level":"info","msg":"secret resolved","secret":"CLAIM_TOKEN","source":"generated","path":"/data/claim-token.txt"}
────────────────────────────────────────────────────────────────
  Setup required. Open this once to configure the instance:

    https://mcp-mail.example.com/setup/J5DgH17T3U9Wzbaiojsty1kZiop--OnPvoEAhlSQZyI

  Anyone with this link can claim this instance. It stops
  working as soon as setup completes.
────────────────────────────────────────────────────────────────
```

It goes to stdout directly rather than through the logger, so `LOG_LEVEL=warn`
cannot suppress it, and it is **reprinted on every boot until setup finishes**. The
token is read back off the volume rather than regenerated, so a restart mid-wizard
does not invalidate the tab you still have open.

The last line is the part to take seriously: the token is a bearer credential, and
anyone who gets the link owns the instance until setup completes. Do not paste it
anywhere.

### The three screens

1. **The operator account.** A username and a password, hashed with scrypt and
   written to `/data/operator.json` on its volume. Passwords under 12 characters, and a
   password equal to the username, are refused here rather than after the instance
   is exposed.
2. **The first mailbox.** Type an address and a password and the connector looks
   the domain's settings up — autoconfig, `.well-known`, the Mozilla ISPDB, SRV
   records — and shows what it found for confirmation. A provider list and the full
   form are behind it. *Save and continue* runs a real IMAP and SMTP connection
   test first and writes only if both answered; a CalDAV failure is a warning, not
   a refusal. *Skip for now* configures nothing and moves on.
3. **The MCP URL, and `PUBLIC_URL`.** The address to add as a custom connector in
   claude.ai, and the one question a container cannot answer for itself: is that
   really the address the outside world reaches this instance at? Answering *no*
   claims nothing, tells you what to change, and leaves the setup link live across
   the restart that changing it needs.

**Finish** deletes the claim token, and that is the whole transition — the operator
record was written back in step 1. `/setup/*` becomes the same 404 a wrong token
always got, permanently: there is no route back in, and starting over means
deleting the OAuth layer's data volume — `docker compose down`, then
`docker volume rm <project>_oauth-data`, which `docker volume ls` names for you.

### After Finish

**Nothing needs a restart.** `/mcp` is answering already — go straight to
[step 6](#6-add-to-claude) — and so is the settings UI at `/settings`, where you
sign in with the account you created in step 1. Both open in the process that
served the wizard: the claim state and the operator record are read per request,
not captured when the container started.

If you do restart, that is safe too: the instance is claimed, no new claim token
is minted, and no setup URL is printed again.

### An instance that is configured before it starts

If you wrote `secrets/oauth/auth_password_hash.txt` by hand, or set
`OPERATOR_FILE=none`, the instance is configured from the first request. No claim
token, no banner, no wizard — `/setup` is 404 and the settings UI is mounted
immediately. Add mailboxes from `/settings/mailboxes`, or write `accounts.json`
yourself.

---

## 6. Add to Claude

### Option A — Claude Desktop (static Bearer, simplest)

Claude Desktop, and any MCP client that lets you set a custom header, talks to the
**connector** directly and needs no OAuth layer at all.

```json
{
  "mcpServers": {
    "mail": {
      "url": "https://connector.example.com/mcp",
      "transport": "http",
      "headers": { "Authorization": "Bearer YOUR_AUTH_TOKEN" }
    }
  }
}
```

Claude Desktop → **Settings → Developer → Edit Config**, add the entry, restart
Claude Desktop, and the mail and calendar tools appear under "mail".

`YOUR_AUTH_TOKEN` is `sudo cat secrets/shared/auth_token.txt`. The URL is the hostname
you point at `127.0.0.1:3220` — either the second `server {}` block from
[step 4](#if-you-also-want-static-bearer-clients), or the only one, if you are
[running the connector on its own](#running-the-connector-on-its-own).

### Option B — claude.ai and Cowork (OAuth 2.1 + DCR)

These surfaces cannot send a custom `Authorization` header and will only connect
to a server that advertises OAuth 2.1 discovery. That is what `mail-oauth` is for,
and it needs no configuration beyond what you have already done:

1. claude.ai → **Settings → Connectors → Add custom connector**
2. URL: `https://mcp-mail.example.com/mcp` — the OAuth layer's public URL, which
   is `PUBLIC_URL` + `MCP_PATH`, and exactly the address the wizard's step 3 showed
   you
3. claude.ai discovers `/.well-known/oauth-authorization-server` and
   `/.well-known/oauth-protected-resource`, registers itself dynamically, and runs
   the PKCE flow
4. You sign in at `/authorize` with the operator account from wizard step 1
5. The tools appear in the connector

Claude Code does not need this layer either — it can use the connector's static
token directly, which is why loopback redirect URIs stay off unless you set
`ALLOW_LOOPBACK_REDIRECT=true`.

---

## 7. Verify

```bash
# Both services, and they must report the same version.
curl -s http://127.0.0.1:8080/health
# → {"status":"ok","service":"claude-mail-mcp-oauth","version":"…"}
curl -s http://127.0.0.1:3220/health
# → {"status":"ok","server":"claude-mail-mcp","version":"…",
#    "accounts":[{"id":"main","label":"Main","default":true,
#                 "smtp_from":"you@example.com","imap_host":"imap.mailbox.org",
#                 "caldav_enabled":false}],
#    "accounts_file":"/data/accounts.json"}
#
# `caldav_enabled` is per account, inside accounts[] — there is no top-level
# field of that name. `accounts` is [] when none are configured, and the
# endpoint still answers 200 in that state.

# The public origin is the OAuth layer, and it is the only one exposed.
curl -s https://mcp-mail.example.com/health
curl -s https://mcp-mail.example.com/.well-known/oauth-protected-resource

# An unauthenticated MCP request is rejected with the challenge Claude needs.
curl -i -X POST https://mcp-mail.example.com/mcp \
  -H 'Content-Type: application/json' -d '{}'
# → HTTP/1.1 401 Unauthorized
# → WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource"

# The connector, directly, with its own token.
curl -X POST http://127.0.0.1:3220/mcp \
  -H "Authorization: Bearer $(sudo cat secrets/shared/auth_token.txt)" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
# → JSON with 14 tools (1 account + 9 mail + 4 calendar), unconditionally —
#   calendar tools are always registered; they error per-call for any mailbox
#   with no `caldav` block.

# The secrets each service actually resolved, and from where.
docker compose logs --since 5m | grep '"secret'
# every line should say "source":"file" on anything but a first boot
```

The two services must be in the same group and see the halves they are meant to:

```bash
docker compose exec mail-mcp id
docker compose exec mail-oauth id
docker compose exec mail-mcp cat /secrets/oauth/oauth_signing_key.txt   # must fail
```

---

## The settings UI

Served from the OAuth layer's public origin. The connector's own `/settings`
routes are reachable only on the internal Docker network, and only with a signed
assertion from the OAuth layer.

Sign in at `https://<your PUBLIC_URL>/settings` with the operator account:

- `/settings/mailboxes` — add, test, edit and remove mailboxes; writes
  `accounts.json` on the connector's data volume
- `/settings/clients` — review and revoke connected Claude clients and their live
  sessions
- `/settings/password` — change the operator password

The sign-in shares its rate limit with the `/authorize` consent screen,
deliberately: both guard the same credential. Five failed attempts lock **both**
for fifteen minutes, so a failed settings login also blocks connecting a new Claude
client during that window. The edge limit in
[step 4](#rate-limiting-the-settings-sign-in) sits in front of that and is looser
on purpose.

**Nothing needs enabling.** `settings_signing_key.txt` is one of the two shared
secrets and generates itself on first boot; `docker-compose.yml` already points
both services at it. To turn the UI **off**, delete
`SETTINGS_SIGNING_KEY_FILE` from **both** services' `environment:` blocks in
`docker-compose.yml` — clearing it in an `env_file` achieves nothing, because the
compose file sets it again. With it gone the connector does not mount its settings
routes and the OAuth layer does not mount the UI: off, not half-on.

### `PUBLIC_URL` has to match on both sides

```bash
grep PUBLIC_URL .env .env.oauth
# both must print the same host, e.g. https://mcp-mail.example.com
```

It is the settings assertion's `iss` claim and both sides compare it. A mismatch
makes every settings request fail closed with `401`, and the only trace is a
`rejected settings request` line in the connector's log. Nothing else breaks —
`/mcp` keeps working — which is what makes this one hard to spot.

A difference in *spelling* is not a mismatch. Both services now run the value
through the same canonicalisation — lowercase scheme and host, no default port, no
query, no trailing slash — so `https://MCP-Mail.example.com/`,
`https://mcp-mail.example.com:443` and `https://mcp-mail.example.com` are one
address to both of them. What must match is the address itself: a different host, a
different path, or `http` against `https`.

### Where the operator password actually lives

`AUTH_PASSWORD_HASH` (or `AUTH_PASSWORD_HASH_FILE`) **seeds** the operator record
once, on that record's first creation. After that the live value is
`/data/operator.json` on the OAuth layer's own volume, because a password change
has to be able to write somewhere the secrets mount may not be.

The consequence worth knowing before it costs you an evening: **editing the secret
later has no effect.** The service logs which source is live at startup and warns
by name when the stored hash differs from the secret. Set `OPERATOR_FILE=none` in
`.env.oauth` to restore the older behaviour — hash from the secret only, password
change disabled, and no claim-token gate.

---

## Upgrading

```bash
cd /opt/mail-mcp
docker compose pull
docker compose up -d
docker compose logs --since 2m | grep '"secret'
```

Nothing is regenerated and no token changes: a present secret file always wins, so
every Claude Desktop client keeps working and every OAuth client keeps its
session. A `"source":"generated"` line after an upgrade means a file went missing
and a fresh secret has just replaced it — stop and find out why before anything
reconnects.

**Move both services together.** They are released from one commit and one
workflow run, and `scripts/check-versions.sh` is what guarantees the tree agreed
with itself when the tag was cut. Confirm it at runtime:

```bash
curl -s http://127.0.0.1:8080/health   # "version": X.Y.Z
curl -s http://127.0.0.1:3220/health   # the same X.Y.Z
```

**An upgrade that also brings a new `docker-compose.yml` may need one of the two
migrations below.** Both are one-way moves of files you already have, neither
regenerates anything, and both are safe to postpone: `secrets/` is two directories
now rather than one, and the two data directories are named volumes rather than
bind mounts — [that one is in step 3](#migrating-from-data-and-oauth-data), with
the reason in #105.

### Upgrading from a flat `secrets/` (v0.6 and earlier)

Two things have changed: the group is yours rather than gid 105, and `secrets/` is
now two directories. Do both in this order, with the stack still up. Nothing is
regenerated and no token changes.

```bash
cd /opt/mail-mcp                       # wherever your docker-compose.yml lives

# 1. the group, if you followed the old `chgrp 105 secrets`
getent group 105                       # see who you gave the directory to
sudo groupadd --system mailsecrets
sudo chgrp -R mailsecrets secrets && sudo chmod 2770 secrets
sudo chmod 640 secrets/*.txt
sed -i "s/^SECRETS_GID=.*/SECRETS_GID=$(getent group mailsecrets | cut -d: -f3)/" .env
grep -q '^SECRETS_GID=' .env || echo "SECRETS_GID=$(getent group mailsecrets | cut -d: -f3)" >> .env

# 2. the split — directories first, then the files, then the restart
mkdir -p secrets/shared secrets/oauth
sudo chgrp mailsecrets secrets/shared secrets/oauth
sudo chmod 2770 secrets/shared secrets/oauth
for f in auth_token.txt settings_signing_key.txt; do
  if [ -e "secrets/$f" ]; then sudo mv "secrets/$f" secrets/shared/; fi
done
for f in oauth_signing_key.txt auth_password_hash.txt; do
  if [ -e "secrets/$f" ]; then sudo mv "secrets/$f" secrets/oauth/; fi
done
ls -ln secrets secrets/shared secrets/oauth   # mode 640, group mailsecrets, in the right halves

docker compose pull && docker compose up -d
docker compose exec mail-mcp id               # the new gid must appear in groups=
docker compose logs --since 2m | grep '"secret'
# every line must say "source":"file" — a "generated" here means a file was
# left behind in the old flat directory and a fresh secret has just replaced it
```

A `mv` within one filesystem keeps each file's owner, group and mode, so the four
arrive in their new directories exactly as they were. Move them **before**
restarting: a container that starts against an empty `secrets/shared` generates a
new `auth_token`, and every Claude Desktop client holding the old one starts
answering 401.

Once the stack is healthy, delete anything still sitting in `secrets/` itself.
Nothing mounts that directory any more, so a leftover `auth_token.txt` there is not
the live token however much it looks like one.

If `getent group 105` named a real group, treat the secrets in that directory as
having been exposed to it: rotate them after the move by deleting
`secrets/shared/auth_token.txt`, `secrets/oauth/oauth_signing_key.txt` and
`secrets/shared/settings_signing_key.txt` and restarting, then re-enter the new
`auth_token` in any Claude Desktop client. Every OAuth client is logged out and
re-registers by itself.

### If your host does not run this repository's compose file

A stack assembled by hand, or one behind a containerised reverse proxy with its own
compose file, makes the same change as four environment values and three mount
lines. Make the directories and move the files as above, then, in your own file:

- `mail-mcp`: replace the `./secrets:/secrets` mount with
  `./secrets/shared:/secrets/shared`, and repoint `AUTH_TOKEN_FILE` and
  `SETTINGS_SIGNING_KEY_FILE` at `/secrets/shared/...`
- `mail-oauth`: replace `./secrets:/secrets` with `./secrets/shared:/secrets/shared`
  **and** `./secrets/oauth:/secrets/oauth`; repoint `UPSTREAM_AUTH_TOKEN_FILE` and
  `SETTINGS_SIGNING_KEY_FILE` at `/secrets/shared/...`, `SIGNING_KEY_FILE` and
  `AUTH_PASSWORD_HASH_FILE` at `/secrets/oauth/...`

Both mounts stay writable, and `group_add` on both services stays as it is. The
container-side paths are the only thing the images care about; nothing is baked
into either of them.

Whatever else your file does, four things have to hold: both services in the group
that owns the two setgid directories; each service's `/data` writable by that
service — which a named volume gives you and a bind mount does not, unless you hand
the directory over first; `UPSTREAM_MCP_URL` reaching the connector on a network
the internet cannot; and the same `PUBLIC_URL` on both sides.

---

## Backups

**Neither service is stateless.** Four things live outside the images, every one of
them holds a credential, and the first two cannot be recovered from anywhere else.
Back all four up, encrypted at rest — `restic`, `borgbackup`, or a `tar | gpg`
pipeline.

| what | why |
|------|-----|
| the connector's data volume (`accounts.json`) | every mailbox credential. Losing it means re-entering all of them by hand |
| `secrets/shared/`, `secrets/oauth/` | the Bearer token, both signing keys and the password hash. Losing the OAuth signing key logs every connected client out; losing `auth_token.txt` breaks every Claude Desktop client |
| the OAuth layer's data volume | the live operator credential (`operator.json`), registered clients and refresh sessions (`oauth-state.json`) |
| `.env`, `.env.oauth` | `PUBLIC_URL`, `SECRETS_GID`, `AUTH_USERNAME` and anything else you set |

The two `secrets/` directories are ordinary directories in the checkout and your
existing backup tool already reaches them. The two data volumes are Docker's, so
they come out through the service that owns each one — which also puts them back
without a `chown`, because the process doing the extracting is the process that has
to read the result:

```bash
docker compose run --rm --no-deps -T --entrypoint tar mail-mcp   -cf - -C /data . > mail-data.tar
docker compose run --rm --no-deps -T --entrypoint tar mail-oauth -cf - -C /data . > oauth-data.tar

# and back, onto an empty volume, with the stack down
docker compose run --rm --no-deps -T --entrypoint tar mail-mcp   -xf - -C /data < mail-data.tar
docker compose run --rm --no-deps -T --entrypoint tar mail-oauth -xf - -C /data < oauth-data.tar
```

Those tarballs hold plaintext mailbox passwords and the operator's password hash.
Encrypt them at rest — `restic`, `borgbackup`, or a `tar | gpg` pipeline — and
treat them exactly as you treat `secrets/`.

**Restore the secrets before starting the stack.** A container that comes up
against an empty `secrets/shared` does not fail — it generates a new token, exactly
as designed — and you will have quietly replaced the credential every client
holds. The same ordering applies to the OAuth layer's data volume: start it empty
and it mints a claim token, and an `operator.json` restored afterwards lands beside
a live one.

Preserve ownership and modes through the restore: `640` and the `mailsecrets` group
under `secrets/`, and the setgid bit on both secrets directories. `restic restore`
and `tar -p` keep them; a plain `cp` as root does not. The data volumes need none
of that care as long as they are restored through their own service, as above.

---

## Operations

**Monitoring.** Poll `https://<PUBLIC_URL>/health` from your uptime checker and
alert on non-200. Alert on container health as well: both images carry a
`HEALTHCHECK` — a plain Node HTTP request to their own `/health`, since Alpine
ships no curl — and `docker compose ps` reports `Up … (healthy)` per service.
Alert on a restart loop too; `restart: unless-stopped` will hide a crashing
container behind a container that keeps coming back. To catch a silently empty
configuration, assert that `accounts` in
the **connector's** `/health` is a non-empty array: that endpoint returns 200 with
`"accounts":[]` when the credentials file is missing, so a plain status check would
not notice. Do not expose the connector's `/health` publicly to do it — poll it on
loopback.

**Log lines worth an alert.** `secret file was empty, replaced` (a live secret was
just rotated out from under something), `rejected settings request` (usually a
`PUBLIC_URL` mismatch), the OAuth layer's login-failure lines (a fail2ban jail
belongs on these, ban action and all — [HARDENING.md](HARDENING.md) has the filter,
the jail and the two things that stop it matching), and `refresh token reuse
detected, session revoked`.

**Rotating the connector's Bearer token.** Clear `AUTH_TOKEN` in `.env` if you ever
set it inline, delete `secrets/shared/auth_token.txt`, `docker compose restart` both
services, and re-enter the new value in every Claude Desktop client. OAuth clients
are unaffected — they never see this token.

**Rotating the OAuth signing key.** Delete `secrets/oauth/oauth_signing_key.txt` and
restart `mail-oauth`. Every connected client is logged out and re-registers by
itself. Do it deliberately: a rotation and a refresh-token replay look alike in the
logs.

**Revoking a provider password.** If you use an app-specific password (Gmail,
iCloud, Fastmail), revoke it from the provider's own UI when a mailbox is removed
or the connector is decommissioned. Deleting it from `accounts.json` stops this
connector using it and nothing else.

**Connection idle.** The IMAP connection auto-reconnects on demand. If your
provider closes idle connections aggressively — some do after ten minutes — the
next tool call simply reopens the socket.

**Never publish either container on a bare port.** `docker-compose.yml` pins
`127.0.0.1:3220:3220` and `127.0.0.1:8080:8080`. Both images bind `0.0.0.0`
*inside* the container out of necessity — that is how Docker's port publishing
reaches them at all — so the host-side exposure is controlled entirely by that host
IP. `3220:3220` or `0.0.0.0:3220:3220` puts the connector's unauthenticated
`/health`, and then its `/mcp`, on every interface.

### "Refusing to start: … the data volume has been used before"

```
This instance has no operator credential — there is no operator record at
/data/operator.json, and AUTH_PASSWORD_HASH_FILE names
/secrets/oauth/auth_password_hash.txt, and nothing is there — but
/data/oauth-state.json shows the data volume has been used before. Refusing to
start …
```

This is a **broken secrets mount, not a first boot**, and the refusal is the
feature. An instance that authenticates from `AUTH_PASSWORD_HASH` alone has no
operator record, so a `secrets/` directory that vanished — a renamed host path, a
volume that did not attach, a typo after a host migration — would otherwise look
exactly like a container that has never run, and the service would mint a claim
token and print a setup URL for an instance that is already configured.

Restore the hash file and start again. Only if you really do mean to set this
instance up from scratch, delete the file the message names — and understand that
doing so discards every registered client and refresh session with it.

`STATE_FILE=none` keeps that state in memory, leaves nothing to find, and turns
this check off.

---

## Running from source

There is no supported from-source production deployment. The stack is two
services, three shared secret files whose modes and group are the whole of what
makes them readable by both, and a wizard served from the OAuth layer's public
origin; a hand-rolled unit per service reproduces all of that by hand and gets none
of it checked.

For local development, both packages run directly on **Node.js 24 or newer** — the
active LTS line, which both images ship (`node:24-alpine`), which `engines.node`
requires on both sides, and which CI runs the test suites on:

```bash
npm ci && npm run build && npm start          # the connector, on 127.0.0.1:3220
cd oauth && npm ci && npm run build && npm start
```

See [CONTRIBUTING.md](../CONTRIBUTING.md). `ecosystem.config.cjs` in the repository
root is a pm2 config for local development only — pm2 runs as the invoking user and
provides no isolation of any kind. `docker-compose.test.yml` is unrelated to this
deployment: it exists only to give the integration test suite
(`npm run test:integration`) a disposable mail server to talk to.
