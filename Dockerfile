# syntax=docker/dockerfile:1

# Node 24 is the active LTS line ("Krypton"), maintained into 2028. Node 26 is
# already released but does not become LTS until October 2026 — move both stages,
# oauth/Dockerfile, the `engines` fields and .github/workflows/_test.yml to 26
# together once it does, and not before: a service holding plaintext mailbox
# passwords should not run a line that is out of long-term support.

# ---- Builder ------------------------------------------------------------
# Full dependency set (incl. devDependencies) so the TypeScript compiler
# is available. Nothing from this stage ships in the final image.
FROM node:24-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- Runtime --------------------------------------------------------------
# Production dependencies only, no build tools, no TypeScript sources.
FROM node:24-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
# Bind on all interfaces inside the container; Docker's port publishing
# forwards to the container's internal IP, not to its loopback interface.
# TLS termination and the public bind address stay nginx's job (see
# docs/DEPLOYMENT.md) — this only concerns the container-internal listener.
ENV HOST=0.0.0.0
ENV PORT=3220
# Container-appropriate default so a bare `docker run` (no compose, no
# ACCOUNTS_FILE override) doesn't crash trying to open the app's own
# default path (/root/.config/mail-mcp/accounts.json), which the non-root
# user below can't read. Harmless when docker-compose.yml sets the same
# value again via `environment:` — it's the same path either way.
ENV ACCOUNTS_FILE=/data/accounts.json

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --from=builder /app/dist ./dist

# Dedicated non-root user. `dist/` and `node_modules/` stay owned by root
# so the runtime user cannot write to its own application code.
#
# The uid/gid are pinned explicitly rather than left to busybox's
# "first free system id" allocation. docs/DEPLOYMENT.md tells the operator to
# `chown 100:101` the host-side accounts.json so the container can read a
# mode-600 credentials file; if a base-image change shifted these numbers, that
# documented deployment would silently become a crash loop (EACCES on
# /data/accounts.json). They are part of this image's published contract —
# keep them in sync with docs/DEPLOYMENT.md and verify with:
#   docker run --rm --entrypoint id ghcr.io/yannichock/claude-mail-mcp:latest
# (gid 101, not 100: alpine already ships gid 100 as the "users" group.)
RUN addgroup -S -g 101 mailmcp && adduser -S -u 100 -G mailmcp mailmcp
LABEL com.claude-mail-mcp.runtime-uid="100" \
      com.claude-mail-mcp.runtime-gid="101"
# Pre-create the ACCOUNTS_FILE directory so a bare `docker run` without any
# volume mount gets a normal "file doesn't exist yet" startup (empty account
# list) instead of EACCES from a root-only path. A real deployment bind-mounts
# something else over /data anyway (see docker-compose.yml).
RUN mkdir -p /data && chown mailmcp:mailmcp /data
USER mailmcp

EXPOSE 3220

# ---------------------------------------------------------------------------
# WARNING — this image binds 0.0.0.0 *inside* the container (required for
# Docker's port publishing to reach it at all). That means the host-side
# exposure is controlled entirely by how you publish the port:
#
#   docker run -p 127.0.0.1:3220:3220 ...   <- correct: loopback only
#   docker run -p 3220:3220 ...             <- WRONG: reachable from the
#                                               internet on every interface
#
# GET /health is unauthenticated and leaks the server name, version,
# account count and accounts_file path. On a public host (e.g. Hetzner),
# always publish with an explicit 127.0.0.1 host IP, or better, use
# docker-compose.yml, which already pins this. See docs/DEPLOYMENT.md.
# ---------------------------------------------------------------------------

# Alpine ships no curl; do the liveness probe with a plain Node HTTP request.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get({host:'127.0.0.1',port:process.env.PORT||3220,path:'/health',timeout:4000},(r)=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["node", "dist/index.js"]
