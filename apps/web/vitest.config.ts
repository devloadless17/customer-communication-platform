import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

// Web unit-test harness — mirrors apps/api/vitest.config.ts. First target:
// the inbox thread reducers (the most load-bearing realtime file in the app,
// previously tested only indirectly through Playwright). Pure-function tests
// only — anything needing a DOM or a live socket stays in Playwright.
// Run with: `pnpm --filter @ccp/web exec vitest run`
const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.spec.ts"],
  },
  resolve: {
    alias: {
      "@": path.join(root, "src"),
      "@ccp/shared": path.join(root, "../../packages/shared/src"),
    },
  },
});
