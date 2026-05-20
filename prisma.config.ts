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

// `prisma generate` (run via postinstall) doesn't connect to the DB, but
// Prisma 7 still resolves `env(DATABASE_URL)` while loading this config.
// On a fresh clone there's no .env yet — provide a syntactically-valid
// placeholder so `pnpm install` succeeds before .env.example is copied.
// Migrate / studio / app code all run after .env exists, so they get the
// real value via loadEnvFile above.
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL =
    "postgresql://placeholder:placeholder@localhost:5432/placeholder?schema=public";
}

export default defineConfig({
  datasource: {
    url: env("DATABASE_URL"),
  },
  migrations: {
    seed: "tsx prisma/seeds/seed.ts",
  },
});
