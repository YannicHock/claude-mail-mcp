# Security Policy

## What this is

`claude-mail-mcp` is a self-hosted MCP server that gives an AI client IMAP, SMTP
and CalDAV access to mailboxes you configure and run yourself. It ships as **two**
services, both maintained here: `mail-mcp`, the connector, which parses
attacker-supplied MIME off the public internet and holds every mailbox credential
in `accounts.json`; and `mail-oauth`, an OAuth 2.1 layer, which holds the operator
credential and the token signing key, issues and revokes the tokens that gate the
connector, and serves the setup wizard, the consent screen and the settings UI to a
browser.

The two are separate images — `ghcr.io/yannichock/claude-mail-mcp` and
`ghcr.io/yannichock/claude-mail-mcp-oauth`, built from `Dockerfile` and
`oauth/Dockerfile` — deployed together by `docker-compose.yml`, running as
different non-root users with a secrets directory split between them.
`mail-oauth` is needed only by clients that cannot send a custom `Authorization`
header and require OAuth 2.1 discovery instead (claude.ai web, Cowork); Claude
Desktop talks to the connector directly with a static Bearer token. **Where it is
deployed it is part of the attack surface**, and reports about it belong here.

## Supported versions

Releases are cut by pushing a `v*` tag. One workflow run
(`.github/workflows/release.yml`) builds and publishes **both** images from that
one commit, tagged in lockstep as the version, `latest` and `sha-<short>` — after
`scripts/check-versions.sh` has confirmed that all eight version strings in the
tree agree with the tag and that `CHANGELOG.md` has a section to make the release
notes from. The two services do not carry separate versions, and a skew between
them is not a supported configuration.

There are no maintenance branches. A fix lands on `main` and ships as the next tag.

| Version | Supported |
|---------|-----------|
| The newest `v*` tag (the `0.6.x` line today) | yes — fixes ship as the next tag |
| Any earlier tag | no — upgrade; see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) → "Upgrading" and [CHANGELOG.md](CHANGELOG.md) |
| `main` between tags | best effort. `ci.yml` publishes `sha-<short>` images from it; those are not releases |

Run both images at the same version. `docker-compose.yml` pins both to `latest`,
which the release workflow moves onto the newest tag.

## Reporting a vulnerability

**Please do not open a public GitHub issue for a security problem.**

Open a private advisory:
<https://github.com/YannicHock/claude-mail-mcp/security/advisories/new>

This repository is a fork of
[maxx3250/claude-mail-mcp](https://github.com/maxx3250/claude-mail-mcp) and is
maintained separately. The OAuth layer (`oauth/`), both container images,
`docker-compose.yml`, the reverse-proxy recipe and the CI workflows were written
here and exist **only here**, so a report about any of them has to come to this
repository — the upstream maintainer cannot act on code that is not in their tree.

If the issue is in connector code inherited from upstream and therefore affects
that project too, please also report it there, via
<https://github.com/maxx3250/claude-mail-mcp/security/advisories/new> or
**security@markusstoeger.com**.

### What to include

- What the issue is, and what it lets an attacker do
- Which part: the connector, the OAuth layer, `docker-compose.yml`, or the
  reverse-proxy recipe in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)
- Steps to reproduce, or a proof of concept
- The version or commit you tested — both services report theirs at `/health`
- Whether it is already public anywhere

### What to expect

- **Acknowledgement** within 48 hours
- **Initial assessment** within 7 days
- **A fix or a status update** within 14 days

A valid report is fixed on `main` and published as a new tag, with a GitHub
Security Advisory and a CVE where applicable. Reporters are credited unless they
ask not to be.

## Scope

### In scope

Everything this repository ships — which is both services, and the deployment that
puts them together.

- **The connector** (`src/`, `Dockerfile`): parsing of attacker-supplied MIME and
  calendar data, the MCP tools, the static Bearer check on `/mcp`, the HMAC
  assertion required on `/settings/*`, autoconfig discovery, and the writing of
  `accounts.json`.
- **The OAuth layer** (`oauth/`, `oauth/Dockerfile`): the OAuth 2.1 flow, dynamic
  client registration, token issuance, verification and revocation, the operator
  login and its throttle, the same-origin and CSRF checks on every state-changing
  POST, the browser-page header set, the setup wizard and its claim token, and the
  proxy to the connector.
- **The boundary between the two.** The connector mounts `secrets/shared/` and
  nothing else; the token signing key and the operator's password hash live in
  `secrets/oauth/`, which is mounted into the OAuth layer alone. Anything that lets
  a compromised connector reach those, or that leaks the connector's static token
  outward to a client, or the browser's session cookie inward, is a finding.
- **The bootstrap gate.** An instance nobody has claimed yet is gated by a one-time
  claim token. Anything that gets past that gate without the token, that
  distinguishes a wrong token from a claimed instance, or that lets a data volume
  which has already served traffic but lost its credential present itself as a
  fresh instance, is a finding.
- **Revocation.** Revoking a session or a client stops its access token on the next
  request, not at expiry. A token that outlives its revocation is a finding — with
  one documented exception, below.
- **`docker-compose.yml` and the reverse-proxy recipe in
  [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).** These are the deployment, not
  illustrations. The secrets mounts, the loopback-only published ports, the `640` /
  `2770` file and directory modes, and the rate-limit zones are security properties,
  and a wrong default in either is a vulnerability in this project.
- **Credential disclosure** anywhere it can happen: logs, error pages, `/health`, an
  MCP tool result, or the OAuth discovery documents.

### Out of scope

- **Root on the host.** No control here survives it: every mailbox credential and
  all four secret files are recoverable. Same boundary as `/etc/shadow`.
- **Compromise of the upstream mailbox provider**, or of a mailbox credential you
  configured.
- **Phishing the operator's password.** Rate limiting and a refused-at-entry minimum
  length are what this project does about credential guessing; it can do nothing
  about a credential the operator hands over.
- **Deliberate limitations, each with its reasoning written down** in
  [docs/HARDENING.md](docs/HARDENING.md). These are decisions rather than
  oversights; a report that restates one will be closed as such, and an issue
  arguing the decision is more useful than an advisory:
  - No at-rest encryption of `accounts.json` — it is plain JSON on the connector's
    data volume
  - No multi-tenancy: one operator credential, one set of mailboxes, one static
    token to the connector
  - The claim token neither expires nor is single-use, and is printed to stdout on
    every boot until setup completes
  - Per-IP rate limiting collapses to per-*gateway* behind a containerised TLS
    terminator ([#15](https://github.com/YannicHock/claude-mail-mcp/issues/15)),
    which is also why the log line a fail2ban jail would match should not have a ban
    action armed against it yet
  - An access token minted before the `sid` claim existed survives a revocation for
    at most one access-token lifetime
  - The connector's `/health` is unauthenticated and discloses the version, a
    non-sensitive account summary and the path to `accounts.json`; that is why
    `docker-compose.yml` publishes it on loopback only
  - No dedicated audit log
- **Findings that need a configuration the documentation tells you not to use** —
  publishing the connector's port on `0.0.0.0`, a world-writable secrets directory,
  `TRUST_PROXY` set above the real hop count, or a rate limit widened from
  `location = /settings/login` to all of `/settings`. If the documentation is what
  led you there, say so: that is a documentation bug and worth reporting.
- **Upstream's own code**, except as it ships here — see above.

## Where the security reasoning lives

This document is deliberately short. It says what to report and how; it does not
restate the posture.

- **[docs/HARDENING.md](docs/HARDENING.md)** — what an attacker reaches and why each
  control exists: the trust boundary between the two services, the secret modes and
  the group that makes them work, the bootstrap gate, authentication and revocation,
  the browser-facing headers, rate limiting, and the residual risks stated exactly.
  Every claim there names the code or the test that makes it true.
- **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)** — the topology: the two services, the
  split secrets directories, the named data volumes, the reverse proxy and TLS, and
  the steps that produce a claimed instance.
- **[CHANGELOG.md](CHANGELOG.md)** — what changed in each release.
