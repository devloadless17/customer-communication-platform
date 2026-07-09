import { defineConfig, devices } from "@playwright/test";

/**
 * Pre-deploy e2e suite. Drives a real browser against the prod-imitate
 * stack at http://localhost:8080 (Caddy → web :3000 + api :4000, same-
 * origin, same TLS posture as production minus the Let's Encrypt cert).
 *
 * Bring the stack up FIRST:
 *
 *   pnpm prod:local:detached
 *
 * Then:
 *
 *   pnpm test:e2e
 *
 * The suite is intentionally small (one file, ~10 specs) and fast (~60s
 * total). It is NOT a unit-test surface — it's a "before I deploy,
 * verify the load-bearing user paths still work" gate.
 *
 * Why prod:local and not pnpm dev: dev mode hides real bugs (RSC
 * compile-time noise, useInsertionEffect warnings, etc.) and tolerates
 * client/server-boundary mistakes that crash in a real build. The
 * three P0 server/client-split bugs found 2026-05-26 by an earlier
 * smoke would have NOT been caught had we run against pnpm dev — they
 * only crash when Next.js's build splits the server bundle from the
 * client bundle, which dev mode does lazily and sometimes papers over.
 */
export default defineConfig({
  testDir: "./tests/e2e",
  // The Meta backend suite (tests/e2e/meta-channels) needs its own mock-Graph
  // stack + isolated api — it runs via playwright.meta.config.ts, never here.
  testIgnore: "**/meta-channels/**",
  // Most paths are sequential because they share login state + a single
  // superadmin account. Sharding across workers would require a per-worker
  // user, not worth it at this scale.
  workers: 1,
  // Each spec is generous; the suite ceiling is what we really care about.
  timeout: 60_000,
  expect: { timeout: 10_000 },
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:8080",
    // Caddy in prod:local uses a self-signed cert at first deploy until
    // Let's Encrypt provisions; the local stack uses HTTP on :8080 anyway
    // (no TLS termination locally). The flag is belt-and-braces.
    ignoreHTTPSErrors: true,
    // Screenshots + traces on failure — invaluable for debugging the rare
    // race that only repros in CI. Empty on success so the repo stays clean.
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "retain-on-failure",
    // Headless by default; flip via `pnpm test:e2e --headed` to watch the
    // browser drive itself when debugging locally.
    headless: true,
    viewport: { width: 1280, height: 800 },
    // Realistic UA so any user-agent-gated paths (rare here, but
    // future-proofing) don't take a fallback branch.
    actionTimeout: 8_000,
    navigationTimeout: 15_000,
  },
  projects: [
    // One-time auth: drives the real login flow ONCE per role and writes the
    // storageState files. Two roles since the org-approval gate split the
    // surfaces (2026-06-10):
    //   - app-admin.json  → a regular admin in the seeded team (customer app)
    //   - superadmin.json → the platform super-admin (platform shell only)
    // Every other spec depends on these and reuses the saved state.
    {
      name: "setup",
      testMatch: /(auth|app-admin)\.setup\.ts/,
    },
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        // Default to the regular admin — the bulk of specs drive the customer
        // app. Platform specs override with the superadmin storageState via
        // `test.use({ storageState: "tests/e2e/.auth/superadmin.json" })`.
        storageState: "tests/e2e/.auth/app-admin.json",
      },
      dependencies: ["setup"],
    },
  ],
});
