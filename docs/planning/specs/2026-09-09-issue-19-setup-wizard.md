# Setup wizard and first-run bootstrap — design

Status: drafted 2026-09-09, pending owner review.

Covers the v0.7 milestone's centrepiece: turning a fresh `docker compose up` into a
working, claimed instance without a shell, a hash tool, or a hand-written
`accounts.json`. Companion to `2026-09-08-oauth-layer-design.md` and
`2026-09-08-settings-ui-design.md`, both of which this extends.

Issues: #17 (secrets), #18 (claim token), #19 (wizard) with sub-issues #22, #23, #24.

## 0. Problem

Starting this stack today requires, before the first `docker compose up`:

```
secrets/auth_token.txt            32 random bytes
secrets/oauth_signing_key.txt     32 random bytes
secrets/settings_signing_key.txt  32 random bytes
secrets/auth_password_hash.txt    an scrypt hash, produced by no shipped tool
```

Three of those are random values with no meaning outside the deployment. The fourth
needs `hashPassword` from `oauth/src/passwords.ts`, reachable only by writing a Node
script by hand — `scripts/` contains `check-versions.sh` and nothing else. All four
then need a file mode both container uids can read; `600` is the intuitive choice for
a secret and crash-loops both services.

Only after that does the operator discover the settings UI, which since 0.6.0 can do
everything the manual path did. The README still says
`no setup UI ships with this repo yet` (#20).

## 1. Scope

**In:** self-generating secrets, an unbootstrapped state, a claim token, a
three-screen wizard ending with a working `/mcp` and one verified mailbox.

**Out:** TLS provisioning and reverse-proxy configuration — the operator brings a
reachable server, a domain and a working TLS proxy, as agreed. Multi-tenancy. Any
change to how releases or images are built.

## 2. State machine

The stack is **unbootstrapped** when no operator record exists. Not "when the secrets
are missing" — secrets generate themselves (§4), so their absence says nothing.

| | unbootstrapped | claimed |
| --- | --- | --- |
| `/health` | 200 | 200 |
| `/setup/<token>` | the wizard | **404** |
| `/setup/*` (wrong token) | **404** | **404** |
| `/mcp` | **503** | normal |
| `/settings/*` | not mounted | normal |
| everything else | 404 | normal |

`/mcp` returning 503 rather than 401 is deliberate: an unclaimed instance has no
credentials to check against, and a 401 would invite credential guessing against a
service that cannot yet reject anything meaningfully.

The transition is one-way. There is no route back into the wizard; starting over
means deleting the data volume. The completion screen says so, rather than leaving it
to be discovered.

## 3. The claim token

Generated on first boot: 32 random bytes, base64url, persisted to the data volume.
**Not regenerated on restart** while still unbootstrapped — a container that restarts
while the operator is on step 2 must not invalidate the open tab.

Printed to stdout as a complete URL assembled from `PUBLIC_URL`, so the operator
copies a link rather than building one:

```
────────────────────────────────────────────────────────────
  Setup required.  Open this once to configure the instance:

    https://mail.example.com/setup/8Kd2n…qR

  Anyone with this link can claim this instance. It stops
  working as soon as setup completes.
────────────────────────────────────────────────────────────
```

Compared in constant time. A wrong or absent token yields 404, never 401 — scanning
must not distinguish an unclaimed instance from a claimed one.

Consumed on completion: the token file is deleted in the same operation that writes
the operator record, and the ordering matters — write the record first, then delete
the token, so a crash between the two leaves a claimable instance rather than a
permanently unreachable one.

### 3.1 What this does and does not defend

It reduces takeover to *an attacker who can read the container logs*, who has already
won by other means. It does **not** defend against an operator who pastes the setup
URL into a chat before using it. The log banner says so in one line rather than
pretending the token is not a bearer credential.

## 4. Secrets: a present file wins, an absent one is generated

On boot, for each of `auth_token`, `oauth_signing_key` and `settings_signing_key`:
read the configured path if the file exists; otherwise generate and write it with a
mode both runtime uids can read. Log which of the two happened, per secret.

`auth_password_hash` is not generated. It is set in wizard step 1, which the
`OperatorRecord` is already built for — `AUTH_PASSWORD_HASH` seeds the record once and
the record wins from then on. `OPERATOR_FILE=none` keeps its current meaning.

**Precedence is not cosmetic.** Existing deployments mount all four as read-only
Docker file-secrets. If generation ever took priority, or an existence check misfired,
a running instance would come back up with a new `AUTH_TOKEN` and every connected
Claude client would break at once. The rule is what makes this change safe to ship to
an instance that is already running.

That leaves `PUBLIC_URL` as the only value an operator must supply by hand, because
the container cannot discover its own external address.

## 5. The wizard

Three screens. Progress is stored server-side against the token, so a reload or a
container restart resumes where it left off.

### 5.1 Chrome

Every screen carries the same header, matching the existing settings pages:

```
┌──────────────────────────────────────────────┐
│  Set up claude-mail-mcp                      │
│  Step 2 of 3 · Add your first mailbox        │
│                                              │
│  [ screen body ]                             │
│                                              │
│  ← Back                       [ Continue ]   │
└──────────────────────────────────────────────┘
```

`Step N of 3` as plain text, not a graphical stepper — the existing design language
has no such component and does not need one. Back is available on steps 2 and 3 and
preserves what was entered. Step 1 has no back.

### 5.2 Step 1 — Operator credentials

```
  Set up claude-mail-mcp
  Step 1 of 3 · Create the operator account

  This is the account you will sign in with to manage
  mailboxes later. It is not a mailbox login.

  Username         [ ____________________ ]
  Password         [ ____________________ ]
  Repeat password  [ ____________________ ]

                                  [ Continue ]
```

Hashed with the existing `hashPassword` (`scrypt`, `N=2^16`, `node:crypto` — no new
dependency) and written to the operator record.

Rejected, with the message next to the field: a password shorter than 12 characters,
a password equal to the username, a mismatch between the two password fields.
Rejecting here costs a retype; rejecting later costs an exposed instance.

The subtitle exists because "username and password" on a mail tool reads as *mailbox
credentials* to a first-time operator. Saying what it is not is worth the line.

### 5.3 Step 2 — First mailbox

The existing mailbox form has roughly eighteen fields, including `Drafts folder`.
Presenting that as the second thing a new operator sees would reproduce exactly the
friction this milestone exists to remove. So step 2 is a **cascade**: each tier is
tried before the more laborious one is shown.

#### Tier 1 — Autoconfig from the address

```
  Step 2 of 3 · Add your first mailbox

  Email address   [ anna@example.com____ ]
  Password        [ ____________________ ]

  [ Skip for now ]                [ Continue ]
```

On Continue, the domain is looked up in this order, first hit wins:

1. `https://autoconfig.<domain>/mail/config-v1.1.xml?emailaddress=<addr>`
2. `https://<domain>/.well-known/autoconfig/mail/config-v1.1.xml`
3. Mozilla ISPDB: `https://autoconfig.thunderbird.net/v1.1/<domain>`
4. DNS SRV `_imaps._tcp.<domain>` and `_submission._tcp.<domain>` (RFC 6186)

CalDAV is discovered separately via `.well-known/caldav` on the domain and DNS SRV
`_caldavs._tcp`; failing to find it is normal and not an error — CalDAV is optional.

On a hit, the derived settings are shown for confirmation rather than applied
silently, because a wrong autoconfig answer that fails later is far harder to diagnose
than one the operator saw:

```
  Found settings for example.com

    IMAP    imap.example.com:993     TLS
    SMTP    smtp.example.com:465     TLS
    CalDAV  not found — you can add it later

  [ Edit these ]                  [ Continue ]
```

#### Tier 2 — Provider list

Shown when the lookup finds nothing, and reachable at any time via a
`Choose provider manually` link:

```
  We could not detect settings for example.com.

  Provider  [ Select… ▾ ]
            Mailbox.org · Fastmail · iCloud · Migadu
            Posteo · Hetzner · Mailcow · iRedMail
            Nextcloud · Other (enter manually)

  Email     [ ____________________ ]
  Password  [ ____________________ ]
```

The table lives in code, not over the network: deterministic, testable offline, and it
cannot fail mid-setup. Hetzner is included deliberately — it is where this project is
deployed and a likely provider for someone who found it here.

**Every entry in this table must be verified against the provider's current
documentation before shipping.** A wrong preset is worse than no preset: it produces
an authentication failure that looks like a wrong password. Any values carried over
from a draft are unverified until someone checks them.

Self-hosted stacks (Mailcow, iRedMail, Nextcloud) have no fixed hostnames; selecting
them pre-fills the *shape* — ports, TLS mode, the usual `mail.<domain>` pattern — and
leaves the hosts to be typed.

#### Tier 3 — The full form

`Other (enter manually)`, `Edit these`, and the manual link all lead to the existing
eighteen-field form, rendered in the wizard chrome. No second implementation: the same
`settings-pages.ts` helpers, the same field names, the same validation.

#### Verification, and what a partial failure means

Whatever tier produced the values, they are probed before saving, using the existing
`probe.ts`, and the result is rendered with the existing `.probe-row` component:

```
  IMAP    imap.example.com:993       ok
  SMTP    smtp.example.com:465       ok
  CalDAV  dav.example.com            failed: 404 Not Found

  CalDAV did not answer. You can still continue — calendar
  tools will not work until it is configured.

  [ Back ]      [ Test again ]      [ Continue anyway ]
```

- **IMAP or SMTP fails** — saving is blocked. A mailbox that cannot read or send is
  not a mailbox, and letting it through only moves the failure somewhere less legible.
- **CalDAV fails** — a warning, and Continue is allowed. CalDAV is optional in the
  account model, and treating it as fatal would lock out every IMAP-only provider.

This depends on #3: the probe must distinguish *wrong credentials* from *host
unreachable*, or the message above is a guess. #3 is in the same milestone for that
reason.

#### Skipping

`Skip for now` goes to step 3 with no account configured. Someone evaluating the thing
should not need mail credentials to hand. The completion screen then says plainly that
no mailbox is configured and links to where to add one.

### 5.4 Step 3 — Connect Claude

```
  Step 3 of 3 · Connect Claude

  Add this URL as a custom connector in claude.ai:

    https://mail.example.com/mcp            [ Copy ]

  Is that the address you reach this instance at?
  It is taken from PUBLIC_URL. If it is wrong, Claude
  will fail to sign in with an error you will see there,
  not here.

  ( ) Yes, that is correct
  ( ) No — how do I fix it?

  ← Back                              [ Finish ]
```

`PUBLIC_URL` is confirmed rather than merely displayed because it is the one value the
container cannot verify for itself, and getting it wrong breaks the OAuth redirect in
a way that surfaces at claude.ai. Choosing *No* does not offer to edit it — it is an
environment variable and cannot be changed from the browser. It shows what to change
and that a restart is needed, and leaves the wizard resumable.

### 5.5 Completion

In order: write the operator record if not already written, delete the claim token,
mount `/mcp` and the settings UI, redirect to `/settings`.

The operator lands on the settings page with their mailbox already in the list.

## 6. UI conventions this must follow

Not a new design. `src/settings-pages.ts` already defines the language, and the wizard
uses it unchanged:

- The `page()` shell, `main { width: min(40rem, …) }`, `system-ui`
- System colours — `Canvas`, `CanvasText`, `AccentColor`, `AccentColorText`,
  `LinkText` with `color-mix` — which is why the UI already adapts to light and dark
  without a theme switch. Do not introduce fixed hex colours.
- `textField`, `passwordField`, `checkboxField`, `probeRowHtml` as they stand
- `.error`, `.notice`, `.field-error` for messages; `.probe-row.ok` / `.fail`
- The `_action` submit-button pattern for screens with more than one action
- Primary action is `AccentColor`; secondary is outlined
- `<meta name="robots" content="noindex, nofollow">` — already in `page()`

No client-side framework and no build step. Server-rendered forms, as everywhere else
in this project.

## 7. Security constraints

**The autoconfig lookup fetches a URL derived from user input.** That is a server-side
request whose host the operator controls, so it is constrained:

- HTTPS only; no plain HTTP, including after a redirect
- Refuse to connect to loopback, link-local, or RFC 1918 addresses — resolve first and
  check, so a hostile `autoconfig.<domain>` cannot be pointed at internal services
- At most one redirect, re-checked against the same rules
- A hard timeout (3 s per attempt, 10 s for the cascade) and a response size cap
- The whole cascade is best-effort: any failure falls through to tier 2, and no
  autoconfig failure is ever shown as an error

**Before the claim**, the surface is `/health` and `/setup/<token>`, nothing else. No
MCP endpoint, no settings UI.

**Step 1 rejects weak passwords** rather than warning, because the instance becomes
internet-reachable the moment setup completes.

**Nothing entered in the wizard is logged.** The probe already handles credentials
carefully; the wizard must not undo that by logging a form body on error.

## 8. Testing

The suites are the reason to be careful here rather than after.

**#14 is a prerequisite, not a companion.** Every wizard screen is a same-origin form
POST — the exact shape that broke in 0.6.0, when `Referrer-Policy: no-referrer` left
`isSameOrigin()` with neither `Origin` nor `Referer`, because Chrome sends no `Origin`
on a same-origin form POST. 251 unit and 81 integration tests missed it because every
one of them set `Origin` explicitly. At least one test per wizard step must send what
a browser actually sends, and no more.

Beyond that:

- Unit: token generation, persistence across restart, constant-time comparison,
  one-way consumption, the state machine's route table
- Unit: secret precedence — all present, all absent, and each mixed case
- Unit: the autoconfig cascade against fixtures, including every rejection in §7
- Integration, against GreenMail: the full three-step flow; the skip path; an IMAP
  failure blocking the save; a CalDAV failure permitting it
- Integration: `/mcp` is 503 before completion and answers after

## 9. Issue map

| Issue | Covers |
| --- | --- |
| #17 | §4 |
| #18 | §2, §3 |
| #22 | §5.1, §5.2 |
| #23 | §5.3 |
| #24 | §5.4, §5.5 |
| #3 | the probe distinction §5.3 depends on |
| #14 | the test constraint in §8 |
| #25, #26 | documenting all of it |

Tier 1 of §5.3 (autoconfig) has no issue yet — it emerged from this design. It needs
one, and the §7 constraints belong in its acceptance criteria.
