import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

// Minimal Vitest setup for the AI Assistant acceptance tests. There is no other
// unit-test harness in the repo yet (only Playwright E2E), so this config is
// scoped to apps/api. Run with: `pnpm --filter @ccp/api exec vitest run`
// (add `vitest` as a devDep first: `pnpm --filter @ccp/api add -D vitest`).
const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.spec.ts", "test/**/*.spec.ts"],
    // Much of test/ is integration-style against the SHARED dev database, and
    // a full run executes ~50 files in parallel — under that contention a
    // plain `create` in a beforeAll has been observed to exceed the 5s/10s
    // defaults (three different specs flaked this way on 2026-07-27 before
    // this was centralized). Generous ceilings: the assertions are the tests,
    // not the wall clock, and a genuine hang still fails — just later.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
  resolve: {
    alias: {
      "@": path.join(root, "src"),
      "@ccp/shared": path.join(root, "../../packages/shared/src"),
      // See the stub's header: `server-only` throws on import, which would block
      // testing anything downstream of the envelope-crypto module.
      "server-only": path.join(root, "test/stubs/server-only.ts"),
    },
  },
});
