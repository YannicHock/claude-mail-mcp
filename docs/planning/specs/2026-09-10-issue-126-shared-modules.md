# One `shared/` instead of four mirroring patterns — design

Status: drafted 2026-09-10, pending owner review.

Wave 0 of v0.7.1. Companion to `2026-09-10-v0.7.1-first-run-sharp-edges.md`, which
explains why this runs first and what waits behind it.

Issues: #126. Closes #132. Supersedes #6, #72 and #75 in scope, which stay in the
backlog as the narrower findings they are.

## 0. Problem

The two packages have separate Docker build contexts — the connector builds from `.`,
the OAuth layer from `oauth/` — so neither can import from the other. Six modules are
therefore mirrored by hand, and protected four different ways:

| duplicate | size | pinned by |
| --- | --- | --- |
| `src/secrets.ts` ↔ `oauth/src/secrets.ts` | 498 lines | whole-file drift test **+ an import rewrite** |
| `src/settings-api.ts` ↔ `oauth/src/settings-api.ts` | 1,058 lines | whole-file drift test |
| `src/canonical-url.ts` ↔ `oauth/src/canonical-url.ts` | ~82 lines | whole-file drift test |
| `pageHeaders` + `SETTINGS_CSP` in the two `settings-pages.ts` | ~35 lines | a **regex-extraction** drift test |
| `trustProxyHops` — `src/config.ts:112` ↔ `oauth/src/config.ts:444` | ~12 lines | **nothing** |
| `escapeHtml` — `src/settings-pages.ts:75` ↔ `oauth/src/login.ts:140` | 7 lines | **nothing** |

`test/unit/secrets.test.ts` and `oauth/test/unit/secrets.test.ts` are byte-for-byte
identical across 530 lines, maintained by hand, pinned by nothing at all.

The four comparators are four readings of the same intent:

- `canonical-url.test.ts:37` — strip CRLF, strip the leading block comment
- `settings-api.test.ts:94` — the same, written again
- `secrets.test.ts:554` — the same, plus `.replace('from "./app.js"', 'from "./logger.js"')`
- `settings-headers.test.ts:170` — regex-extract the two blocks, strip line comments

### Why this outranks the line count

`trustProxyHops` answers the question *"is a fourth pair forming?"* — **yes**, and it
arrived very late, in `e10a4ae` and `5a7ce79`, days before the 0.7.0 tag. It is a
security-relevant rule about how many `X-Forwarded-For` hops to trust, character-
identical in both packages down to the error string, with no comment, no mirrored
module and no drift test.

The pattern is applied when a wave notices a shared rule and absent when it does not.
That is not a pattern; it is a coin flip. And v0.7.1's remaining work extends
`settings-api.ts` — the largest mirrored file — twice over.

## 1. Scope

**In:** a `shared/` directory compiled into both images; the six duplicates moved
into it; the four drift tests and the duplicated `secrets.test.ts` deleted; both
build contexts, `.dockerignore`s and tsconfigs adjusted to make that possible.

**Out:** within-package duplication — #6 (atomic-write recipe across three modules),
#8 (settings-page boilerplate), #72 (three stylesheets), #75 (OAuthConfig literals
and capturing loggers). Those are real and separate, and folding them in would turn a
mechanical move into a refactor.

**Out:** any change to what either image contains at runtime, what it listens on, or
what it reads at boot. If the deployed behaviour changes at all, something went
wrong.

## 2. The blocking constraint, and what it actually costs

`oauth/Dockerfile` builds from context `oauth/`, so it cannot `COPY ../shared`. Both
matrix entries in `ci.yml` (lines 66–79) and `release.yml` (lines 77–86) move to
`context: .`, with `file: oauth/Dockerfile` for the OAuth entry.

That single change has four consequences, and each one is a way this can go wrong
quietly.

### 2.1 `oauth/Dockerfile`'s own paths all shift

With context `.`, every `COPY` in `oauth/Dockerfile` is resolved from the repository
root. `COPY package.json package-lock.json ./` currently picks up the OAuth layer's;
after the change it picks up the **connector's** — same filenames, wrong package,
and a build that succeeds while producing the wrong image. Every path in that file
becomes `oauth/…` explicitly, and `COPY shared ./shared` is added.

The connector's `Dockerfile` already builds from `.` and needs only the `shared` copy.

### 2.2 The ignore files must diverge per Dockerfile

The root `.dockerignore` excludes `oauth` — deliberately, so the connector image never
carries the OAuth layer's tree. With the OAuth build now using the same context, that
exclusion would remove the very source it needs.

BuildKit resolves a per-Dockerfile ignore file — `oauth/Dockerfile.dockerignore` —
in preference to the context's `.dockerignore`. That is the mechanism this design
relies on: the root file keeps excluding `oauth` for the connector, and
`oauth/Dockerfile.dockerignore` excludes `src`, `test`, `.github` and the connector's
`node_modules` for the OAuth build. Both must keep `shared` **in**.

**This must be proven with a real build before anything else in the milestone starts.**
It is the one assumption in this design that a typecheck cannot confirm, and if
BuildKit does not honour it here, §5 is the fallback.

### 2.3 `rootDir` moves, and both entrypoints move with it

Both `tsconfig.json`s set `rootDir: "src"`, `outDir: "dist"`. A `shared/` outside
`src` cannot compile under that rootDir. Setting `rootDir: "."` with
`include: ["src/**/*", "shared/**/*"]` emits `dist/src/index.js` and
`dist/shared/…` — correct, and relative imports resolve at runtime, but **every
reference to `dist/index.js` breaks**:

- `package.json` `"main"` and `"start"` — both packages
- `ENTRYPOINT ["node", "dist/index.js"]` — `Dockerfile:115` and `oauth/Dockerfile:86`
- the connector's `"bin"` entry

The healthcheck lines are unaffected; they speak HTTP. `"dev": "tsx watch src/index.ts"`
is unaffected.

This is the change most likely to pass CI and fail in production — a typecheck and a
unit run never execute `dist/index.js`. The container healthcheck is what catches it,
so both images must be started, not merely built, before this is called done.

### 2.4 Neither package gains a dependency

`shared/` is compiled source, not an npm package. No workspace, no `file:` dependency,
no `package-lock.json` regeneration in either package. The runtime stage's
`npm ci --omit=dev` keeps working unchanged because nothing was added to either
manifest. This is the property that keeps the change mechanical; a design that needs
lockfile churn in both packages is the wrong one.

## 3. What moves

```
shared/
  secrets.ts          from src/ + oauth/src/          498 lines, one copy
  settings-api.ts     from src/ + oauth/src/        1,058 lines, one copy
  canonical-url.ts    from src/ + oauth/src/           ~82 lines, one copy
  page-headers.ts     pageHeaders + SETTINGS_CSP       ~35 lines, extracted
  trust-proxy.ts      trustProxyHops                   ~12 lines, unpinned today
  escape-html.ts      escapeHtml                         7 lines, unpinned today
```

Two of the six carry a wrinkle worth stating before someone rediscovers it mid-move:

- **`secrets.ts` differs by one import.** The drift test rewrites
  `from "./app.js"` to `from "./logger.js"` before comparing, because the two
  packages name their logger module differently. The shared copy imports neither: the
  logger arrives as a parameter or through a tiny per-package adapter, decided when
  the move is made, and that is what lets one file serve both.
- **`canonical-url.ts`'s two copies differ by 12 lines** — the header comment,
  written from each package's own point of view ("this file is the connector's
  copy…"). Only the body is mirrored, which is why that comparator strips the leading
  block comment. The shared copy gets one comment written from neither side, and the
  §0 explanation of *why* the canonicalisation must be identical survives into it —
  that comment is the record of #110 and is worth more than the code it sits above.

`oauth/src/urls.ts` re-exports the three canonicalisation functions today so the OAuth
layer keeps a single URL module. It keeps doing that, re-exporting from `shared/`.

## 4. What gets deleted

- the four drift tests, and with them the four comparators — **this closes #132**
- `oauth/test/unit/secrets.test.ts`, 530 lines identical to the connector's
- roughly 1,650 lines of mirrored source — the three whole files alone are 1,638,
  because `settings-api.ts` has grown to 1,058 lines per copy since #126 recorded it
  at 581

The deletion is the point, so it needs saying plainly: **after this, nothing pins the
shared modules, because there is nothing left to pin.** The tests that go away were
guarding an invariant that stops existing. The tests that assert the modules'
*behaviour* — the rest of `secrets.test.ts`, `settings-api.test.ts`,
`canonical-url.test.ts`, `settings-headers.test.ts` — all stay, and run once instead
of twice.

One new test replaces all four: nothing under `src/` or `oauth/src/` may declare a
symbol that `shared/` already exports. That is the invariant that actually matters
going forward — not "the copies match" but "a second copy did not appear" — and it
is the same shape as the guard #146 wants for its classifier.

## 5. If BuildKit does not cooperate

If `oauth/Dockerfile.dockerignore` turns out not to be honoured by the pinned
`docker/build-push-action` version, the fallback is a **build-time copy**: keep the
OAuth context at `oauth/`, and have CI copy `shared/` into `oauth/shared/` before the
build, with `oauth/shared/` in `.gitignore`.

It is worse — the source of truth is briefly in two places on disk, and a local
`docker build` in `oauth/` without the copy step fails confusingly. It is written down
so that discovering the constraint does not restart the design. If §2.2 fails, take
this, note it in the issue, and continue; do not stop the milestone on it.

## 6. Order within the issue

Each step leaves the tree green, because a half-migrated mirror is the one state
nothing in this repository can check:

1. `oauth/Dockerfile` paths made explicit, context switched, ignore files split.
   **Build both images and start both containers.** No source moved yet — if this
   step is wrong, it is wrong in isolation.
2. `rootDir`, `main`, `start`, `bin`, both `ENTRYPOINT`s. Build and start again.
3. Move the three whole files. Delete their drift tests and the duplicated
   `secrets.test.ts`. Full suite.
4. Extract the three unpinned or partially-pinned fragments — `page-headers`,
   `trust-proxy`, `escape-html`. `trustProxyHops` first: it is the security-relevant
   one and the reason this issue outranks its line count.
5. Add the no-second-copy test. Delete the last comparator.

Steps 1 and 2 touch the release pipeline and nothing else; steps 3 to 5 touch source
and nothing else. If the milestone has to be interrupted, the boundary between 2 and 3
is where it can be left standing.
