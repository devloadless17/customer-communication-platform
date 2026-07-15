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
  },
  resolve: {
    alias: {
      "@": path.join(root, "src"),
      "@ccp/shared": path.join(root, "../../packages/shared/src"),
    },
  },
});
