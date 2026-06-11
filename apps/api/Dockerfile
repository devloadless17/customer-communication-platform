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

FROM node:24-slim AS base
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates wget ffmpeg \
 && rm -rf /var/lib/apt/lists/*
# COREPACK_HOME points the pnpm shim's cache at a SHARED, world-readable path
# instead of root's private ~/.cache/node/corepack (mode 700). The runtime
# stage switches to `USER node` and the compose CMD runs `pnpm prisma migrate
# deploy` on every freshly-created container's first boot — with root's private
# cache, that pnpm shim found an empty cache under /home/node and re-downloaded
# pnpm@10.33.3 from registry.npmjs.org BEFORE the migration could run, putting
# an external network dependency (npmjs/DNS availability) in the boot path of
# an otherwise self-contained image. A world-readable cache means the
# build-time `corepack prepare` download is reused by the node user at runtime
# — zero network fetch on boot.
ENV COREPACK_HOME=/opt/corepack
RUN corepack enable \
 && mkdir -p /opt/corepack \
 && corepack prepare pnpm@10.33.3 --activate \
 && chmod -R a+rX /opt/corepack

# -----------------------------------------------------------------------------
# deps — every workspace member's package.json must be present so pnpm can
# resolve `workspace:*` against the frozen lockfile (that includes apps/web's,
# even though apps/web source never lands in this image).
#
# The install is SCOPED to @ccp/api's dependency closure (`--filter @ccp/api...`)
# plus the root project (`--filter .`, which runs the root `postinstall` =
# `prisma generate`). Without the filter, an unscoped `pnpm install` materializes
# apps/web's ENTIRE dependency tree (next, react, framer-motion, the tailwind
# toolchain, …) into apps/web/node_modules and that ships in this runtime image
# (runtime is `FROM deps`) — pure dead weight the NestJS process never loads,
# and a wider Trivy CVE surface where a web-only dependency CVE can block an api
# deploy. The `@swc-node/register` TS runtime + its toolchain ARE in @ccp/api's
# closure, so devDeps stay (the image boots TS source via swc at runtime).
# `--frozen-lockfile` still validates against the FULL lockfile; only the
# materialized node_modules subtree shrinks.
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
    pnpm install --frozen-lockfile --filter @ccp/api... --filter .

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
# image-build time so Trivy doesn't flag the stale base. node:24-slim is
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
# APT_CACHE_BUST: CI passes github.run_id so this layer re-runs on EVERY
# deploy (always-current debian security patches). Without it the GHA
# weekly cache scope (+ prev-week fallback) froze this layer for up to two
# weeks while Trivy's CVE feed moves daily — a mid-week debian openssl fix
# then failed every deploy until the cache rotated (CVE-2026-45447,
# 2026-06-10). Local builds keep the default → layer stays cached.
ARG APT_CACHE_BUST=local
RUN echo "apt cache bust: ${APT_CACHE_BUST}" \
 && apt-get update \
 && apt-get -y --no-install-recommends upgrade \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
 && rm -rf /var/lib/apt/lists/*

COPY apps/api ./apps/api
COPY packages ./packages
COPY prisma ./prisma
# Operational scripts run inside the api container (envelope-secret
# re-encryption / key rotation — see scripts/encrypt-secrets.ts + .env.example).
# Tiny; ships so the documented remediation actually exists on the VPS.
COPY scripts ./scripts
COPY tsconfig.json prisma.config.ts ./

# Heap MUST stay under the container's compose `mem_limit: 3g`. A 4096 heap
# could never be backed on the 8GB KVM2 VPS (postgres 1.5g + redis 0.25g + api
# 3g + web 2g already commits ~6.75g, so the limits can't be raised) — V8 would
# grow toward 4g while the cgroup OOM-kills the process at ~3g RSS BEFORE GC
# engaged, manifesting as `exited (137)`. 2048 (matches the dev cap) leaves ~1g
# of RSS headroom (heap + native/buffers/Socket.io) under the 3g cap so GC runs
# first. Do NOT raise past ~2304 without raising mem_limit (which the 8g box
# can't afford).
ENV NODE_ENV=production \
    NODE_OPTIONS="--max-old-space-size=2048 --conditions=react-server" \
    SWC_NODE_PROJECT=/app/apps/api/tsconfig.json
USER node
# Verify the runtime (node) user resolves pnpm from the shared COREPACK_HOME
# WITHOUT a network fetch — if this fails the build, the boot-path corepack
# download regression (see base stage) has returned. Build-time, so it never
# costs a runtime fetch.
RUN pnpm --version
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
#  1) Node runs as PID 1, so SIGTERM from `docker compose down`/`stop`
#     reaches the manual shutdown handler in src/main.ts (server.close →
#     app.close) immediately. The previous
#     `pnpm --filter @ccp/api start` chain (pnpm → sh → node, because
#     the `start` script uses inline `VAR=value` prefix syntax) made
#     signal forwarding shell-implementation-dependent. BullMQ's
#     graceful drain (lib/workflows/worker.ts:lockDuration=90s) only
#     works if SIGTERM lands on Node within the drain budget — which is
#     now compose's `stop_grace_period: 100s` on the api service (the
#     `ccp` systemd unit + its TimeoutStopSec=120 were removed; compose
#     drives the stack directly). Irreversible Meta sends double-fire if
#     the process is SIGKILL'd mid-job before that budget elapses.
#  2) Faster boot — drops two process spawns (~50-100ms each on this VPS).
#  3) Reads pnpm-workspace symlinks at /app/apps/api/node_modules to find
#     @swc-node/register (declared as a direct dep of @ccp/api). WORKDIR
#     set so Node's resolution walks api's node_modules first.
WORKDIR /app/apps/api
CMD ["node", "-r", "@swc-node/register", "src/main.ts"]
