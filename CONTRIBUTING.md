# Contributing

Thanks for considering a contribution. This project is small and aims to stay small — one focused MCP connector for IMAP, SMTP and CalDAV.

## Before you open a PR

- For non-trivial changes, open an issue first so we can align on scope.
- New tools should map cleanly onto an IMAP, SMTP or CalDAV verb. If you find yourself bolting in business logic (auto-categorization, scoring, summarization), that probably belongs on the Claude side, not in the connector.
- Match the existing code style (TypeScript strict, ES modules, 2-space indent).

## Local development

```bash
git clone https://github.com/YannicHock/claude-mail-mcp.git
cd claude-mail-mcp
npm install
cp .env.example .env
# Set AUTH_TOKEN (openssl rand -hex 32) and point ACCOUNTS_FILE at a local
# file, e.g. ACCOUNTS_FILE=./accounts.json — it is git-ignored.
npm run dev   # tsx watch mode
```

Mailbox credentials are not environment variables. `IMAP_*`, `SMTP_*`,
`CALDAV_*` and `DEFAULT_FROM` were removed in 0.2.0 (BREAKING — see
[CHANGELOG.md](CHANGELOG.md)); accounts live in `accounts.json`, whose format is
in the [README](README.md#quick-start).

## Tests

```bash
npm run typecheck        # tsc --noEmit over src/
npm run typecheck:test   # tsc over src/ + test/
npm run test:unit        # 25 tests, offline — no network, no Docker
npm run test:integration # 14 tests; starts a disposable GreenMail container
```

`npm test` is an alias for `test:unit`. The integration suite manages its own
GreenMail container from `docker-compose.test.yml` and skips cleanly rather than
failing when the Docker daemon isn't reachable. CI runs all four on every push
and pull request.

## Testing against a real mailbox

The fastest loop is:

1. Point `.env` at a test mailbox (Mailbox.org has a 30-day free trial, Fastmail also offers trials).
2. `npm run dev`
3. Hit `/mcp` with `curl` and a hand-rolled JSON-RPC request, or use the MCP Inspector (`npx @modelcontextprotocol/inspector`).

Avoid running tools against your primary inbox while iterating — `delete_message` is destructive and `send_message` actually sends.

## Code review checklist

- [ ] `npm run typecheck` and `npm run typecheck:test` are clean
- [ ] `npm run test:unit` and `npm run test:integration` pass
- [ ] New behaviour has a test; a bug fix has a test that fails without it
- [ ] No new dependencies unless really needed
- [ ] Tool inputs validated with Zod schemas
- [ ] IMAP calls hold a mailbox lock (`getMailboxLock`) for the whole operation
- [ ] Errors propagate as plain `Error` with a useful message
- [ ] README / CHANGELOG updated if user-visible behaviour changes

## Reporting security issues

See [SECURITY.md](SECURITY.md). Please do **not** open public issues for security problems.
