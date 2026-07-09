import { defineConfig } from "@playwright/test";

/**
 * Meta-channels BACKEND e2e suite (Messenger / Instagram / WhatsApp on the wire).
 *
 * Separate from the main config because it needs its own stack — a mock Graph
 * server + an isolated api on :4001 (see tests/e2e/_mock/meta-stack.ts). These
 * specs drive the api directly over HTTP + Prisma (no browser, no login): the
 * webhook path is HMAC-authed and the send path is API-key-authed, both
 * session-independent. globalSetup boots the stack; globalTeardown stops it.
 *
 *   pnpm test:e2e:meta        (Postgres + Redis must be up; the maintainer's
 *                              :4000 stack does NOT need to be running)
 */
export default defineConfig({
  testDir: "./tests/e2e/meta-channels",
  globalSetup: "./tests/e2e/_mock/meta-stack.ts",
  globalTeardown: "./tests/e2e/_mock/meta-stack-teardown.ts",
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? "github" : "list",
  // No browser projects — the specs use node fetch + the Prisma client. A single
  // default project runs them in-process.
  projects: [{ name: "meta-backend" }],
});
