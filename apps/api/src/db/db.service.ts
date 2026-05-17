import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";

import { setSharedDb } from "@/lib/db";

/**
 * Nest-managed Prisma client — the SINGLE source of truth for the api
 * process's database pool.
 *
 * The framework-agnostic helpers under `apps/api/src/lib/` still import
 * `{ db }` from `@/lib/db` (a Proxy that delegates here). On boot we call
 * `setSharedDb(this)` so every path — DI-injected services, module-load
 * Better Auth, BullMQ worker callbacks, sweepers — uses ONE PrismaClient and
 * ONE connection pool. See `apps/api/src/lib/db.ts` for the rationale on
 * keeping the Proxy indirection instead of fully parameterising every lib
 * function (deferred refactor).
 */
@Injectable()
export class DbService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DbService.name);

  constructor() {
    super({
      log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
    });
  }

  async onModuleInit(): Promise<void> {
    setSharedDb(this);
    await this.$connect();
    this.logger.log("Prisma connected");
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
    this.logger.log("Prisma disconnected");
  }
}
