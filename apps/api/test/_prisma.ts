import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

/**
 * THE Prisma client for specs — one definition, mirroring `DbService`.
 *
 * A spec that builds its own `new PrismaClient({ adapter })` inherits Prisma's
 * 5-SECOND interactive-transaction default, while the app runs on 15s
 * (db.service.ts). That difference is not cosmetic: it makes a spec exercise a
 * configuration that does not exist in production, in both directions.
 *
 *   - FALSE RED. Anything holding an interactive transaction across real work
 *     (ticket creation's row-locked number allocation, the message-flag
 *     mutations) fails at 5s on a loaded machine with `P2028 ... the timeout
 *     for this transaction was 5000 ms`. It reads exactly like an application
 *     bug and is not one. This already happened twice: once on tickets (fixed
 *     by hand-copying the options into that ONE spec) and again on
 *     message-flags, which is what turned `pnpm test` red and produced this
 *     file.
 *   - FALSE GREEN. A transaction that legitimately takes 8s passes in prod and
 *     can never be observed here, because the spec kills it first.
 *
 * The fix for the tickets failure was correct but was applied as a copy into
 * two spec files out of twenty-four. Hand-copied config drifts — that is the
 * whole reason this codebase funnels rules through one definition — so the
 * options live here and specs import the factory.
 *
 * `connectionString` is read per call so a spec that loads `.env` after import
 * still gets the right database.
 */
export function createTestPrismaClient(): PrismaClient {
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
    // MIRRORS DbService — keep the two in lockstep. See the header for what
    // diverging costs.
    transactionOptions: { timeout: 15_000, maxWait: 5_000 },
  }) as unknown as PrismaClient;
}
