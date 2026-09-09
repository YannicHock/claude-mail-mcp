# syntax=docker/dockerfile:1

# OAuth 2.1 layer for claude-mail-mcp. Built from the oauth/ directory:
#   docker build -f oauth/Dockerfile oauth
#
# Deliberately mirrors the connector's Dockerfile — same base image, same
# non-root pattern, same "no build tools in the runtime stage" split — so there
# is one set of container conventions in this repository rather than two.
#
# That mirroring includes the Node line: 24 is the active LTS, and the move to 26
# happens here and in ../Dockerfile at the same time, once 26 becomes LTS in
# October 2026. See the note at the top of ../Dockerfile.

# ---- Builder ------------------------------------------------------------
FROM node:24-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- Runtime ------------------------------------------------------------
FROM node:24-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
# Binds all interfaces inside the container. Unlike the connector, nothing about
# this service is meant to be published to the host: docker-compose.yml puts it
# on the reverse proxy's network and publishes no port at all, so the container's
# own listener is the only thing this affects.
ENV HOST=0.0.0.0
ENV PORT=8080
ENV STATE_FILE=/data/oauth-state.json

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --from=builder /app/dist ./dist

# Dedicated non-root user. dist/ and node_modules/ stay owned by root so the
# runtime user cannot write to its own application code.
#
# uid/gid differ from the connector's 100:101 on purpose: the two containers
# mount different directories and neither should be able to read the other's.
# The connector's /data holds mailbox credentials; this one's holds only OAuth
# bookkeeping. Keep in sync with docs/DEPLOYMENT.md, and verify with:
#   docker run --rm --entrypoint id ghcr.io/yannichock/claude-mail-mcp-oauth:latest
#
# The shared `secrets/` directory is the deliberate exception to that
# separation, and the group that governs it is *not* baked into this image. It
# cannot usefully be: the directory lives on the host, and a gid compiled in here
# is only a guess about a host the image has never seen. Both images used to pin
# `mailsecrets` at gid 105 and the deployment used to say `chgrp 105 secrets`; on
# Debian and Ubuntu 105 is inside the 100–999 system range and usually already
# belongs to a real system group, which that chgrp then handed a writable secrets
# directory to.
#
# The operator creates the group instead (`groupadd --system mailsecrets`), owns
# `secrets/` with it, and passes its real gid as SECRETS_GID, which
# docker-compose.yml applies to both services with `group_add`. See
# docs/DEPLOYMENT.md step 2, and the longer note in ../Dockerfile on why an
# image-side numeric `mailsecrets` must not come back alongside it.
RUN addgroup -S -g 103 mailoauth \
 && adduser -S -u 102 -G mailoauth mailoauth
LABEL com.claude-mail-mcp-oauth.runtime-uid="102" \
      com.claude-mail-mcp-oauth.runtime-gid="103"

# Pre-created so a bare `docker run` with no volume gets a normal empty-state
# start instead of EACCES on the first client registration.
RUN mkdir -p /data && chown mailoauth:mailoauth /data
USER mailoauth

EXPOSE 8080

# Alpine ships no curl; probe with a plain Node HTTP request, as the connector does.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get({host:'127.0.0.1',port:process.env.PORT||8080,path:'/health',timeout:4000},(r)=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["node", "dist/index.js"]
