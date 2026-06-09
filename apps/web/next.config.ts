import { resolve } from "node:path";

import { loadEnvConfig } from "@next/env";
import type { NextConfig } from "next";

// Single source of env truth is the repo-root `.env`. `next dev`/`next start`
// run with cwd=apps/web and only auto-load `apps/web/.env*`, so the root file
// is invisible to the web process — the custom `server.ts` that used to load
// it was removed in the NestJS migration, which is why local login started
// throwing "BETTER_AUTH_SECRET must be set". Load the root explicitly here
// (mirrors the api's `node --env-file=../../.env`). Safe under Docker:
// loadEnvConfig never overrides a value already in process.env, so
// compose-injected vars win. Also restores NEXT_PUBLIC_* (e.g. the socket
// client's NEXT_PUBLIC_API_URL) for host dev. Anchored on `__dirname` (always
// apps/web — this file's dir), NOT `process.cwd()`, so it's cwd-independent.
//
// IMPORTANT — this only covers the MAIN process (config eval, `next build`
// NEXT_PUBLIC_* inlining). Next 16 dev runs route handlers in a SEPARATE
// render worker that does NOT re-run this file, so `loadEnvConfig` here never
// reaches it. That worker gets env from Next's OWN native loader, which reads
// `apps/web/.env` — so the `dev`/`start` scripts in package.json symlink
// `apps/web/.env -> ../../.env` (gitignored) to feed it the root file. Without
// that symlink the worker has no DATABASE_URL and every Prisma query fails with
// `SASL: client password must be a string` (pg falls back to a passwordless
// default). Both mechanisms point at the same physical root `.env`.
loadEnvConfig(resolve(__dirname, "../.."));

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
    // `microphone=(self)` — voice notes in the inbox composer call
    // navigator.mediaDevices.getUserMedia. With the empty allowlist `()`,
    // even an in-page same-origin call is policy-blocked, so the browser
    // shows its permission prompt, the user clicks Allow, and getUserMedia
    // still throws NotAllowedError — making the recorder appear permanently
    // stuck on "Microphone permission denied." Same-origin allowlist is
    // safe: X-Frame-Options + frame-ancestors above block embedding, so
    // there's no third-party origin that could inherit this capability.
    // camera/geolocation/interest-cohort stay denied — unused.
    key: "Permissions-Policy",
    value: "camera=(), microphone=(self), geolocation=(), interest-cohort=()",
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
  experimental: {
    // Tree-shake barrel-export packages aggressively. Lucide already gets
    // the targeted treatment via modularizeImports above; this catches
    // the other big shippers — framer-motion (~80KB gzipped barrel),
    // sonner, the radix packages, and @xyflow/react (the workflow canvas
    // — only loaded on /workflows but huge when it lands). Per-symbol
    // resolution drops ~50-150KB off the inbox client bundle. Next 16
    // flags this as experimental-but-recommended; if a "Cannot find
    // module" build error pops up from one of the listed packages,
    // remove that entry as the escape hatch.
    optimizePackageImports: [
      "framer-motion",
      "sonner",
      "@radix-ui/react-avatar",
      "@radix-ui/react-dropdown-menu",
      "@radix-ui/react-scroll-area",
      "@radix-ui/react-separator",
      "@radix-ui/react-slot",
      "@radix-ui/react-tooltip",
      "@xyflow/react",
      "@tanstack/react-virtual",
    ],
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
  // Reuses INTERNAL_API_URL — same target the RSC layer uses for server→api
  // calls, so we don't grow another env var for the same address. In Docker,
  // compose always sets it to http://api:4000 (the service hostname). The
  // fallback below is the HOST-dev value (api on localhost:4000) — matching
  // api-client.ts and the webhook proxy route, both of which already default
  // to 127.0.0.1:4000. Defaulting to "http://api:4000" here broke host dev
  // with EAI_AGAIN since `api` only resolves inside the compose network.
  // Webpack 5's GlobalRuntimeModule emits `new Function('return this')` as a
  // fallback for global-object detection when `globalThis` is unavailable.
  // Even though modern browsers never execute that branch (they short-circuit
  // on `typeof globalThis === 'object'`), the code exists in the bundle and
  // causes a CSP `script-src` violation report. Setting globalObject to 'self'
  // (always valid in browser + worker contexts) makes webpack skip the dynamic
  // detection entirely — no `new Function` in the emitted runtime.
  // Only applies to client bundles; server/edge targets still use 'this'.
  webpack(config, { isServer }) {
    if (!isServer) {
      config.output.globalObject = "self";
    }
    return config;
  },
  async rewrites() {
    const apiUpstream = process.env.INTERNAL_API_URL ?? "http://127.0.0.1:4000";
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
