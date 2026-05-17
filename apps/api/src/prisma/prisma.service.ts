import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";

/**
 * Nest-managed Prisma client.
 *
 * Separate from `lib/db.ts` on purpose: that singleton lives in the Next.js
 * process and owns its own pool (RSC reads, Better Auth, server actions).
 * This one owns the NestJS process's pool. Each process gets its own
 * `connection_limit` budget against the same Postgres.
 *
 * Pool sizing happens via DATABASE_URL `?connection_limit=` (see
 * docker-compose `api` service).
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    super({
      log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log("Prisma connected");
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
    this.logger.log("Prisma disconnected");
  }
}
