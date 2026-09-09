# Settings web UI for claude-mail-mcp — design

Status: sections 0–4 approved 2026-09-08; sections 5–11 pending review.

Companion to `2026-09-08-oauth-layer-design.md`, which built the service this one
extends. That document ends with "The connector is not modified." This one modifies
both, and §1 is the justification.

## 0. Problem

`accounts.json` holds plaintext credentials for real mailboxes and is written by
hand over SSH. Nothing in the repository writes it: the connector mounts `./data`
read-only and the OAuth layer cannot see it at all. On the production host the file
is empty — no mailbox is configured, and the connector is therefore unusable without
a shell on the server.

Three code paths already promise a UI that does not exist:

| Location | Text |
| --- | --- |
| `src/accounts.ts:96` | "Open the setup page at the connector's /settings URL to add one." |
| `src/tools-mail.ts:56` | "Open the connector's /settings page to add one." |
| `src/tools-calendar.ts:44` | "Add a CalDAV URL in the connector's /settings page." |

These strings reach the model when a tool fails, so today they actively send the
user to a 404. `docker-compose.yml:28` makes the same claim about the OAuth layer.

## 1. Decision — where the UI lives

Scope, as agreed with the owner: mailbox management, a connection test before
saving, connected-client review and revocation, and operator status plus password
change. That scope spans **both** data domains — `accounts.json` under uid 100 and
`oauth-state.json` under uid 102 — which is what settles the placement question.

### 1.1 Two findings that constrain it

1. **`oauth/src/store.ts` reads its file once at startup** and thereafter writes its
   in-memory state out. There is no `fs.watch` and no re-read. A foreign process that
   revoked a client by editing `oauth-state.json` would be silently overwritten by
   the next `save()`. Revocation must therefore happen inside the OAuth layer.
2. **`AUTH_PASSWORD_HASH_FILE` points into `/run/secrets`**, which Docker mounts
   read-only. A password change cannot write there; the live hash has to move to the
   writable `oauth-data` volume, seeded once from the secret.

### 1.2 The criterion

Not "which service is more convenient", but **how many long-lived, network-facing
processes can read plaintext mailbox passwords**. Today: exactly one, the connector.

| | A: split by ownership | B: all in the OAuth layer | C: third service |
| --- | --- | --- | --- |
| Processes with plaintext access | 1 | 2 | 2 |
| Dependencies in the internet-facing service | 2 | ~5 (+ the imapflow tree) | 2 |
| Outbound to arbitrary hosts | connector | OAuth layer | third service |
| uid separation | preserved | lost | circumvented |
| New images / pipelines / proxy hosts | 0 | 0 | 3 |
| Revocation possible correctly | yes | yes | only via an API on the OAuth layer |

**A is chosen.** C is worse than it looks: because the scope spans both domains, the
third service would need write access to both files, making it more privileged than
either existing service — and finding 1 means it still could not perform revocation
itself.

A's honest costs: it touches `oauth/src/`, and it needs a signing mechanism between
the services. The difference from B on plaintext is one of degree, not of kind — form
submissions pass through the OAuth layer as unparsed bytes, exactly as MCP payloads
do today, but they do pass through it.

## 2. Architecture

```
browser ──https──> nginx ──> mail-oauth :8080 ──┬─ /settings           rendered here
                                                ├─ /settings/clients   rendered here
                                                ├─ /settings/password  rendered here
                                                └─ /settings/mailboxes ──> mail-mcp :3220
                                                   (Cookie stripped, static AUTH_TOKEN
                                                    substituted, assertion added)
```

Public surface is unchanged: only `mail-oauth` is reachable from the proxy network,
and it gains no new dependency. The connector gains routes but stays unreachable
from outside `mail-mcp_internal`.

Division of labour follows data ownership strictly:

| Concern | Owner | Why |
| --- | --- | --- |
| Operator session, CSRF | OAuth layer | it already authenticates the human |
| Connected clients, revocation | OAuth layer | its own store; finding 1 |
| Operator password | OAuth layer | it holds the hash |
| Mailbox CRUD | connector | it owns `accounts.json` |
| Connection test | connector | it already has imapflow/nodemailer/tsdav |
| Connector status | OAuth layer renders, reads the connector's `/health` | `/health` returns `publicSummaries()` — no credentials |

## 3. Session and CSRF

### 3.1 Sign-in

`GET /settings` without a valid session renders a sign-in form — its own page, but
the same credentials, the same render helpers and **the same `LoginThrottle`
instance** as the OAuth consent screen. Shared deliberately: both guard the same
secret, and two budgets would mean ten attempts instead of five. `LOGIN_FAILURE_EVENT`
keeps being emitted so the fail2ban filter covers both paths.

Accepted consequence: five failures on `/settings` also lock `/authorize` for
fifteen minutes, so a new Claude client cannot be connected during that window.

### 3.2 Cookie

`__Host-mailmcp_session`, an HS256 JWT with `aud: "settings-session"` and claims
`sub`, `sid`, `csrf`, `epoch`, `exp`.

- The `__Host-` prefix makes the browser enforce `Secure`, no `Domain` and `Path=/`.
  In front of plaintext passwords the strongest origin binding is worth its cost.
- `Path=/` follows from the prefix, so the cookie is also sent to `/mcp`, `/token`
  and `/authorize`, which ignore it. **`proxy.ts` must strip `Cookie` before
  forwarding upstream** — today `forwardableRequestHeaders` drops only hop-by-hop
  headers and `authorization`, so the connector would see the session cookie. It
  must never see it: the connector authenticates settings requests by assertion
  alone, and forwarding browser state upstream is how that invariant erodes.
- `HttpOnly`, `SameSite=Lax`. Lax rather than Strict: Lax already withholds the
  cookie on the cross-site POSTs that matter, and Strict would additionally break a
  plain link to `/settings` while adding nothing the CSRF token does not cover.
- 60 minutes absolute, re-issued on every authenticated GET — a 60-minute idle
  timeout with no server-side session state.
- **Revocation.** A stateless cookie cannot be withdrawn before it expires, so the
  store gains an integer `sessionEpoch`. Sign-out, "sign out everywhere" and a
  password change increment it; a cookie carrying a stale epoch is rejected. One
  integer, and it is what makes the password change mean anything.
- **Fixation.** No cookie is ever set before authentication succeeds; success mints
  a fresh `sid` and `csrf`.

### 3.3 CSRF

Every state-changing form carries `_csrf` from the session's `csrf` claim, compared
with the existing `constantTimeEquals`, alongside the existing `isSameOrigin` check.
Both, not either.

The connector can verify CSRF without ever seeing the cookie, because the assertion
described next carries the same `csrf` value.

## 4. The cross-service assertion

Header `X-Settings-Assertion`. **Not a JWT**: `<payload>.<mac>`, where `payload` is
base64url-encoded JSON `{v, iss, aud, sub, sid, csrf, htm, htu, exp}` and `mac` is
`HMAC-SHA256(key, payload)` over that exact string. Lifetime 30 seconds; `htm` and
`htu` carry the request's method and path so a GET assertion cannot be replayed as a
POST.

A JWT would have meant either adding `jose` to the connector — which today depends on
the MCP SDK, express, ical.js, imapflow, mailparser, nodemailer, tsdav and zod, and on
no crypto library — or hand-writing JWT verification, which is where algorithm-confusion
bugs live. An HMAC over the literal transmitted string has no algorithm field to
confuse, no canonicalisation ambiguity, and needs only `node:crypto`. Verification
recomputes the MAC over the received `payload` string, compares with `timingSafeEqual`,
and only then parses the JSON.

Neither package gains a runtime dependency anywhere in this design.

**Its own key**, not the OAuth signing key: a new Docker secret
`settings_signing_key` mounted into both containers. If the connector held the OAuth
signing key, a compromised connector could mint access tokens for `/mcp`. Separate
keys keep a compromise on either side from escalating into the other's credential.

Without the secret the connector refuses `/settings/*` outright — the UI is opt-in,
and a connector without the key behaves exactly as it does today. The static
`AUTH_TOKEN` bearer remains required on `/settings/*` as well; both must hold.

## 5. Endpoints

### 5.1 OAuth layer

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/settings` | Overview: connector reachability, mailbox count, client count. Sign-in form when unauthenticated. |
| POST | `/settings/login` | Verify credentials, mint the cookie, 303 to `/settings`. |
| POST | `/settings/logout` | Clear the cookie. `all=1` also increments `sessionEpoch`. |
| GET | `/settings/clients` | Registered clients and live refresh sessions. |
| POST | `/settings/clients/revoke` | `client_id`, `sid`, or `all`. |
| GET, POST | `/settings/password` | Change the operator password. |
| * | `/settings/mailboxes*` | Proxied to the connector. |

### 5.2 Connector

All under `/settings/mailboxes`, behind `requireSettingsAssertion` and the existing
bearer check.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/settings/mailboxes` | List, with edit / delete / make-default actions. |
| GET | `/settings/mailboxes/new` | Empty form. |
| GET | `/settings/mailboxes/:id` | Edit form; password fields blank. |
| POST | `/settings/mailboxes` | Create. |
| POST | `/settings/mailboxes/test` | Probe the new-account form. Never writes. |
| POST | `/settings/mailboxes/:id` | Update. |
| POST | `/settings/mailboxes/:id/test` | Probe an existing account's form, so its stored password can be reused. Never writes. |
| POST | `/settings/mailboxes/:id/delete` | Delete. |
| POST | `/settings/mailboxes/:id/default` | Make default. |

No JavaScript and no build step. Server-rendered HTML with inline CSS as today; the
sign-in page's CSP — `default-src 'none'; style-src 'unsafe-inline'; form-action
'self'; frame-ancestors 'none'` — applies unchanged to every settings page.

## 6. Editing mailboxes

### 6.1 Passwords in forms

Password inputs always render `value=""` with `placeholder="unchanged"` and
`autocomplete="new-password"`. On save, an empty field keeps the stored value and a
non-empty field replaces it; on create, empty is a validation error. That rule is
what makes "no stored password ever reaches the HTML" mechanically true rather than
a matter of care, and §11 tests it directly.

Removing the optional CalDAV block is an explicit `remove_caldav` checkbox, not an
emptied URL — clearing a field must never be the gesture that deletes a section.

### 6.2 Writing `accounts.json`

Mutations become methods on `AccountsStore` (`create`, `update`, `remove`,
`setDefault`) so serialisation lives next to the parser that has to accept it. Each:

1. Re-reads and parses the file from disk, so a change made by hand since the form
   was rendered is not silently discarded.
2. Applies the mutation to the parsed model.
3. Serialises, then **re-parses the serialised text with `parseAccountsFile`**. Only
   then does it proceed. The connector can therefore never write a file it would
   refuse to read.
4. Writes to `.<uuid>.tmp` in the same directory with mode `0600`, `fsync`s, and
   renames into place. Same recipe as `oauth/src/store.ts`; the `fsync` matters more
   here, because losing mailbox credentials is worse than losing client registrations.
5. Updates the in-memory store immediately rather than waiting for `fs.watch`.

Writes are serialised through a promise chain so two submissions cannot interleave.

Interaction with the existing watcher: it filters on the basename, so the temp file
raises nothing; the rename does fire on Linux and triggers a redundant, harmless
`reload()`. Because step 5 does not depend on the watcher, the feature also works on
Docker Desktop for Windows and macOS, where `fs.watch` on a bind mount never fires
(see commit `2596798`).

**Optimistic concurrency.** The form carries the file's size and mtime as a hidden
field. On save the writer compares them against the file on disk and, on a mismatch,
re-renders with "the file changed on disk — review and resubmit" instead of
clobbering the other edit.

**Accepted loss.** The writer serialises from the parsed model, so keys the schema
does not define are dropped the first time the UI writes. The file has no documented
extra keys; the UI states that editing here rewrites the file.

## 7. Connection test

Runs against the submitted form values, merged with stored passwords wherever a
field was left blank, so an existing account can be tested without retyping its
password. Three independent probes: IMAP connect/login/logout, SMTP connect/auth/quit,
and CalDAV principal discovery when a URL is present.

A new `src/probe.ts` builds one-shot clients and tears them down. It must not touch
`ClientPool`, which exists for configured accounts and would otherwise cache
credentials that were never saved.

Bounded: 10 seconds per probe, 25 seconds for the whole test — comfortably inside the
proxy's 120-second upstream timeout, so a black-holed mail host cannot tie up a
request. Results render above the form, per service, with the provider's message
truncated and HTML-escaped. Nothing is persisted.

## 8. Connected clients and revocation

`/settings/clients` lists registered clients (id, self-asserted name, issue time,
redirect hosts) and live refresh sessions (sid, client, scope, expiry).

Revoking a session deletes it; revoking a client deletes the record and every session
referencing it; revoke-all clears both.

**Access tokens are stateless JWTs with a one-hour lifetime**, so deleting a session
stops refresh but leaves an issued access token usable until it expires. A revoke
button that does not revoke for an hour is a lie, so `tokens.ts` gains an epoch check:
a global `tokenEpoch` in `StoreData`, carried as an `epoch` claim at issuance and
compared at verification, incremented by revoke-all; and a per-client `revokedAt`,
against which a token's `iat` is compared. A token minted before the field existed
carries no `epoch` and is read as 0, which matches the initial `tokenEpoch`, so the
upgrade invalidates nothing on its own. Cost: two store fields and two comparisons in
the verify path.

## 9. Operator password

The live hash moves to `oauth-data/operator.json` — `{version, username, passwordHash,
sessionEpoch}` — seeded on first start from `AUTH_PASSWORD_HASH(_FILE)`. The Docker
secret becomes the initial value, not the live one.

`sessionEpoch` lives here because it is about the operator's browser sessions;
`tokenEpoch` from §8 lives in `oauth-state.json` instead, because it is about issued
tokens and `TokenIssuer` already holds that store. Same principle as §2: state sits
with whoever owns it.

To keep that from surprising anyone, the service logs at startup which source is live,
and warns by name when the secret file differs from the stored hash. `OPERATOR_FILE=none`
keeps today's behaviour: hash from the secret only, password change disabled.

Changing it takes the current password, the new one and a confirmation; verification
goes through the existing `verifyPassword` and the existing throttle, hashing uses the
existing scrypt parameters, the write is atomic, and `sessionEpoch` increments so every
session — including the current one — has to sign in again. `tokenEpoch` is not
incremented: changing the operator password should not disconnect Claude. A checkbox,
default off, does that too for the case where the password is believed leaked.

## 10. Deployment

| Change | Detail |
| --- | --- |
| `mail-mcp` volume | `./data:/data`, dropping `:ro` |
| `mail-mcp` secret | `settings_signing_key`, as `SETTINGS_SIGNING_KEY_FILE` |
| `mail-oauth` secret | the same one |
| New secret file | `secrets/settings_signing_key.txt`, `openssl rand -base64 48`; already covered by the `secrets/` entry in `.gitignore` |
| Host permissions | `chown 100:101 data` **as well as** `data/accounts.json`. Atomic rename creates a temp file in the directory, so the directory itself must be writable by uid 100. Missing this is an `EACCES` on first save, not at startup. |
| `docker-compose.yml:28` | The comment claiming the OAuth layer will grow a `/settings` UI is corrected to describe what is actually built. |
| nginx | No new proxy host: `/settings` is the same origin, already routed to `mail-oauth:8080`. Rate limiting applies the `mcp_mail_login` zone to `POST /settings/login` and `POST /settings/password` **only** — never to the whole prefix. Editing several mailboxes is a burst of ordinary requests, and this project has already shipped one outage caused by a login-grade limit on a non-login path. |
| Buffering | Settings pages do not stream; the default applies. `proxy_buffering off` stays scoped to `/mcp`. |

`.env.example`, `.env.docker.example` and `oauth/.env.example` gain the new variables.
The prose in `docs/DEPLOYMENT.md` and `docs/HARDENING.md` is the owner's deferred pass
and is not written here.

## 11. Testing

The floor is set by the existing suites: 25 unit and 14 integration for the connector,
201 and 57 for the OAuth layer.

**OAuth layer, unit.** Session signing and verification; rejection on stale epoch,
wrong audience and expiry; cookie attributes; CSRF comparison; assertion minting
(claims, lifetime, method/path binding); the operator store (seeding from the secret,
atomic write, epoch increments); revocation bookkeeping; `tokenEpoch` and per-client
`revoked_at` in the verify path.

**OAuth layer, integration.** Unauthenticated `/settings` returns the sign-in form and
no data; a wrong password is throttled; a successful sign-in sets `__Host-` with the
expected attributes; a POST without `_csrf` is rejected; a cross-origin POST is
rejected; a cookie minted before a password change is rejected after it; revoking a
session makes its refresh token fail and its access token fail immediately; **the
session cookie does not reach the upstream**, asserted against a stub.

**Connector, unit.** Writer round-trip validation; a failure before `rename` leaves the
previous file intact; temp-file mode; unknown id handling; the blank-means-unchanged
merge rule; optimistic-concurrency mismatch.

**Connector, integration.** `/settings/*` without an assertion, with one signed by the
wrong key, with an expired one, and with one bound to a different method or path — each
rejected; **the rendered edit page contains no stored password**; create, update, delete
and make-default round-trip through the real Express app against a temporary accounts
file; the connection test succeeds against the GreenMail fixture and fails within its
bound against a closed port.

CI needs no new job: `_test.yml` already runs one per package.

## 12. Out of scope

- Rebuilding the OAuth layer. Three pieces of existing behaviour change, each argued
  where it appears: the cookie filter in `proxy.ts` (§3.2), the token epoch in
  `tokens.ts` (§8), and the operator hash moving out of `/run/secrets` in `config.ts`
  (§9, forced by finding 1.1.2). `store.ts`, `app.ts` and `login.ts` gain fields,
  routes and render helpers, but nothing they already do changes.
- The Cowork connection test, deferred until this UI exists.
- The `docs/DEPLOYMENT.md` and `docs/HARDENING.md` rewrite for the OAuth layer.
- Multi-operator or multi-tenant access. One operator, one credential.
