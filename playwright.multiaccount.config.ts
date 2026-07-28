import { defineConfig } from "@playwright/test";

/**
 * MULTI-ACCOUNT matrix — two accounts on every live channel.
 *
 * Separate from `playwright.meta.config.ts` because the two suites need
 * opposite fixtures. The meta suite's workspace is deliberately SINGLE-account
 * and is the control that proves the one-account experience never regressed;
 * this suite's workspace runs two accounts per channel and is where
 * cross-account leaks are hunted. They share the same stack (mock Graph + an
 * isolated api on :4001), so run them one at a time, not concurrently.
 *
 * Every spec asserts BOTH halves:
 *   POSITIVE — a thing created on account A is attributed to A
 *   NEGATIVE — that same thing is NEVER visible when scoped to B
 * The negative half is the one a happy-path spec never catches, and the one the
 * product actually promises.
 *
 *   pnpm test:e2e:multiaccount
 */
export default defineConfig({
  testDir: "./tests/e2e/multi-account",
  globalSetup: "./tests/e2e/_mock/meta-stack.ts",
  globalTeardown: "./tests/e2e/_mock/meta-stack-teardown.ts",
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? "github" : "list",
  projects: [{ name: "multi-account" }],
});
