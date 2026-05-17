# syntax=docker/dockerfile:1.7

# =============================================================================
# Next.js runtime image. Three stages — base → deps → runtime — with the
# repo root as the build context so workspace + lockfile + Prisma schema
# are all reachable. Sibling apps/api/Dockerfile mirrors this shape minus
# the `next build` step.
#
# The image carries apps/web + packages/* + prisma/. apps/api source is
# deliberately NOT copied — the web image never executes NestJS code.
# =============================================================================

FROM node:22-slim AS base
WORKDIR /app
# openssl: required by Prisma's query engine.
# ca-certificates: HTTPS to Meta, HIBP, UploadThing.
# wget: minimal health-check CLI used by compose's wget-based probes.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates wget \
 && rm -rf /var/lib/apt/lists/*
# Pin pnpm via corepack to match package.json's `packageManager` field.
# Avoids the "lockfile written by pnpm X, can't be read by pnpm Y" class
# of bug.
RUN corepack enable && corepack prepare pnpm@10.33.3 --activate

# -----------------------------------------------------------------------------
# deps — workspace-aware install. Only package.json + lockfile + Prisma
# schema come in, so the layer stays cached until a dependency moves. Every
# workspace member's package.json must be present because pnpm walks the
# workspace to resolve `workspace:*` before hitting the registry; that
# includes apps/api's, even though apps/api source never enters this image.
# -----------------------------------------------------------------------------
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/web/package.json ./apps/web/
COPY apps/api/package.json ./apps/api/
COPY packages/shared/package.json ./packages/shared/
COPY packages/config/package.json ./packages/config/
COPY packages/tsconfig/package.json ./packages/tsconfig/
# Schema is needed at install time because the root `postinstall` runs
# `prisma generate`. Pulling it in here means dep-layer cache invalidates
# on schema changes — correct, since the generated client embeds the schema.
COPY prisma ./prisma
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# -----------------------------------------------------------------------------
# runtime — web source + every workspace package + prisma config, then
# `next build`. Re-running `prisma generate` after the source copy covers
# the rare case where source moves the schema without bumping the lockfile.
# -----------------------------------------------------------------------------
FROM deps AS runtime
# Disable telemetry HERE, before `next build` runs below — the ping happens
# during build too, not just runtime.
ENV NEXT_TELEMETRY_DISABLED=1
# Build-time injection of public env vars. Next.js inlines NEXT_PUBLIC_*
# into the client bundle at `next build`, so anything the browser needs
# must be present in the build environment — runtime env from compose is
# too late for these.
ARG NEXT_PUBLIC_API_URL=""
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
COPY apps/web ./apps/web
COPY packages ./packages
COPY prisma ./prisma
COPY tsconfig.json prisma.config.ts ./
# `prisma generate` only reads the schema + emits client code — no DB
# connection is opened — but Prisma 7's config validates DATABASE_URL
# eagerly when `prisma.config.ts` is loaded. Pass a placeholder URL just
# for this step; the real value comes from compose at runtime.
RUN DATABASE_URL="postgresql://placeholder:placeholder@placeholder:5432/placeholder" \
    pnpm exec prisma generate
# .next/cache mount — incremental compile across builds. The source copies
# above invalidate on every commit, so without this `next build` does a
# full cold compile every time. With it only the changed routes/modules
# recompile.
RUN --mount=type=cache,target=/app/apps/web/.next/cache,sharing=locked \
    pnpm --filter @ccp/web build

ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    NODE_OPTIONS="--max-old-space-size=4096 --conditions=react-server"
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --retries=3 \
  CMD node --eval "fetch('http://127.0.0.1:3000/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
# Migrations run from the web side only. Prisma migrate deploy is idempotent
# but running it from both services races for the schema lock and wastes
# startup time. The api service waits on db: { healthy }, not on web.
CMD ["sh", "-c", "pnpm exec prisma migrate deploy && pnpm --filter @ccp/web start"]
