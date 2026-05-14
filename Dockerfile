# Multi-stage build for the Next.js + Socket.io app. Custom server.ts means
# we keep the source on disk and run via tsx (cheaper than compiling to a
# separate dist for the size of this codebase).

FROM node:22-alpine AS deps
WORKDIR /app
RUN apk add --no-cache libc6-compat openssl
COPY package.json package-lock.json* ./
COPY prisma ./prisma
RUN npm ci

FROM node:22-alpine AS builder
WORKDIR /app
RUN apk add --no-cache libc6-compat openssl
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
RUN apk add --no-cache openssl

RUN addgroup --system --gid 1001 nodejs \
    && adduser --system --uid 1001 nextjs

COPY --from=builder --chown=nextjs:nodejs /app/.next ./.next
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nextjs:nodejs /app/package.json ./package.json
COPY --from=builder --chown=nextjs:nodejs /app/server.ts ./server.ts
COPY --from=builder --chown=nextjs:nodejs /app/next.config.ts ./next.config.ts
COPY --from=builder --chown=nextjs:nodejs /app/tsconfig.json ./tsconfig.json
COPY --from=builder --chown=nextjs:nodejs /app/lib ./lib
COPY --from=builder --chown=nextjs:nodejs /app/app ./app
COPY --from=builder --chown=nextjs:nodejs /app/components ./components
COPY --from=builder --chown=nextjs:nodejs /app/hooks ./hooks
COPY --from=builder --chown=nextjs:nodejs /app/prisma ./prisma

USER nextjs
EXPOSE 3000

# Container-level liveness probe. `node --eval` keeps the image lean — no
# wget/curl install. Hits /api/health which checks Postgres + Redis. Docker
# marks the container "unhealthy" after consecutive failures; docker-compose
# `depends_on: service_healthy` blocks dependents until it goes green.
#
# 30s start period gives Prisma migrate + Next prepare time to finish on
# first boot. After that the 10s/3s/3-retry cadence is tight enough to spot
# a hung worker within 30s.
HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --retries=3 \
  CMD node --eval "fetch('http://127.0.0.1:3000/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# Migrations run on container start so a fresh deploy auto-applies any new
# schema changes. Single-node MVP — revisit when we scale out in Phase 2.
CMD ["sh", "-c", "npx prisma migrate deploy && npx tsx server.ts"]
