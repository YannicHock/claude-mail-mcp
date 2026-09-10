# syntax=docker/dockerfile:1

# OAuth 2.1 layer for claude-mail-mcp. Built from the *repository root*:
#   docker build -f oauth/Dockerfile .
#
# The context is the root, not oauth/, because this image compiles shared/ as
# well as oauth/src — and a context rooted at oauth/ cannot reach a sibling
# directory (#126). Two consequences are worth stating where they will be read:
#
#   1. Every COPY below names its path from the repository root. `COPY
#      package.json` would pick up the *connector's* manifest — same filename,
#      wrong package, and a build that succeeds while producing the wrong image.
#   2. What reaches the build is filtered by oauth/Dockerfile.dockerignore, not
#      by the root .dockerignore. BuildKit resolves `<dockerfile>.dockerignore`
#      in preference to the context's, which is what lets the root file keep
#      excluding oauth/ for the connector image while this build keeps it.
#
# WORKDIR is /app/oauth with shared/ at /app/shared, so the layout inside the
# image is the repository's layout. That is deliberate: it means
# `../../shared/x.js` resolves the same way in a checkout and in the container,
# and the compiler emits the same paths in both.
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
WORKDIR /app/oauth

COPY oauth/package.json oauth/package-lock.json ./
RUN npm ci

COPY oauth/tsconfig.json ./
COPY oauth/src ./src
# Sibling of the package directory, exactly as in the repository. tsconfig.json's
# rootDir is `..`, so this emits dist/oauth/src/… beside dist/shared/… .
#
# shared/package.json comes with it and is not optional. /app has no manifest in
# this image, and under NodeNext TypeScript reads a file's module format from the
# nearest package.json — without that marker these files would emit as CommonJS
# here and as ESM in the connector's build, and this container would die at
# startup on a named import that typechecked cleanly.
COPY shared /app/shared
RUN npm run build

# ---- Runtime ------------------------------------------------------------
FROM node:24-alpine AS runtime
WORKDIR /app/oauth

ENV NODE_ENV=production
# Binds all interfaces inside the container; Docker's port publishing forwards to
# the container's internal IP, not to its loopback interface. Host-side exposure
# is decided by how the port is published and not here: docker-compose.yml
# publishes 127.0.0.1:8080:8080 — loopback only, for a TLS terminator running on
# the host. If yours runs in a container instead, that `ports` block comes out and
# both services go on the proxy's network, publishing nothing to the host at all.
# Either way TLS termination stays the proxy's job (see docs/DEPLOYMENT.md).
ENV HOST=0.0.0.0
ENV PORT=8080
ENV STATE_FILE=/data/oauth-state.json

COPY oauth/package.json oauth/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --from=builder /app/oauth/dist ./dist

# Dedicated non-root user. dist/ and node_modules/ stay owned by root so the
# runtime user cannot write to its own application code.
#
# uid/gid differ from the connector's 100:101 on purpose: the two containers
# mount different directories and neither should be able to read the other's.
# The connector's /data holds mailbox credentials; this one's holds only OAuth
# bookkeeping. Keep in sync with docs/DEPLOYMENT.md, and verify with:
#   docker run --rm --entrypoint id ghcr.io/yannichock/claude-mail-mcp-oauth:latest
#
# The shared secrets directory is the deliberate exception to that
# separation, and the group that governs it is *not* baked into this image. It
# cannot usefully be: the directory lives on the host, and a gid compiled in here
# is only a guess about a host the image has never seen. Both images used to pin
# `mailsecrets` at gid 105 and the deployment used to say `chgrp 105 secrets`; on
# Debian and Ubuntu 105 is inside the 100–999 system range and usually already
# belongs to a real system group, which that chgrp then handed a writable secrets
# directory to.
#
# The operator creates the group instead (`groupadd --system mailsecrets`), owns
# `secrets/shared/` and `secrets/oauth/` with it, and passes its real gid as
# SECRETS_GID, which
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

ENTRYPOINT ["node", "dist/oauth/src/index.js"]
