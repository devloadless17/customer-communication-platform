import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { Pool } from "pg";

/**
 * Singleton Prisma client.
 *
 * Next.js dev mode hot-reloads server modules — without this guard you'd
 * spawn a new client (and therefore a new connection pool) on every change
 * until Postgres rejects you. The global cache survives reloads.
 *
 * Prisma 7 owns no engine; the pool below is the actual connection holder,
 * cached the same way to survive hot-reloads.
 */

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
  prismaPool?: Pool;
};

// Next.js serves only RSC reads + Better Auth post-migration, so the pool
// here is smaller than the api process (which carries workers + Socket.io +
// webhook fan-out). `statement_timeout` still guards against runaway
// queries pinning a slot.
const pool =
  globalForPrisma.prismaPool ??
  new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 30_000,
    statement_timeout: 10_000,
  });

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter: new PrismaPg(pool),
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = db;
  globalForPrisma.prismaPool = pool;
}
