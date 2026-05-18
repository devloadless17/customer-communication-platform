import { existsSync } from "node:fs";

import { defineConfig, env } from "prisma/config";

// Prisma 7: `url` was removed from the schema datasource block. Migrate
// reads the connection URL from this config; PrismaClient runtime reads it
// via the @prisma/adapter-pg pool (see apps/api/src/db/db.service.ts and
// apps/web/src/lib/db.ts).
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
  datasource: {
    url: env("DATABASE_URL"),
  },
  migrations: {
    seed: "tsx prisma/seeds/seed.ts",
  },
});
