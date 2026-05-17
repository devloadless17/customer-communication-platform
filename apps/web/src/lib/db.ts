import { PrismaClient } from "@prisma/client";

/**
 * Singleton Prisma client.
 *
 * Next.js dev mode hot-reloads server modules — without this guard you'd
 * spawn a new client (and therefore a new connection pool) on every change
 * until Postgres rejects you. The global cache survives reloads.
 */

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = db;
}
