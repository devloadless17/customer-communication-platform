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
 * CSP intentionally omitted for now — Next.js inline runtime scripts/styles
 * require nonce wiring through every page, which is its own work item. The
 * frame-ancestors directive above is the only CSP piece we need today
 * (clickjacking).
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
  // Custom server (server.ts) replaces Next's default server, so the
  // standalone output pattern from slice 1 is dropped.
  //
  // Router cache: keep dynamic segments (e.g. /inbox/[conversationId]) in the
  // client-side router cache for 60s. Re-clicking a recently-viewed chat is
  // then instant — no Postgres round trip, no loading skeleton — because the
  // rendered RSC payload is served from memory. Socket events keep the cached
  // page fresh while it's on screen, and 60s is short enough that a chat the
  // agent left an hour ago will still refetch on revisit. Default is 0
  // (always re-fetch); 60 trades a small staleness window for instant feel.
  experimental: {
    staleTimes: {
      dynamic: 60,
      static: 300,
    },
  },
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
};

export default nextConfig;
