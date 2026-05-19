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
#
# `prisma generate` already ran in the deps stage via root `postinstall`,
# and the schema in the source copy below is identical to the one the deps
# stage saw — no re-generate needed.
# -----------------------------------------------------------------------------
FROM deps AS runtime

# Patch debian OS packages (libc6, libcap2, libsystemd0, libudev1, …) at
# image-build time so Trivy doesn't flag the stale base. node:22-slim is
# rebuilt periodically but lags actual debian security updates by days,
# and CI's docker-build-push cache can re-use a still-older base layer.
# Running `apt-get upgrade` here pins us to the current debian
# security feed at the moment of build.
#
# Remove npm itself: the runtime uses `pnpm --filter @ccp/api start`
# exclusively (corepack-installed pnpm at base), so the npm package
# under /usr/local/lib/node_modules/npm is dead weight that ships its
# OWN bundled picomatch / cross-spawn / etc. — every npm release brings
# transitive CVEs the project doesn't actually use.
RUN apt-get update \
 && apt-get -y --no-install-recommends upgrade \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
 && rm -rf /var/lib/apt/lists/*

COPY apps/api ./apps/api
COPY packages ./packages
COPY prisma ./prisma
COPY tsconfig.json prisma.config.ts ./

ENV NODE_ENV=production \
    NODE_OPTIONS="--max-old-space-size=4096 --conditions=react-server" \
    SWC_NODE_PROJECT=/app/apps/api/tsconfig.json
USER node
EXPOSE 4000
# wget is already installed at the base layer for compose's probes; reusing
# it here avoids spinning a fresh Node process every 10s (which would burn
# ~50-100 MB allocated-then-freed RSS on each probe).
# start_interval (Docker 25+) probes every 500ms during start_period so
# service_healthy flips the instant NestJS responds (~3-5s on swc-node)
# instead of waiting a full `interval` cycle. Compose mirrors these.
HEALTHCHECK --start-interval=500ms --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:4000/health >/dev/null || exit 1
# Direct node invocation — no pnpm/sh wrapper. Three reasons:
#  1) Node runs as PID 1, so SIGTERM from systemd/docker reaches
#     `app.enableShutdownHooks()` immediately. The previous
#     `pnpm --filter @ccp/api start` chain (pnpm → sh → node, because
#     the `start` script uses inline `VAR=value` prefix syntax) made
#     signal forwarding shell-implementation-dependent. BullMQ's
#     graceful drain (lib/workflows/worker.ts:lockDuration=90s) only
#     works if SIGTERM lands on Node within the systemd TimeoutStopSec
#     window — irreversible Meta sends double-fire otherwise.
#  2) Faster boot — drops two process spawns (~50-100ms each on this VPS).
#  3) Reads pnpm-workspace symlinks at /app/apps/api/node_modules to find
#     @swc-node/register (declared as a direct dep of @ccp/api). WORKDIR
#     set so Node's resolution walks api's node_modules first.
WORKDIR /app/apps/api
CMD ["node", "-r", "@swc-node/register", "src/main.ts"]
