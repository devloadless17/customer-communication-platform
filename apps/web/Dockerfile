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

FROM node:24-slim AS base
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
# Build-time injection of the server→api upstream too. next.config.ts's
# `rewrites()` reads INTERNAL_API_URL, but Next.js evaluates rewrites at
# `next build` and bakes the result into routes-manifest.json — it is NOT
# re-read from the runtime env. Without this, the `/api/*` proxy rewrite
# bakes the host-dev fallback (127.0.0.1:4000) and every browser /api call
# inside the compose network hits the web container itself → ECONNREFUSED.
# Default to the compose service hostname; prod is unaffected because Caddy
# fronts /api/* before Next.js, so the rewrite is a no-op there.
ARG INTERNAL_API_URL="http://api:4000"
ENV INTERNAL_API_URL=$INTERNAL_API_URL
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
#
# Post-pilot TODO (~2026-06-15): relocate the seed exec target from the
# `app` (web) container to the `api` container (which has prisma/tsx/etc
# via its pnpm install). The `migrate` compose service can ALSO switch to
# the api image since they share the same prisma schema + config. That
# lets us delete this whole stage + the `/opt/cli-tools` PATH/NODE_PATH
# block in the runtime stage, shrinking the web image by ~80 MB AND
# removing the prisma/pg/bcrypt CVE surface from the front-door image.
# Deferred from the 2026-05-26 pre-deploy P1 batch because changing the
# deploy.yml `docker exec app pnpm run db:seed:superadmin` target +
# repointing compose's `migrate` service introduces deploy-time risk
# without changing functional correctness — pure hardening, do it after
# the pilot lands.
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
      @prisma/adapter-pg@7.8.0 \
      pg@8.13.0 \
      bcrypt@6.0.0 \
      tsx@4.19.2
# @prisma/adapter-pg + pg + bcrypt are needed by `prisma/seeds/seed-
# superadmin.ts` which runs via `docker exec app pnpm run db:seed:
# superadmin` in the deploy workflow's post-deploy step. Without
# them the seed crashes with `Cannot find module '@prisma/adapter-
# pg'` — Next.js's standalone tracer at /app/node_modules carries
# only what the page bundle imports, and these three aren't reached
# from any page (the only consumer is the one-shot seed script).
# bcrypt ships native bindings; bcrypt 6 uses N-API (node-addon-api),
# so its prebuilds are ABI-stable across Node majors — node:24-slim
# glibc resolves the same prebuild with no compile step.

# -----------------------------------------------------------------------------
# runtime — slim image with the standalone bundle + the CLI tools. No pnpm
# store, no apps/api, no dev deps.
# -----------------------------------------------------------------------------
FROM node:24-slim AS runtime
WORKDIR /app
# `apt-get upgrade` patches stale debian packages (libc6, libcap2,
# libsystemd0, libudev1, …) at image-build time — node:24-slim is
# rebuilt periodically but lags debian security updates by days, and
# the docker-build-push GHA cache can re-use a still-older base layer.
# Pins us to the current debian security feed at the moment of build.
RUN apt-get update \
 && apt-get -y --no-install-recommends upgrade \
 && apt-get install -y --no-install-recommends openssl ca-certificates wget \
 && rm -rf /var/lib/apt/lists/*
# Remove npm: nothing in the runtime invokes it (cli-tools stage already
# completed its npm install in a separate stage; the runtime uses prisma
# + tsx as standalone binaries via the /opt/cli-tools PATH, and the
# Next.js standalone server runs via plain node). The npm package under
# /usr/local/lib/node_modules/npm ships its OWN bundled deps (picomatch,
# cross-spawn, …) that Trivy keeps flagging on every npm CVE — even
# though the project never executes any of them. Removing it eliminates
# a whole class of false-positives.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
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
    # Heap MUST stay under compose `mem_limit: 2g` (web). 4096 could never be
    # backed on the 8GB KVM2 VPS (limits already commit ~6.75g) — V8 would grow
    # toward 4g while the cgroup OOM-kills at ~2g RSS BEFORE GC ran. 1536 (75%
    # of 2g) leaves ~512m of RSS headroom (heap + native) so GC runs first.
    NODE_OPTIONS="--max-old-space-size=1536" \
    # Prisma 7's `prisma.config.ts` does `import { defineConfig, env } from
    # "prisma/config"`. The Node resolver walks up from /app/prisma.config.ts
    # → /app/node_modules → /node_modules, none of which contain prisma (the
    # standalone-traced tree has no CLI dependencies). The web image carries
    # the Prisma CLI at /opt/cli-tools so the deploy job's manual
    # `pnpm run db:seed:superadmin` step (same image) can resolve prisma/config;
    # NODE_PATH points the resolver there without symlinking into the standalone
    # node_modules. NOTE: the web container itself does NOT run migrations — the
    # api container owns `prisma migrate deploy` (see docker-compose.yml api CMD).
    NODE_PATH="/opt/cli-tools/node_modules"
USER node
EXPOSE 3000
# wget instead of `node --eval` — Node startup costs ~50-100 MB allocated-
# then-freed RSS plus ~200ms every 10s for the whole container lifetime;
# wget is already installed at the base layer for compose's probes.
# Compose redefines these flags with the same shape — keeping them
# matched here means `docker run` standalone behaves identically to
# `docker compose up`. start_interval (Docker 25+) flips healthy the
# instant the standalone server.js responds (~2-3s).
HEALTHCHECK --start-interval=500ms --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health >/dev/null || exit 1
# Direct node invocation — no `sh -c` wrapper. Migrations run as the first
# step of the API container's CMD (`pnpm prisma migrate deploy && exec node …`,
# see docker-compose.yml) — the standalone `migrate` compose service was folded
# into api on 2026-05-19. The web image keeps the Prisma CLI at /opt/cli-tools
# only for the deploy job's manual `db:seed:superadmin` step, NOT for its own
# migrations. Node runs as PID 1, so SIGTERM reaches Next.js cleanly on shutdown.
CMD ["node", "apps/web/server.js"]
