## What this changes

<!-- What behaviour is different after this PR, and why. Link the issue: Closes #NNN -->

## How it was verified

<!-- What you ran, and against what. "Tested against a real Mailbox.org account"
     is worth more than "tests pass" for anything protocol-facing. -->

## Checklist

From [CONTRIBUTING.md](../blob/main/CONTRIBUTING.md) — tick what applies, delete what does not.

- [ ] `npm run typecheck` and `npm run typecheck:test` are clean
- [ ] `npm run test:unit` and `npm run test:integration` pass
- [ ] New behaviour has a test; a bug fix has a test that fails without it
- [ ] No new dependencies unless really needed
- [ ] Tool inputs validated with Zod schemas
- [ ] IMAP calls hold a mailbox lock (`getMailboxLock`) for the whole operation
- [ ] Errors propagate as plain `Error` with a useful message
- [ ] README / CHANGELOG updated if user-visible behaviour changes
- [ ] Version strings left alone, or all of them moved together (`scripts/check-versions.sh`)

## Notes for the reviewer

<!-- Anything deliberately left out, deferred to a follow-up issue, or worth arguing about. -->
