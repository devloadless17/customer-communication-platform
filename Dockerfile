FROM node:22-slim AS base
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*

FROM base AS deps
COPY package.json package-lock.json* ./
COPY prisma ./prisma
# Mount cache for npm's download cache. When package-lock changes the layer
# above invalidates, but the download cache is still hot — npm ci re-uses
# downloaded tarballs instead of re-fetching from the registry.
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm ci

FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Mount cache for Next.js incremental build artifacts. The COPY above
# invalidates on any source change (i.e. every commit), so without this
# `next build` does a full cold compile every time. With it, only changed
# routes/modules recompile — biggest deploy-speed win in this Dockerfile.
# Cache mount survives across CI runs via cache-to: type=gha,mode=max.
RUN --mount=type=cache,target=/app/.next/cache,sharing=locked \
    npx prisma generate && npm run build

FROM base AS runner
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 NODE_OPTIONS="--max-old-space-size=4096 --conditions=react-server"
COPY --from=builder --chown=node:node /app ./
USER node
EXPOSE 3000

# node --eval avoids needing curl/wget in the image.
HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --retries=3 \
  CMD node --eval "fetch('http://127.0.0.1:3000/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["sh", "-c", "npx prisma migrate deploy && npx tsx server.ts"]
