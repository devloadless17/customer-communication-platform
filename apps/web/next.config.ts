import type { NextConfig } from "next";

const isProd = process.env.NODE_ENV === "production";

/**
 * Security response headers applied to every route. Notes on each:
 *
 *   - Strict-Transport-Security: 2-year HSTS. Only in prod — dev runs on
 *     http://localhost and would be unreachable with HSTS pinned.
 *   - X-Frame-Options + frame-ancestors 'none': clickjacking defense. Two
 *     ways to say the same thing; we ship both because some scanners only
 *     check one. The app has no legitimate iframe embedders.
 *   - X-Content-Type-Options: nosniff — stops MIME-sniffing-driven XSS.
 *   - Referrer-Policy: don't leak the path to third parties on outbound
 *     navigation, but keep the origin for same-origin requests.
 *   - Permissions-Policy: deny browser capabilities we never use.
 *
 * The CSP header here is the minimal clickjacking backstop applied to
 * static assets and non-page responses that bypass the proxy matcher
 * (`_next/static`, `_next/image`, favicons, paths with a dot). Page
 * routes get the full nonce-based CSP from `src/proxy.ts`; browsers
 * intersect multiple CSP headers so both restrictions are enforced
 * on those — there's no conflict, the dynamic CSP is just stricter.
 */
const securityHeaders = [
  ...(isProd
    ? [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" }]
    : []),
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), interest-cohort=()",
  },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Standalone output — emits `.next/standalone/` with a tree-shaken
  // node_modules + self-contained `server.js`. The Dockerfile copies ONLY
  // standalone/ + static/ + public/ into the runtime image, which is
  // hundreds of MB lighter than shipping the whole pnpm store and boots
  // noticeably faster than `next start` against a full deps tree.
  //
  // (The earlier custom-server.ts pattern from slice 1 is gone — Phase 5
  // removed it. `next start` is the entrypoint now, which is exactly what
  // standalone is designed for.)
  output: "standalone",
  // Standalone in a workspace setup needs outputFileTracingRoot pointed
  // at the monorepo root — without this, Next.js's file tracer only
  // walks apps/web/node_modules and misses the hoisted pnpm packages
  // under <root>/node_modules/.pnpm, producing a runtime that
  // immediately MODULE_NOT_FOUND on framer-motion, lucide-react, etc.
  // path.join keeps this portable across the dev tree and the Docker
  // build context (both resolve to the same monorepo root).
  outputFileTracingRoot: require("path").join(__dirname, "../../"),
  // Router cache: rely on Next 16's default (`dynamic: 0`, static unset).
  //
  // Earlier we set `dynamic: 60` to keep recently-viewed dynamic segments
  // (chat threads, settings pages) in the client-side router cache for
  // 60s — instant back-clicks, no Postgres round trip on revisit. The
  // assumption was that socket events (`useCatalogSync` → router.refresh)
  // would keep cached pages fresh.
  //
  // The assumption was wrong: `router.refresh()` only refreshes the
  // CURRENT route, not sibling cached routes. So adding a snippet /
  // contact field on /settings correctly refreshed the settings page
  // but the cached /inbox RSC stayed stale until 60s elapsed — user
  // had to "luck into" the cache expiring across 3-5 manual refreshes.
  // Reverted 2026-05-19 to match the Next 16 default (every navigation
  // re-fetches). One HTTP round trip on click-back (~100-300ms) buys
  // strict freshness, which is what the product needs.
  //
  // If we want the instant-back UX later, the right path is a
  // socket-driven cross-route invalidator (mark OTHER routes' caches
  // stale on `team:catalog:changed`), not a blind 60s TTL.
  // Per-icon imports for lucide-react. Without this, Next's bundler treats
  // `import { X, Y } from "lucide-react"` as importing the full barrel and
  // tree-shaking is unreliable across edge/server boundaries. The transform
  // rewrites each named import to a deep path so only the icon's own module
  // hits the bundle. ~50–70 KB gzipped saved on the inbox chunk where ~30
  // icons are imported across the conversation list, header, and composer.
  modularizeImports: {
    "lucide-react": {
      transform: "lucide-react/dist/esm/icons/{{kebabCase member}}",
    },
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },
  // Legacy /automations URLs → /workflows. The migration renamed the
  // surface; stale bookmarks and tabs should not dead-end at a 404.
  async redirects() {
    return [
      { source: "/automations", destination: "/workflows", permanent: false },
      { source: "/automations/:path*", destination: "/workflows/:path*", permanent: false },
    ];
  },
  // In prod, Caddy fronts both processes and routes `/api/*` to NestJS
  // before requests reach Next.js — so these rewrites are a no-op there.
  // They exist for the no-Caddy paths (local Docker stack, `npm run dev`
  // against a host-side api) so that browser fetches to api-owned routes
  // proxy through transparently instead of 404-ing on Next.js.
  //
  // DO NOT remove this block as "duplication with Caddy". The dev workflow
  // relies on same-origin requests: SameSite=Lax session cookies are only
  // attached to fetches against the same origin Next.js serves on
  // (localhost:3000). Going cross-origin to localhost:4000 would silently
  // log dev users out on every authenticated fetch. Same-origin via this
  // rewrite is what keeps cookies attached and the CSRF posture sane in
  // local dev. The parity risk with the Caddyfile (drift between this
  // list and the Caddyfile route table) is the lesser evil.
  //
  // Reuses INTERNAL_API_URL (already wired in docker-compose at
  // http://api:4000) — same target the RSC layer uses for server→api
  // calls, so we don't grow another env var for the same address.
  async rewrites() {
    const apiUpstream = process.env.INTERNAL_API_URL ?? "http://api:4000";
    return {
      beforeFiles: [
        // Lives on NestJS, but Next.js's `/api/auth/[...all]` Better Auth
        // catch-all would otherwise swallow it — beforeFiles takes priority
        // over filesystem routes.
        {
          source: "/api/auth/change-password",
          destination: `${apiUpstream}/api/auth/change-password`,
        },
      ],
      afterFiles: [
        // Anything under `/api/*` the filesystem didn't claim falls through
        // to NestJS. Next.js's own routes (`/api/auth/[...all]`, `/api/health`,
        // `/api/webhooks/meta/*`) win because afterFiles only fires when no
        // filesystem route matches.
        { source: "/api/:path*", destination: `${apiUpstream}/api/:path*` },
        // Canonical post-migration webhook path. NestJS owns it; this lets
        // the path also work when Next.js receives it directly (no-Caddy
        // dev, or a tunnel that happens to terminate at :3000).
        { source: "/webhooks/:path*", destination: `${apiUpstream}/webhooks/:path*` },
      ],
    };
  },
};

export default nextConfig;
