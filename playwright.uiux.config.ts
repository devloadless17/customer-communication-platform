import { defineConfig, devices } from "@playwright/test";

/**
 * B-M6 — the UI/UX rubric suite.
 *
 * NON-CI by design, exactly like the `@pressure` harness: this is an AUDIT that
 * produces findings, not a gate that blocks a deploy. Accessibility and layout
 * regressions want a human reading the report; wiring them to `ship` would
 * either block releases on cosmetic drift or (worse) get its thresholds relaxed
 * until it asserted nothing.
 *
 *   pnpm test:e2e:uiux
 *
 * Runs against the DEV stack by default (web :3000 + api :4000), because the
 * prod-local Caddy stack does not fit on this box — see the e2e memory. Override
 * with E2E_BASE_URL when running elsewhere.
 *
 * The rubric each surface is held to lives in tests/e2e/uiux/rubric.spec.ts.
 */
export default defineConfig({
  testDir: "./tests/e2e/uiux",
  // Serial: the audit drives one browser through many viewport/theme
  // permutations per surface, and parallel workers against one dev stack just
  // produce Next-compilation noise that reads as layout failure.
  workers: 1,
  fullyParallel: false,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  forbidOnly: !!process.env.CI,
  reporter: [["list"], ["html", { outputFolder: "playwright-report-uiux", open: "never" }]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    // A layout bug is far easier to judge from the picture than from a
    // selector assertion, so keep the artifacts on failure.
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    actionTimeout: 10_000,
    navigationTimeout: 45_000,
  },
  projects: [
    {
      name: "setup",
      testDir: "./tests/e2e",
      testMatch: /(auth|app-admin)\.setup\.ts/,
    },
    {
      name: "uiux",
      use: {
        ...devices["Desktop Chrome"],
        storageState: "tests/e2e/.auth/app-admin.json",
      },
      dependencies: ["setup"],
    },
  ],
});
