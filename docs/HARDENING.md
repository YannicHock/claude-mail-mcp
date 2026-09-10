# Hardening guide

This document is about the **security posture** of the deployment this repository
ships: what an attacker reaches, why each control exists, and what it does not
protect against.

It is not a runbook. Every step described here has its commands in
[DEPLOYMENT.md](DEPLOYMENT.md); where a hardening property is also a deployment
step, the reasoning is here and the procedure is there.

**Every claim below names the code or the test that makes it true.** A hardening
document whose claims nobody checked is worse than none, because it is believed.
Claims are stated against the repository as it stands; where one of them also
depends on something the repository cannot establish — the per-client controls
depend on the topology in [The client address](#the-client-address-15) — that
dependency is named rather than assumed.

---

## What ships

Two services, two container images, two non-root users, and one trust boundary
between them.

```
                        Internet
                           │
                           ▼
        ┌──────────────────────────────────────────────┐
        │ reverse proxy: TLS, HSTS, nosniff, noindex,  │
        │ limit_req on /mcp and on two /settings paths │
        └───────────────┬──────────────────────────────┘
                        │
                        ▼
   ┌────────────────────────────────────────────────────────┐
   │ mail-oauth        uid 102 / gid 103                     │
   │ OAuth 2.1 + DCR + PKCE, operator login, settings UI,    │
   │ setup wizard, session store, access/refresh tokens      │
   │                                                         │
   │ mounts  secrets/shared/   secrets/oauth/   oauth-data/  │
   └───────────────┬────────────────────────────────────────┘
                   │  substitutes the connector's static token
                   │  and proxies the MCP body upstream
                   ▼
   ┌────────────────────────────────────────────────────────┐
   │ mail-mcp          uid 100 / gid 101                     │
   │ IMAP / SMTP / CalDAV, MIME parsing, MCP tools           │
   │                                                         │
   │ mounts  secrets/shared/                data/            │
   └────────────────────────────────────────────────────────┘
```

Both uids are pinned in the images (`Dockerfile:83-86`, `oauth/Dockerfile:67-70`)
and they are **different on purpose** — that difference is what makes the secrets
split below mean anything.

The asymmetry that shapes everything else: **`mail-mcp` parses bytes an attacker
chose.** Every message it fetches is attacker-supplied MIME from the public
internet, decoded by third-party libraries. `mail-oauth` parses form fields from a
browser the operator drove. So the credential that grants privilege — the token
signing key, the operator's password hash — is kept where the MIME parser cannot
reach it.

`mail-oauth` is only needed for clients that cannot send a custom `Authorization`
header and require OAuth 2.1 discovery instead (claude.ai web, Cowork). Claude
Desktop talks to `mail-mcp` directly with the static token and needs none of it.
Both topologies are in [DEPLOYMENT.md](DEPLOYMENT.md); everything below that names
`mail-oauth` applies only when you run it.

### What each service holds

| File | `mail-mcp` | `mail-oauth` | What it is |
|---|---|---|---|
| `data/accounts.json` | reads, writes | no | Every mailbox credential, in plain JSON |
| `secrets/shared/auth_token.txt` | reads | reads | The static Bearer token gating the connector's `/mcp` |
| `secrets/shared/settings_signing_key.txt` | reads | reads | HMAC key for the per-request settings assertion |
| `secrets/oauth/oauth_signing_key.txt` | **no** | reads | Signs access and refresh tokens |
| `secrets/oauth/auth_password_hash.txt` | **no** | reads | scrypt hash of the operator password |
| `oauth-data/oauth-state.json` | no | reads, writes | Registered clients, live sessions |
| `oauth-data/claim-token.txt` | no | reads, deletes | The one-time setup credential, while unclaimed |

The mount lists that produce this table are in `docker-compose.yml`, and they are
asserted rather than trusted: `test/unit/secrets.test.ts` pins
*"neither service mounts a flat ./secrets"*, *"the connector mounts the shared
half and nothing else"*, *"the OAuth layer mounts both halves"*, and
*"every secret path a service names is inside a directory it mounts"*.

---

## The trust boundary: what a compromised connector reaches

Suppose something the connector executes — a parser bug reached through
attacker-supplied MIME, or a compromised dependency — reads files as uid 100.

**It reaches:** `data/accounts.json` (every mailbox credential) and both files in
`secrets/shared/`. That is total compromise of the mailboxes, and no control here
prevents it. `secrets/shared` is the connector's *own* credential set: the token
it authenticates with, and the key it verifies settings assertions with.

**It does not reach** `secrets/oauth/`. Not because of a permission bit, but
because that directory is not mounted into the container at all — there is no
path to it from inside, whatever group the process is in.

That matters concretely. Until #77 one flat `./secrets` was mounted read-write
into both services, which handed the MIME parser the OAuth signing key (mint an
access token for `/mcp` and skip the login entirely) and the operator's password
hash (crack it offline, then own `/authorize` and `/settings`). The connector's
environment named neither file; the mount handed it both.

**The residual, stated exactly.** `secrets/shared` is writable from both sides,
because whichever service boots first generates the two shared secrets on a first
boot, and replacing a file somebody truncated to nothing means unlinking it first
(`src/secrets.ts`, `resolveSecret` and `removeBlankFile`). So a compromised
connector can **replace** the shared pair. It cannot use them to gain privilege —
it already had them — but replacing them is a denial of service: the OAuth layer
keeps presenting the old token upstream until it is restarted, and on restart both
services re-key onto whatever the attacker wrote. Loss of availability and a
forced credential rotation, not escalation.

You can close even that by pre-creating all four files by hand and marking the
connector's mount `:ro`. Nothing is ever generated over a file that already
exists — the rule is stated once in `src/secrets.ts` and pinned by
*"reads the file and writes nothing"*, *"wins over an inline value, and over
generating one"* and *"reads back the same value on the next boot, rather than
rotating"* in `test/unit/secrets.test.ts`. The OAuth layer's mount cannot be made
read-only: it rewrites a blanked secret in place, and the "no hash" versus "hash
unreadable" distinction below depends on that.

**What the OAuth layer's compromise costs** is unchanged by any of this: it
legitimately reads all four secrets. The split protects the layer that parses
hostile input, in the direction that input travels.

### What never crosses back

The connector's static token is substituted into the proxied request by
`oauth/src/proxy.ts` and never travels outward. `oauth/test/integration/proxy-isolation.test.ts`
asserts it *"does not appear in a successful response"*, *"does not appear even if
the upstream echoes it back"*, *"does not appear in a 401 challenge"*, *"does not
appear in the discovery documents"*, *"does not appear in an issued token"* and
*"does not appear on an upstream failure"*. The browser's session cookie does not
travel inward either — `cookie` is in the proxy's hop-by-hop set
(`oauth/src/proxy.ts`), asserted by *"strips the Cookie header before forwarding"*
in `oauth/test/unit/proxy-headers.test.ts`.

The connector's `/health` is not proxied. It discloses the server version, the
number and public summary of configured mailboxes, and the filesystem path to
`accounts.json`; the OAuth layer's own `/health` returns
`{status, service, version}` and nothing about what is behind it
(`oauth/src/app.ts`, asserted by *"answers with this service's own health,
disclosing nothing about the connector"* and *"does not proxy /health upstream"*).
The connector's `/health` is unauthenticated by design, which is why the compose
file publishes it on `127.0.0.1` only and warns in as many words against changing
that.

---

## Secrets on disk: why `600` is the intuitive choice and the wrong one

Generated secret files are mode **`640`**. The two directories that hold them are
mode **`2770`**, group-owned by a group you create, whose gid you name to the
stack as `SECRETS_GID`.

`600` is what anyone reaches for first, and it does not work here.

The two images run as **different** non-root users — uid 100/gid 101 and uid
102/gid 103 — and both must read the *same* `auth_token.txt` and
`settings_signing_key.txt`. Under `600`, whichever service happened to create the
file is the only one that can read it; the other crash-loops on `EACCES` with
nothing in `docker compose logs` but a permission error. That is not a
hypothetical: it is the documented failure that made the secrets self-generating
in the first place (`src/secrets.ts`, the module docstring and the
`GENERATED_SECRET_MODE` docstring).

So the file has to be group-readable, and both processes have to be in that group.
`docker-compose.yml` puts them there with `group_add: ["${SECRETS_GID:?...}"]` on
both services, and the interpolation is written to **fail the stack** rather than
start it without one.

`644` would also "work", and it was what a first draft used. It is worse:

- Every account on the host can then read the connector's Bearer token.
- For two different uids to *create* files in a `644` world, the directory would
  have to be world-writable — and the precedence rule is "a present file wins", so
  any local user who drops an `auth_token.txt` into `secrets/shared` before the
  first boot owns the instance.

`640` plus a `2770` directory gives both properties at once: readable to exactly
the two service accounts, and writable by nobody outside the group.

**The setgid bit is the mechanism, and it is the only one.** Nothing in
`src/secrets.ts` chowns anything. It cannot: the gid is not knowable at image
build time, and the two services do not both receive it at run time either. Mode
`2770` on `secrets/shared` and `secrets/oauth` is what puts a file created by
either service into the shared group instead of into the creator's own. Without
it, the connector's file lands in gid 101 at mode 640 and the OAuth layer cannot
read it — the same crash loop `600` produces, arrived at differently.

**The gid is yours, not this repository's.** Earlier versions pinned `mailsecrets`
at gid 105 in both images and told you to `chgrp 105 secrets`. 105 really is free
inside `node:24-alpine` — but the `chgrp` runs on the **host**, where 100–999 is
the system range and 105 usually already belongs to a real daemon. Where it did,
that instruction handed an unrelated system group a writable secrets directory,
and "a present file wins" would have adopted whatever it put there (#76). Nothing
in either image pins a gid any more.

What pins all of this:

| Claim | Where |
|---|---|
| The mode is group-readable, closed to other, not group-writable | `test/unit/secrets.test.ts` — *"declares a mode the other image's uid can read, and nobody else"* |
| That mode actually reaches the disk, umask and all | *"writes that mode to disk"* (POSIX only) |
| Neither image bakes a gid, publishes a `secrets-gid` label, or puts its user in a shared group | *"`Dockerfile` pins no gid for the shared secrets group"* and siblings, run over both Dockerfiles |
| Both services are put in `${SECRETS_GID}`, and the stack refuses to start without it | *"docker-compose.yml puts both services in ${SECRETS_GID}"*, *"docker-compose.yml refuses to start without SECRETS_GID"* |
| The two copies of the module have not drifted apart | *"stay identical below the header comment"* |

`auth_password_hash.txt` is the one secret that is **never** generated: it is the
only value with a meaning outside this deployment. It is either written by the
setup wizard or supplied by hand.

### The one file that is `600`, and why

The claim token is `0600` (`CLAIM_TOKEN_MODE` in `oauth/src/bootstrap.ts`), not
`640`. The reasoning inverts cleanly: only one service ever reads it, so the
shared group buys nothing, and what it grants is **full control of an unclaimed
instance**. `600` grants no group anything, whatever group the setgid directory
puts the file in. Pinned by *"is written 0600, not at the shared secrets' mode"*
in `oauth/test/unit/bootstrap.test.ts`.

The wizard's progress file is written `0600` too (`oauth/src/setup-state.ts`),
though no test asserts that mode. It holds progress only — never a username, a
password or a hash.

---

## An instance nobody has claimed yet

A fresh OAuth layer with no operator record and no configured password hash is
**unbootstrapped**. In that state it is gated ahead of every route
(`oauth/src/app.ts`, the middleware mounted before the discovery routes):

| Path | Unbootstrapped | Claimed |
|---|---|---|
| `/health` | 200 | 200 |
| `/setup/<the token>` | the wizard | 404 |
| `/setup/<anything else>` | 404 | 404 |
| `/mcp` | 503 `not_configured` | normal |
| `/settings/*` | not mounted at all | normal |
| everything else | 404 | normal |

Two properties this is built around.

**`/mcp` answers 503, not 401.** An instance with no credentials cannot reject
anything meaningfully, and a 401 invites guessing against a service that has
nothing to guess at.

**A wrong claim token gets the same 404 a claimed instance serves — byte for
byte, from the same responder.** `sendNotFound` is one function precisely so the
gate's 404 and the catch-all's 404 cannot drift; a difference between them would
be the oracle. A 401 there would announce "there is a token, and this is not it".
The comparison is constant-time (`Bootstrap.accepts` → `constantTimeEquals` in
`oauth/src/passwords.ts`), and an unknown sub-path *under a valid token* comes
back through the same responder as well.

Asserted end to end in `oauth/test/integration/bootstrap-gate.test.ts`:
*"an unclaimed instance answers /health as usual"*, *"an unclaimed instance
answers 503 at /mcp, not 401"*, *"an unclaimed instance 404s every other path,
mounted or not"*, *"a wrong claim token is indistinguishable from a claimed
instance"* (status, content-type and body compared across two harnesses),
*"a token that is a prefix or an extension of the real one is refused"*, and
*"a sub-path the wizard does not serve is the same 404 a wrong token gets"*.

### The claim token is a bearer credential, and the risk it accepts

32 random bytes, base64url, written to the data volume and **printed to stdout on
every boot until setup completes** — not through the logger, because
`LOG_LEVEL=warn` would suppress it and leave the operator with no way to claim
their own instance. The banner says what the link is: *"Anyone with this link can
claim this instance. It stops working as soon as setup completes."*

**This reduces takeover to "an attacker who can read your container logs"** — who
has already won by other means. State the rest honestly:

- **It does not expire.** There is no TTL and no rotation. An instance left
  unclaimed stays claimable indefinitely by anyone who ever read a boot log.
- **It is not single-use.** It is the credential for all three wizard screens, and
  it is consumed only by Finish. A token consumed at step 1 would strand the
  operator with no route back.
- **It survives a restart on purpose.** A container that comes back up while its
  operator is mid-setup must not invalidate the tab they still have open.
- **It does not protect against pasting the setup URL somewhere public.** Nothing
  can.
- **`/mcp`'s 503 does tell an unauthenticated scanner that setup is pending.** The
  404-equivalence above hides *which token is right*, not *that a token exists*.
- **The constant-time compare still leaks length in principle** — the dummy
  comparison on a length mismatch costs the length of the candidate, not of the
  token. Low severity against 32 random bytes; recorded rather than hidden.
- **The timing property rests on code review, not on a test.** The tests prove
  rejection, not constant time.

Completing setup deletes the token and closes `/setup` permanently — there is no
route back in, and starting over means deleting the data volume
(*"completing setup closes /setup permanently and opens /mcp"*, and
*"every /setup path afterwards is the same 404 a wrong token gets, byte for byte"*
in `oauth/test/integration/setup-wizard.test.ts`). A claim that fails halfway
moves nothing: `complete()` refuses to flip the state unless the token file is
actually gone (*"leaves the instance exactly as it was when the token cannot be
deleted"*).

### A used volume with no credential refuses to boot

The dangerous case is not the first boot; it is the *fifth*. If a secrets mount
breaks and the password hash vanishes from a volume that has already served
traffic, the old rule read that as "a fresh instance" and printed a setup URL —
offering a configured, mailbox-holding instance to whoever saw the log.

`assertFirstBoot` (`oauth/src/bootstrap.ts`) refuses to start instead. Evidence of
prior use is the OAuth state file, or a `.corrupt-<timestamp>` sibling the store
quarantined. Deliberately *not* evidence: the claim token and the wizard progress
file — which is what keeps a half-finished wizard bootable across a restart. The
error names the missing secret, the evidence file, and what to do about it, and it
is thrown before the app is constructed, so there is no route table at all.

Pinned by *"a used volume that lost its credential never gets as far as a route
table"* (`bootstrap-gate.test.ts`) and the whole
*"a data volume that has been used before is not a first boot"* block in
`oauth/test/unit/bootstrap.test.ts`, including *"still mints a claim token on a
genuinely empty data volume"* and *"still boots mid-wizard, before step 1 has
written the operator record"* — the two cases that must **not** refuse.

---

## Authentication, and what revocation actually revokes

**`/mcp` at the edge** requires a signed access token, verified before anything is
proxied (`oauth/src/app.ts`, `oauth/src/tokens.ts`). A missing or failing token
gets a 401 carrying `WWW-Authenticate` with the protected-resource metadata URL —
which is the entire protocol signal to Claude; a 200 with an error body produces no
Connect button at all.

**`/mcp` on the connector** requires the static Bearer token, checked on every
request (`src/app.ts`, `bearerAuth`). Generated as 48 random bytes base64url, or
supplied as `AUTH_TOKEN`. It is not practically guessable; the entropy does that
work, not the rate limit.

**`/settings/*` on the connector requires two credentials**, not one: the static
Bearer token *and* an HMAC assertion signed per request and bound to that exact
method and path (`src/settings-assertion.ts`, mirrored in
`oauth/src/assertion.ts`). Verification recomputes the MAC over the transmitted
string, compares in constant time, and only then parses the JSON — no
attacker-controlled bytes reach `JSON.parse` before the signature holds.
Deliberately not a JWT: no algorithm field to confuse, no canonicalisation to
disagree about.

### Revocation is immediate

Revoking a session stops the access token it issued **on the next request**, not
within the hour (#2). The access token is a stateless JWT, but verification
performs three store lookups every time (`oauth/src/tokens.ts`):

| Action | Mechanism | What dies |
|---|---|---|
| Revoke one session | `deleteSession(sid)` | the token's `sid` no longer resolves |
| Revoke one client | `revokedAt` on the client | every token with `iat` before it; that client's sessions |
| Revoke everything | `tokenEpoch += 1` | every token carrying an older epoch |

Rotation reuses the `sid`, so an access token minted by a refresh stays bound to
the session the operator sees listed on `/settings/clients`.

Asserted through a real proxied `/mcp` request in
`oauth/test/integration/settings-clients.test.ts` — *"revoking a client ends its
session and its access token at once"*, *"revoking one session leaves the other
client's session alone"*, *"revoking everything ends every client's session and
access token"* — and at the unit level in `oauth/test/unit/tokens.test.ts`:
*"an access token stops verifying once its own session is revoked"*, *"revoking
one session leaves the other session's access token working"*, *"an access token
minted by a refresh dies with the session too"*, *"a token naming a session that
never existed is refused"*.

**One bounded exception, deliberate.** A token minted before the `sid` claim
existed still verifies — refusing it would sign every connected client out on
upgrade. The window is one access-token lifetime, after which no such token can
still be alive. Pinned by *"a token minted before the sid claim existed still
verifies"*.

Lifetimes (`oauth/src/config.ts`, defaults asserted by *"applies documented
defaults"*):

| Credential | Default | Override |
|---|---|---|
| Access token | 1 hour | `ACCESS_TOKEN_TTL` |
| Refresh token | 30 days | `REFRESH_TOKEN_TTL` |
| Operator browser session | 1 hour | — (`SESSION_TTL_SECONDS`) |

The operator's browser session has an epoch of its own, separate from the token
epoch: signing out everywhere and changing the password both bump it, which
invalidates every cookie at once (*"a session cookie minted before a password
change stops working after it"*).

---

## Browser-facing surfaces

The OAuth layer serves HTML: the consent screen, the settings UI and the setup
wizard. Each of those takes a password or carries a CSRF token, so each gets the
same four headers.

```
Cache-Control:           no-store
X-Frame-Options:         DENY
Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline';
                         form-action 'self'; frame-ancestors 'none'
Referrer-Policy:         same-origin
```

**One definition, and it is a function that *sends* rather than a constant you must
remember to set.** `pageHeaders()` in `oauth/src/settings-pages.ts` is the only way
a page leaves this service. That shape is the fix for a real defect:
`respondWithErrorPage()` sat two lines from the constant #61 introduced, chained
`.status().type().send()` without the `.set()`, and served all six `/authorize`
error pages with no cache, framing, CSP or referrer rule at all (#80). A constant
can be forgotten at the send site; a function that does the sending can only be
forgotten by not rendering anything.

Two deliberate variations:

- **The consent screen widens `form-action`** to the origins in the redirect
  allowlist. Submitting it redirects to the client's registered `redirect_uri`, and
  Chrome enforces `form-action` against the redirect *target*; `'self'` alone kills
  the hand-off to claude.ai on the last step with a console-only error. The
  allowlist is the same one a `redirect_uri` is validated against at registration,
  so this widens it to exactly the destinations the code could already have gone to.
- **`Referrer-Policy` is `same-origin`, not `no-referrer`.** The POST handlers
  verify same-origin by reading `Origin` and falling back to `Referer`, and Chrome
  sends no `Origin` on a same-origin form POST. `no-referrer` left the check with
  neither header and refused every browser sign-in. `same-origin` still withholds
  the referrer from any cross-origin destination, which is the property that
  matters. **Do not add a `Referrer-Policy` at the reverse proxy**: nginx
  `add_header` appends rather than replaces, and two values is not a stricter
  setting.

HSTS, `X-Content-Type-Options: nosniff` and `X-Robots-Tag: noindex` are the
proxy's, not the application's — see [DEPLOYMENT.md](DEPLOYMENT.md).

`pageHeaders` exists **twice**, once per package, because the two have separate
Docker build contexts and cannot share a module. That duplication is caught rather
than trusted: `test/unit/settings-headers.test.ts` compares the two source texts in
*"the two surviving copies of the header set are identical"*. The values themselves
are asserted **on served responses**, against literals written out independently of
the constant, in `oauth/test/integration/page-headers.test.ts` — every operator
page, the consent screen, the consent screen re-served after a wrong password, and
every `/authorize` refusal that renders a page.

**CSRF.** Every state-changing POST is checked for same-origin, reading `Origin`
and falling back to `Referer`, and settings forms additionally carry a CSRF field
bound to the session. `oauth/test/integration/origin-check.test.ts` runs both the
sign-in POST and the consent POST against the header combinations browsers really
send. The setup wizard's POSTs are same-origin-checked but carry no CSRF token —
there is no session yet to bind one to, and the token in the URL is the credential.

**No script.** The CSP allows inline styles and nothing else, which is why every
interaction on these pages is a form submission.

---

## Rate limiting and brute force

Three layers, and only two of them exist in this repository.

### The application throttle

`oauth/src/throttle.ts`: **five failures in a sliding fifteen-minute window**, per
IP, counting failures only — a successful sign-in clears the bucket. A lockout
answers 429 with `Retry-After`.

**One bucket, three endpoints.** `POST /authorize`, `POST /settings/login` and the
current-password check in `POST /settings/password` share a single `LoginThrottle`
instance, deliberately: giving settings its own budget would mean ten attempts
instead of five for the same credential. The consequence is worth knowing before
it surprises you — five failed settings sign-ins also block connecting a new Claude
client for the rest of the window. Asserted by *"the settings throttle and the
OAuth sign-in throttle share one budget"* in
`oauth/test/integration/settings-session.test.ts`.

The bucket key is the address only, never the username. One attacker cannot lock
the operator out of their own instance (*"counts per IP, so one attacker does not
lock out the operator"*), and the numbers are pinned by *"ships with the documented
defaults"* in `oauth/test/unit/throttle.test.ts`. A distributed guesser gets five
attempts per source address; the edge limit and a jail are what are supposed to
answer that.

### The edge limit

`limit_req`, scoped to **exactly** `POST /settings/login` and `POST /settings/password`
and to nothing else under `/settings` — the recipe is in
[DEPLOYMENT.md](DEPLOYMENT.md), under "Rate-limiting the settings sign-in".

The scoping is the point, not a detail. Editing several mailboxes is a burst of
perfectly ordinary requests, and **this project has already shipped one outage
caused by a login-grade limit on a non-login path**. `location =` is an exact
match and nginx prefers it over every prefix match, so `/settings/mailboxes`,
`/settings/clients/<id>/revoke` and `/settings/logout` keep falling through to
whatever serves `/settings`. Do not "simplify" the two blocks into one
`location /settings`; that is the outage.

The zone is deliberately **looser** than the application throttle — five straight
away, then one every six seconds, against the application's five per fifteen
minutes. The application stays the thing that decides when the account is locked
and the thing that says so on the page; nginx only caps the flood before it gets
there. A tighter edge limit would replace a sign-in page that explains itself with
a bare proxy error. `limit_req_status 429` is set for the same reason: the default
503 reads as "the service is down" on a login form.

`/mcp`'s own zone is sized for JSON-RPC, not for a login form — every MCP message
is its own POST, and a login-grade rate would cut live conversations off. Against
128 bits of token entropy it is defence in depth, not the defence.

### The proxy hop count

`app.set("trust proxy", …)` decides which `X-Forwarded-For` entry becomes `req.ip`,
and therefore which address the throttle buckets on and the log line names.

**Both services take a hop count, never a boolean** — `TRUST_PROXY`, default 1
(`trustProxyHops` in `oauth/src/config.ts` and in `src/config.ts`).
`trust proxy: true` trusts the whole chain and takes its leftmost entry — which the
client writes, because a reverse proxy only *appends* the address it saw. A client
sending `X-Forwarded-For: <anything>` would then pick its own `req.ip`, land every
attempt in a different bucket, and write an attacker-chosen address into the line a
jail reads. A hop count makes Express skip exactly the proxies that are really
there. Raise it above 1 only if there is genuinely another trusted hop, such as a
CDN: setting it higher than the real chain reintroduces the same forgery. Use 0
where nothing proxies the service at all, which leaves `req.ip` the socket address.

One name, two independent values. The two processes never read one environment —
docker-compose.yml gives them `.env` and `.env.oauth` — so a deployment that puts
a different number of proxies in front of each can say so. The OAuth layer standing between the
terminator and the connector costs no hop, incidentally: its proxy forwards
`X-Forwarded-For` unchanged rather than appending to it (`HOP_BY_HOP` in
`oauth/src/proxy.ts`), so 1 is right for the connector whether it is reached
straight through the terminator or through the OAuth layer.

The connector has no throttle for a forged address to defeat, but `req.ip` is what
both of its rejection log lines carry — the rejected `/mcp` request (`src/app.ts`)
and the rejected settings request (`src/settings-assertion.ts`) — and the obvious
use for those is a jail. It trusted the whole chain until #107, and those two
fields were client-forgeable for as long as it did.

Asserted by *"buckets on the address the reverse proxy observed, not one the client
picked"* in `oauth/test/integration/authorization-guards.test.ts`, by *"defaults to
a single hop, not to trusting the whole chain"* / *"rejects a boolean or a negative
value"* in `oauth/test/unit/config.test.ts` and in
`test/unit/config.trust-proxy.test.ts`, and — on a served request, which is the only
place the setting has an effect — by *"logs the address the reverse proxy observed,
not one the client picked"* in `test/unit/app-trust-proxy.test.ts`.

---

## The client address (#15)

Everything in the previous section that says "per client" means it — on a
deployment whose TLS terminator sees the real source address. That is a
**topology requirement**, and it is the one property those controls depend on
that cannot be established from inside this repository. So it is stated here in
full, with the way to check that your deployment holds it.

### What the topology has to be

**The terminator must not sit behind `docker-proxy`.** A TLS terminator that runs
in a container and reaches the internet through Docker's *published ports* never
sees a client at all: `docker-proxy` SNATs the source address to the Docker bridge
gateway before the proxy's listening socket, so `$remote_addr` — and with it
`$proxy_add_x_forwarded_for`, and with it `req.ip` in both services — is a single
`172.x.x.x` address for the entire internet. Nothing in this repository is
misconfigured when that happens; the address is already gone one layer below it,
and no `TRUST_PROXY` value recovers what was never forwarded.

Two arrangements hold the requirement:

- **A terminator on the host.** The nginx recipe in
  [DEPLOYMENT.md](DEPLOYMENT.md): its listening socket is the host's, so
  `$remote_addr` is the client.
- **A containerised terminator on `network_mode: host`** — Nginx Proxy Manager,
  Traefik or Caddy. On host networking it binds 80/443 on the host directly
  rather than through a published port, which removes the same hop.

The reference deployment runs the second: Nginx Proxy Manager, host-networked, in
front of `mail-oauth` on `127.0.0.1:8080`.

### How to tell which one you have

Read the **terminator's own** access log, not the application's. The source
address is the first thing on the line; Nginx Proxy Manager labels it:

```
[Client 2a02:810b:4312:e700:55cb:e26f:9162:277f] … [Sent-to 127.0.0.1]
[Client 172.21.0.1] …                                ← the bridge gateway
```

A `172.x.x.x` or `10.x.x.x` client on a request you made from *outside* the
network is the broken case, every time, however many hops are configured
downstream of it. The application says the same thing a layer later: a failed
sign-in logs `"ip":"172.21.0.1"` rather than an address you recognise.

If that is what you see, move the terminator onto the host network — everything
below assumes you have. Until you do, treat the login throttle and the nginx zone
as one global cap rather than as per-client protection, and leave the ban action
off the jail below: the address in those log lines is the gateway that every
proxied service on the box is reached through, and banning it takes all of them
down.

### What moving Nginx Proxy Manager to host networking cost

Three things, on the reference deployment, and none of them was large. The survey
that came first is why:

- **The upstreams.** 15 of the 16 proxy hosts already forwarded to the host's own
  public IP and a published port, so host networking changed nothing for them.
  Exactly one addressed a container by name — `mail-oauth:8080` — and became
  `127.0.0.1:8080`, which `docker-compose.yml` already publishes. Container names
  stop resolving on host networking, so check every proxy host for one *before*
  the switch, not after.
- **Its database.** NPM reached MariaDB by the compose service name `db`, which is
  a container name like any other. The database container now publishes
  `127.0.0.1:3306:3306`, and NPM's `DB_MYSQL_HOST` is `127.0.0.1`.
- **Its `ports:` block, which had to go.** On host networking there is nothing to
  publish — NPM binds 80, 443 and 81 itself — and leaving the block in place is a
  compose error rather than a no-op.

Nothing in this repository changed with it. `TRUST_PROXY=1` was right before and
is right after: one terminator, one hop, and the OAuth layer standing between it
and the connector costs no hop, because its proxy forwards `X-Forwarded-For`
unchanged rather than appending to it.

### Why not `"userland-proxy": false`

It is the cheaper-looking answer — one line in `/etc/docker/daemon.json`, no proxy
rework — and the next person to read this will think of it too, so here is why the
reference deployment refused it.

With the userland proxy disabled, published ports are DNAT'd by iptables and the
source address does survive **for IPv4**. On that host, `ip6tables -t nat -L
DOCKER` was **empty** while the IPv4 `DOCKER` chain carried a full set of DNAT
rules: IPv6 publishing was being done entirely by `docker-proxy`. Disabling it
would have taken IPv6 down for every published port on the box, and the public
hostname has an AAAA record. Check both families before believing the one-line
fix — the verification request below arrived over IPv6.

Host networking sidesteps the question: a host-networked terminator is not
published at all, so which mechanism publishes ports stops mattering to it.

### What that buys

- **The login throttle buckets per client again.** Five failed attempts from one
  address no longer spend anybody else's budget, and connecting a new Claude
  client is no longer blocked for fifteen minutes by a stranger's typo. The
  settings sign-in still shares its budget with `/authorize` — same credential, on
  purpose — but it shares it per address.
- **The nginx zone keys on a real client.** `$binary_remote_addr` is the client's
  own address, so the edge limit caps a flood per source instead of in aggregate.
- **A fail2ban jail bans the client, and the ban lands where it works.** A
  host-networked terminator's sockets are the host's, so packets traverse the
  host's `INPUT` chain and fail2ban's stock actions apply to them.

Verified on the reference deployment after the change, in both layers, for one
request from outside the network:

```
NPM access log:  [Client 2a02:810b:4312:e700:55cb:e26f:9162:277f] … [Sent-to 127.0.0.1]
OAuth layer:     {…,"msg":"settings login rejected by origin check","ip":"2a02:810b:4312:e700:55cb:e26f:9162:277f"}
```

Older lines in the same OAuth log still read `"ip":"172.21.0.1"`. The before and
the after sit in one file.

### The log line a jail matches

Failed logins emit a single line in a fixed shape — `LOGIN_FAILURE_EVENT` in
`oauth/src/logger.ts`, used at all three sites. The shape is a deployment API: an
operator's jail matches on it, so changing it is a deployment change rather than a
cosmetic one. This repository ships no filter; this is the shape one matches.

JSON, one object per line, `warn` to stderr:

```json
{"ts":"…","level":"warn","service":"claude-mail-mcp-oauth","msg":"login failed","ip":"…","failures":3}
```

`/settings/login` and `/settings/password` add `"endpoint":"settings"` and
`"endpoint":"settings-password"` respectively; the `/authorize` sign-in carries
`failures`. `ip` immediately follows `msg` in all three.

```ini
# /etc/fail2ban/filter.d/claude-mail-oauth.conf
[Definition]
failregex = "msg":"login failed","ip":"<HOST>"
```

```ini
# /etc/fail2ban/jail.d/claude-mail-oauth.local
[claude-mail-oauth]
enabled      = true
filter       = claude-mail-oauth
backend      = systemd
journalmatch = CONTAINER_NAME=mail-oauth
maxretry     = 10
findtime     = 900
bantime      = 3600
```

**What it protects.** The operator password, which is the only human-facing
credential in the deployment: it opens `/settings`, where mailboxes are added and
removed and connected Claude clients are revoked, and it is what the `/authorize`
consent screen asks for. The application already stops at five failures in fifteen
minutes and says so on the page, so `maxretry = 10` deliberately sits above that —
an operator who mistypes, gets locked out and waits it out is not banned, while
somebody still trying after the lockout is. It bans the address in the line, which
on the topology above is a client rather than the gateway; that is the whole
difference this section is about.

**Two things that go wrong in practice.**

- **Docker's default log driver escapes the quotes.** Under `json-file` the line
  reaches `/var/lib/docker/containers/<id>/<id>-json.log` as
  `\"msg\":\"login failed\"`, and the filter above does not match it. Give
  `mail-oauth` the journald driver — a `logging: driver: journald` block in your
  own compose override — and use the `backend = systemd` jail above, or keep the
  file and match the escaped shape instead:
  `failregex = \\?"msg\\?":\\?"login failed\\?",\\?"ip\\?":\\?"<HOST>\\?"`.
- **IPv6.** `<HOST>` has matched IPv6 addresses since fail2ban 0.10, and the stock
  `nftables` and `iptables-multiport` actions ban both families — but the
  reference deployment's clients arrive over IPv6, so confirm it rather than
  assume it. Fail a sign-in deliberately and read
  `fail2ban-client status claude-mail-oauth`. An empty jail after a genuine
  failure is almost always the log source rather than the filter; check
  `journalctl CONTAINER_NAME=mail-oauth | grep 'login failed'` first.

No password, token, authorization code or code verifier is ever a log field, in
any line — rule 1 of `oauth/src/logger.ts`, and the claim token itself is likewise
never logged (only its source and path, asserted by *"is written to the data volume
and reported like every other secret"*).

History: <https://github.com/YannicHock/claude-mail-mcp/issues/15>.

---

## What this deployment does not give you

Deliberate scope decisions. If your threat model demands more, these are yours to
address.

**At-rest encryption of `accounts.json`.** Plain JSON, readable by uid 100. An
attacker with root on the host reads it, and so does anything that compromises the
connector. A key stored on the same host does not protect against a root
compromise; a key entered at process start means an unattended restart leaves the
service down. If you need the latter, put the data volume on a LUKS volume that
requires manual unlock and accept that trade.

**Root on the host.** No control here survives it. All four secrets and every
mailbox credential are recoverable. Same boundary as `/etc/shadow`.

**Multi-tenancy.** One operator credential, one set of mailboxes, one static token
to the connector. The OAuth login is the access-control boundary between humans;
the connector cannot tell them apart at all. If you need distinguishable humans,
run separate instances. Multi-tenancy is not on the roadmap.

**Outbound network controls.** The connector reaches whatever IMAP/SMTP/CalDAV
hosts `accounts.json` names, plus whatever autoconfig discovery resolves to — that
last one is deliberately constrained (HTTPS only including after a redirect,
resolve-then-refuse for loopback, link-local and RFC 1918, at most one redirect
under the same rules, per-attempt and total timeouts, a body cap) but it is still
outbound traffic to a host derived from an address someone typed. If you want an
allowlist, enforce it at the host firewall or with `IPAddressAllow=` under systemd.

**A dedicated audit log.** Both services log structured JSON — authentication
failures, tool invocations, rejected requests, and one `secret resolved` line per
secret at startup. Neither writes a "write op X happened" record. For
compliance-relevant deployments, parse the stream into one.

**Backups.** The state is on the volumes: `data/accounts.json` (every mailbox
credential, recoverable from nowhere else), `secrets/`, and `oauth-data/`. Losing
`oauth-data/` logs every Claude client out and forces re-registration. Back all
three up **with encryption at rest** — `restic`, `borgbackup`, or `tar | gpg`. Not
to an unencrypted bucket.

---

## Threat scenarios

**Brute force against the connector's static token.** 48 random bytes, base64url,
checked on every `/mcp` request. Not practically guessable; the entropy does the
work. The nginx zone bounds a retry loop, not a guesser. Residual risk: negligible,
unless the token leaks — logs, git history, a screenshot. Rotating it means
replacing `secrets/shared/auth_token.txt` and restarting **both** services, since
both read it.

**Brute force against the operator password.** scrypt (`N=2^16`), five failures per
fifteen minutes, an nginx zone on exactly the two POSTs that verify it, and a
minimum length of 12 refused at the wizard rather than after exposure. A wrong
username and a wrong password produce the same response (*"refuses a wrong username
with the same response as a wrong password"*). Those controls are per client only
where the terminator sees the client — the topology requirement in
[The client address](#the-client-address-15), which is a property of your
deployment rather than of this repository, and worth confirming before you rely on
it. Even satisfied, it bounds *each* source at five attempts per fifteen minutes,
so a distributed guesser is not slowed in aggregate: size the password for that,
and put the fail2ban jail from that section on the log lines.

**An attacker who reads the boot logs of an unclaimed instance.** They claim it.
Accepted, stated in the banner, and the reason the wizard exists at all is to
shorten the window in which an instance sits unclaimed. Finish it promptly, and do
not paste the setup URL anywhere.

**A malicious page in the operator's browser (CSRF).** Every state-changing POST is
same-origin-checked; settings forms carry a session-bound CSRF field; every page is
`X-Frame-Options: DENY` with `frame-ancestors 'none'`; the CSP allows no script.
The connector's `/mcp` requires an explicit `Authorization` header a cross-site
form cannot supply.

**Dependency compromise in the connector (`imapflow`, `nodemailer`, `tsdav`).**
Reaches `accounts.json` and `secrets/shared`. Does not reach `secrets/oauth`, so it
cannot mint an access token or attack the password hash offline — see the trust
boundary above. Residual risk: medium, and at-rest encryption is the only real
answer for the mailbox credentials. Versions are pinned in `package-lock.json`;
subscribe to advisories and run `npm audit`.

**MITM between claude.ai and the deployment.** TLS with a valid certificate, HSTS,
no HTTP fallback. Residual risk: very low.

**A compromised MCP client.** It holds an access token and can call every tool that
token's scope allows, against every configured mailbox. Revoke it from
`/settings/clients`; the access token dies with the session on the next request,
not an hour later. This is the boundary the revocation work in #2 exists for.

---

## Reporting issues

[SECURITY.md](../SECURITY.md) carries the private disclosure process, and what is
in scope for a report and what is not.
