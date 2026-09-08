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
# Fill in IMAP_*, SMTP_*, DEFAULT_FROM, AUTH_TOKEN
npm run dev   # tsx watch mode
```

## Testing against a real mailbox

The fastest loop is:

1. Point `.env` at a test mailbox (Mailbox.org has a 30-day free trial, Fastmail also offers trials).
2. `npm run dev`
3. Hit `/mcp` with `curl` and a hand-rolled JSON-RPC request, or use the MCP Inspector (`npx @modelcontextprotocol/inspector`).

Avoid running tools against your primary inbox while iterating — `delete_message` is destructive and `send_message` actually sends.

## Code review checklist

- [ ] No new dependencies unless really needed
- [ ] Tool inputs validated with Zod schemas
- [ ] IMAP calls hold a mailbox lock (`getMailboxLock`) for the whole operation
- [ ] Errors propagate as plain `Error` with a useful message
- [ ] README / CHANGELOG updated if user-visible behaviour changes

## Reporting security issues

See [SECURITY.md](SECURITY.md). Please do **not** open public issues for security problems.
