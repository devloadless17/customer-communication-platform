import { PrismaClient } from "@prisma/client";

/**
 * Shared Prisma client handle.
 *
 * The NestJS api process owns ONE Prisma pool. PrismaService extends
 * PrismaClient and is the canonical instance; it calls `setSharedDb(this)` in
 * `onModuleInit` so this module's `db` export resolves to the same instance
 * the DI graph uses.
 *
 * Why a global at all: the framework-agnostic helpers under
 * `apps/api/src/lib/` are called both from NestJS services (where DI is
 * available) and from module-load contexts where DI isn't up yet — most
 * notably Better Auth's `prismaAdapter(db, ...)` at the bottom of
 * `lib/auth/better-auth.ts`, plus a few BullMQ worker callbacks that run
 * detached from the request lifecycle. Threading `db` through every one of
 * those callsites would also touch the StepContext type used by every
 * workflow step, the worker bootstrap, and the broadcast runner — a wide
 * change for a narrow benefit, since at runtime the only thing that matters
 * is that all paths share one pool.
 *
 * The `Proxy` indirection enforces "set before use" — if any code path
 * imports `db` and uses it before PrismaService has booted, we throw with a
 * clear message instead of silently creating a second pool.
 *
 * NOTE: a follow-up refactor can incrementally promote individual lib
 * functions to take `db: PrismaClient` as a parameter. That cleans up the
 * architectural smell without re-introducing the dual-pool bug — every
 * parameterised callsite would just pass the same shared instance through.
 */

let shared: PrismaClient | undefined;

export function setSharedDb(client: PrismaClient): void {
  shared = client;
}

function resolveDb(): PrismaClient {
  if (!shared) {
    throw new Error(
      "lib/db.ts accessed before PrismaService booted. Did a module-load " +
        "import trigger before NestFactory.create()? See " +
        "apps/api/src/prisma/prisma.module.ts.",
    );
  }
  return shared;
}

/**
 * `db` mirrors the singleton API of the previous file so existing callers
 * (`db.contact.findUnique(...)` etc.) keep working unchanged. The Proxy
 * forwards property access to the shared PrismaService instance.
 */
export const db: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, prop, receiver) {
    const client = resolveDb();
    const value = Reflect.get(client as object, prop, receiver);
    return typeof value === "function" ? value.bind(client) : value;
  },
}) as PrismaClient;
