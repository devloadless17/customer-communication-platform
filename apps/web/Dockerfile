# syntax=docker/dockerfile:1.7

# =============================================================================
# Next.js runtime image. Four stages — base → deps → build → cli-tools →
# runtime. The build stage produces `.next/standalone/` (set via `output:
# "standalone"` in next.config.ts) which is a self-contained tree-shaken
# bundle with only the deps `next start` actually traces. The runtime stage
# ships only the standalone bundle + static assets + a small separate
# node_modules tree that holds the prisma CLI + tsx (both invoked as
# binaries, so the Next.js tracer doesn't pick them up).
#
# Net result vs the old "ship everything" runtime:
#   - image ~250-350 MB vs ~600+ MB
#   - cold start ~half (server.js boots directly, no `next start` indirection
#     walking a full pnpm store)
#   - lower steady-state RSS
#
# apps/api source is deliberately NOT included — the web image never runs
# NestJS code. apps/api/Dockerfile mirrors the deps stage with the same
# rationale.
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
# build — web source + every workspace package + prisma config, then
# `next build`. Standalone output lands in apps/web/.next/standalone/ and
# is copied wholesale into the runtime stage below.
#
# `prisma generate` already ran in the deps stage via root `postinstall`,
# and the schema in the source copy below is identical to the one the deps
# stage saw — no re-generate needed.
# -----------------------------------------------------------------------------
FROM deps AS build
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
# .next/cache mount — incremental compile across builds. The source copies
# above invalidate on every commit, so without this `next build` does a
# full cold compile every time. With it only the changed routes/modules
# recompile.
RUN --mount=type=cache,target=/app/apps/web/.next/cache,sharing=locked \
    pnpm --filter @ccp/web build

# -----------------------------------------------------------------------------
# cli-tools — fresh npm install of just the prisma CLI + tsx. These are
# invoked as binaries (prisma migrate deploy + tsx prisma/seeds/...) so
# the Next.js standalone tracer doesn't pick them up. Living in a separate
# node_modules under /opt avoids fighting the standalone-traced node_modules
# at /app/node_modules.
# -----------------------------------------------------------------------------
FROM base AS cli-tools
WORKDIR /tools
# Write a stub package.json with `overrides` BEFORE running npm install so
# transitive deps with known HIGH CVEs get forced to fixed versions:
#   - picomatch < 4.0.4: ReDoS via crafted extglob (CVE-2026-33671)
#   - effect < 3.20.0: AsyncLocalStorage context contamination (CVE-2026-32887)
# Both come in via tsx's runtime deps (chokidar → picomatch) and prisma's
# config loader (@prisma/config → effect). npm reads overrides from this
# package.json even though we pass --no-save (which only suppresses
# writeback, not read).
RUN echo '{"name":"cli-tools","private":true,"overrides":{"picomatch":"^4.0.4","effect":"^3.20.0","esbuild":"^0.28.0"}}' > package.json && \
    npm install --no-save --no-package-lock --omit=dev \
      prisma@7.8.0 \
      @prisma/client@7.8.0 \
      tsx@4.19.2

# -----------------------------------------------------------------------------
# runtime — slim image with the standalone bundle + the CLI tools. No pnpm
# store, no apps/api, no dev deps.
# -----------------------------------------------------------------------------
FROM node:22-slim AS runtime
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates wget \
 && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10.33.3 --activate

# Standalone bundle: server.js + minimal traced node_modules.
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
# Static assets are NOT in standalone output — Next.js expects them at
# .next/static beside server.js.
COPY --from=build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /app/apps/web/public ./apps/web/public

# Prisma + tsx for `migrate deploy` + `db:seed:superadmin`. Living under
# /opt/cli-tools so it doesn't merge with the standalone-traced node_modules
# at /app/node_modules — keeps the two trees independent so a future
# standalone version bump doesn't blow up the CLI install.
COPY --from=cli-tools --chown=node:node /tools/node_modules /opt/cli-tools/node_modules
ENV PATH="/opt/cli-tools/node_modules/.bin:${PATH}"

# Schema + migrations + config for `prisma migrate deploy`. Root package.json
# is needed because the deploy CI step runs `pnpm run db:seed:superadmin`
# which looks up the script there.
COPY --from=build --chown=node:node /app/prisma ./prisma
COPY --from=build --chown=node:node /app/prisma.config.ts ./prisma.config.ts
COPY --from=build --chown=node:node /app/package.json ./package.json

ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    # NODE_OPTIONS deliberately omits `--conditions=react-server`. That
    # condition belongs on the NestJS api image (shared lib code does
    # `import "server-only"` and needs the no-op stub). On the Next.js
    # standalone runtime, the same flag causes Node to resolve react via
    # its `react-server` export condition (react.react-server.js), which
    # the pnpm-flattened standalone trace does NOT ship — boot crashes
    # with `Cannot find module …/react/react.react-server.js`. Next.js's
    # own RSC runtime handles the condition internally; we don't need to
    # set it process-wide.
    NODE_OPTIONS="--max-old-space-size=4096" \
    # Prisma 7's `prisma.config.ts` does `import { defineConfig, env } from
    # "prisma/config"`. The Node resolver walks up from /app/prisma.config.ts
    # → /app/node_modules → /node_modules, none of which contain prisma (the
    # standalone-traced tree has no CLI dependencies). Without NODE_PATH the
    # `prisma migrate deploy` step on container start fails with
    # `Cannot find module 'prisma/config'`. Pointing NODE_PATH at the CLI
    # tools tree lets the resolver find prisma/config without symlinking
    # into the standalone node_modules.
    NODE_PATH="/opt/cli-tools/node_modules"
USER node
EXPOSE 3000
# wget instead of `node --eval` — Node startup costs ~50-100 MB allocated-
# then-freed RSS plus ~200ms every 10s for the whole container lifetime;
# wget is already installed at the base layer for compose's probes.
HEALTHCHECK --interval=10s --timeout=3s --start-period=120s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health >/dev/null || exit 1
# `prisma migrate deploy` is idempotent — runs every container start so
# new migrations land on deploy and it's a no-op otherwise. Then start
# the standalone server.js (Next.js's pre-built entrypoint; replaces the
# old `next start` indirection and boots noticeably faster). start-period
# 120s above accounts for a fresh-DB migration that builds new indexes.
# Migrations run from the web side only — the api service waits on
# postgres: { healthy } and races for the schema lock otherwise.
CMD ["sh", "-c", "prisma migrate deploy && node apps/web/server.js"]
