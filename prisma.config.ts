import { existsSync } from "node:fs";

import { defineConfig } from "prisma/config";

// Replaces the `prisma` block in package.json (deprecated in Prisma 6,
// removed in Prisma 7). The seed command is identical to what was there.
// The schema file lives at the default path (./prisma/schema.prisma), so
// no `schema` field is needed.
//
// Behavior change to be aware of: when prisma.config.ts is present, the
// Prisma CLI STOPS auto-loading .env. Load it explicitly here so local
// `npm run db:migrate`, `db:seed`, `db:studio` keep working. In the
// production container there's no .env file (Docker Compose injects env
// vars directly) so we guard with existsSync — no throw on the VPS.
if (existsSync(".env")) {
  process.loadEnvFile(".env");
}

export default defineConfig({
  migrations: {
    seed: "tsx prisma/seed.ts",
  },
});
