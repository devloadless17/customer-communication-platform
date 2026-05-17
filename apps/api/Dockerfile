# syntax=docker/dockerfile:1.7

# =============================================================================
# NestJS runtime image. Three stages — base → deps → runtime — with the
# repo root as the build context. NestJS boots via @swc-node/register at
# startup; no compile step lives here (the SWC runtime is locked in because
# esbuild doesn't emit decorator metadata — see CLAUDE.md).
#
# The image carries apps/api + packages/* + prisma/. apps/web source and
# the Next.js .next/ build output are deliberately NOT included — saves
# ~100–300 MB vs the previous monolithic image that shipped both.
# =============================================================================

FROM node:22-slim AS base
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates wget \
 && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10.33.3 --activate

# -----------------------------------------------------------------------------
# deps — identical to apps/web/Dockerfile's deps stage. pnpm needs every
# workspace member's package.json present to resolve `workspace:*` before
# fetching from the registry; that includes apps/web's, even though
# apps/web source never lands in this image.
# -----------------------------------------------------------------------------
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/web/package.json ./apps/web/
COPY apps/api/package.json ./apps/api/
COPY packages/shared/package.json ./packages/shared/
COPY packages/config/package.json ./packages/config/
COPY packages/tsconfig/package.json ./packages/tsconfig/
COPY prisma ./prisma
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# -----------------------------------------------------------------------------
# runtime — api source + every workspace package + prisma config. apps/web
# is NOT copied; nothing in the NestJS process imports from it. No build
# step — `pnpm --filter @ccp/api start` defers to @swc-node/register +
# SWC_NODE_PROJECT wired up in apps/api/package.json.
# -----------------------------------------------------------------------------
FROM deps AS runtime
COPY apps/api ./apps/api
COPY packages ./packages
COPY prisma ./prisma
COPY tsconfig.json prisma.config.ts ./
# `prisma generate` only reads the schema + emits client code — no DB
# connection is opened — but Prisma 7's config validates DATABASE_URL
# eagerly when `prisma.config.ts` is loaded. Pass a placeholder URL just
# for this step; the real value comes from compose at runtime.
RUN DATABASE_URL="postgresql://placeholder:placeholder@placeholder:5432/placeholder" \
    pnpm exec prisma generate

ENV NODE_ENV=production \
    NODE_OPTIONS="--max-old-space-size=4096 --conditions=react-server"
USER node
EXPOSE 4000
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=5 \
  CMD node --eval "fetch('http://127.0.0.1:4000/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
# Defers to the package's `start` script — keeps SWC_NODE_PROJECT +
# NODE_OPTIONS + the entry point in one place (apps/api/package.json).
CMD ["pnpm", "--filter", "@ccp/api", "start"]
