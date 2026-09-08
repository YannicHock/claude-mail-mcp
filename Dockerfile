# syntax=docker/dockerfile:1

# ---- Builder ------------------------------------------------------------
# Full dependency set (incl. devDependencies) so the TypeScript compiler
# is available. Nothing from this stage ships in the final image.
FROM node:22-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- Runtime --------------------------------------------------------------
# Production dependencies only, no build tools, no TypeScript sources.
FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
# Bind on all interfaces inside the container; Docker's port publishing
# forwards to the container's internal IP, not to its loopback interface.
# TLS termination and the public bind address stay nginx's job (see
# docs/DEPLOYMENT.md) — this only concerns the container-internal listener.
ENV HOST=0.0.0.0
ENV PORT=3220

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --from=builder /app/dist ./dist

# Dedicated non-root user. `dist/` and `node_modules/` stay owned by root
# so the runtime user cannot write to its own application code.
RUN addgroup -S mailmcp && adduser -S mailmcp -G mailmcp
USER mailmcp

EXPOSE 3220

# Alpine ships no curl; do the liveness probe with a plain Node HTTP request.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get({host:'127.0.0.1',port:process.env.PORT||3220,path:'/health',timeout:4000},(r)=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["node", "dist/index.js"]
