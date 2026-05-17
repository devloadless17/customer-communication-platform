# syntax=docker/dockerfile:1.7

# =============================================================================
# Multi-target Dockerfile for the pnpm/turbo monorepo. Two final stages —
# `web` (Next.js) and `api` (NestJS) — share every layer up through deps +
# build, then diverge only on entrypoint. docker-compose picks the target
# per service via build.target so each service gets its minimal runtime
# image without a separate Dockerfile to drift.
#
# Stage graph:
#   base    → node:22-slim + pnpm via corepack
#   deps    → pnpm install --frozen-lockfile (lockfile + every package.json copied)
#   builder → full source + `prisma generate` + `@ccp/web build`
#   web     → final image for the Next.js service (CMD = prisma migrate + next start)
#   api     → final image for the NestJS service (CMD = @swc-node/register main.ts)
# =============================================================================

FROM node:22-slim AS base
WORKDIR /app
# openssl: required by Prisma's query engine.
# ca-certificates: HTTPS to Meta, HIBP, UploadThing.
# wget: minimal health-check CLI used by docker-compose's wget-based probes.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates wget \
 && rm -rf /var/lib/apt/lists/*
# Pin pnpm via corepack so the image's installer always matches package.json's
# `packageManager` field. Removes the "works on my machine vs CI" class of
# bug where pnpm 8 produces a lockfile pnpm 9 can't read.
RUN corepack enable && corepack prepare pnpm@10.33.3 --activate

# -----------------------------------------------------------------------------
# deps — workspace-aware install. Copies ONLY lockfile + workspace metadata so
# this layer is cached as long as no dependency moves. Per-app package.json
# files come along because pnpm walks the workspace to resolve `workspace:*`
# protocol entries before fetching from the registry.
# -----------------------------------------------------------------------------
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/web/package.json ./apps/web/
COPY apps/api/package.json ./apps/api/
COPY packages/shared/package.json ./packages/shared/
COPY packages/tsconfig/package.json ./packages/tsconfig/
COPY packages/eslint-config/package.json ./packages/eslint-config/
# Prisma schema is needed at install time for the root `postinstall` hook
# which runs `prisma generate`. Pulled in before source so dep-only layer
# cache invalidates on schema changes — that's correct (generated client
# embeds the schema, so it must rebuild when schema moves).
COPY prisma ./prisma
# Mount cache for pnpm's content-addressable store. When pnpm-lock.yaml
# changes the layer above invalidates, but the store is still hot — pnpm
# rebuilds the virtual store from already-fetched tarballs instead of
# re-fetching from the registry.
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# -----------------------------------------------------------------------------
# builder — full source on top of the cached deps tree. Generates the
# Prisma client (re-generates if the postinstall already ran; idempotent)
# then builds the Next.js bundle. NestJS does NOT need a build step — it
# runs via @swc-node/register at runtime, no `nest build` involved.
# -----------------------------------------------------------------------------
FROM deps AS builder
COPY . .
# Make sure the prisma client matches the schema in this commit. The
# postinstall ran during the deps stage with the schema-at-deps-time;
# re-running here covers the (rare) case where source changes the schema
# but not the lockfile.
RUN pnpm exec prisma generate
# Next.js cache mount — incremental compile across builds. The COPY above
# invalidates on any source change (i.e. every commit), so without this
# `next build` does a full cold compile every time. With it only the
# changed routes/modules recompile.
RUN --mount=type=cache,target=/app/apps/web/.next/cache,sharing=locked \
    pnpm --filter @ccp/web build

# -----------------------------------------------------------------------------
# web — Next.js runtime. Carries the entire build output + node_modules
# (pnpm's symlinked virtual store, so the layer cost is ~tens of MB of
# .pnpm directory entries, not duplicated packages).
# -----------------------------------------------------------------------------
FROM base AS web
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    NODE_OPTIONS="--max-old-space-size=4096 --conditions=react-server"
COPY --from=builder --chown=node:node /app ./
USER node
EXPOSE 3000
# node --eval avoids needing curl in the runtime image (wget is already
# there for the docker-compose probes, but the HEALTHCHECK uses fetch for
# parity with the api side).
HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --retries=3 \
  CMD node --eval "fetch('http://127.0.0.1:3000/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
# Migrations run from this side only — Prisma migrate is idempotent but
# running it from both services on every boot races for the schema lock
# and wastes startup time. The api service waits on db: { healthy } so
# it doesn't matter that web takes a few seconds longer to come up.
CMD ["sh", "-c", "pnpm exec prisma migrate deploy && pnpm --filter @ccp/web start"]

# -----------------------------------------------------------------------------
# api — NestJS runtime via @swc-node/register. Same image graph as `web`
# but a different CMD (and no Next.js bundle is actually used at runtime;
# the layer is still carried because pnpm's symlinked store makes pruning
# painful and the size delta is small).
#
# Why @swc-node/register and not `nest build` + plain node: NestJS DI
# needs `emitDecoratorMetadata`, which esbuild (tsx's backend) does NOT
# emit. SWC does. The runtime cost is ~600ms colder cold-start vs nest
# build; acceptable for now. Switch to `nest build` + `node dist/main.js`
# once the controller surface stabilizes (post-deploy).
# -----------------------------------------------------------------------------
FROM base AS api
ENV NODE_ENV=production \
    NODE_OPTIONS="--max-old-space-size=4096 --conditions=react-server"
COPY --from=builder --chown=node:node /app ./
USER node
EXPOSE 4000
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=5 \
  CMD node --eval "fetch('http://127.0.0.1:4000/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
# Defers to the package's `start` script — keeps SWC_NODE_PROJECT +
# NODE_OPTIONS + the entry point in one place (apps/api/package.json).
CMD ["pnpm", "--filter", "@ccp/api", "start"]
