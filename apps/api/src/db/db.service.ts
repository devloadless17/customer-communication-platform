import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { Pool } from "pg";

import { setSharedDb } from "@/lib/db";

/**
 * Nest-managed Prisma client — the SINGLE source of truth for the api
 * process's database pool.
 *
 * Prisma 7 dropped the binary engine; the connection is owned by a `pg.Pool`
 * fronted by `@prisma/adapter-pg`. The pool size below covers REST + Socket.io
 * + BullMQ workers all in this process; revisit when adding a second app
 * instance.
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
  private readonly pool: Pool;

  constructor() {
    // Pool sized for the actual workload sharing one process: REST handlers,
    // Socket.io gateway, 5 BullMQ workflow workers, 5 broadcast senders,
    // 4 webhook fan-out, sweepers, Better Auth lookups. pg's default of 10
    // starves REST under any sustained background activity. 25 leaves room
    // for headroom and matches single-VPS Postgres limits (default 100).
    // `statement_timeout` is a runaway-query guard; without it a stuck query
    // can pin a pool slot indefinitely. `idleTimeoutMillis` reclaims idle
    // connections so transient bursts don't permanently grow the pool.
    //
    // 30s ceiling accommodates the longest legitimate transactions —
    // primarily the inbound-ingest Serializable tx (multi-step writer +
    // outbox row + Contact bump) under load, and the once-daily
    // contact-last-inbound-drift sweeper's set-based UPDATE on large
    // accounts. 10s tripped 503s on webhook ingest during contact-import
    // bursts even though the retry was structurally safe.
    // Pool sizing for one api process under realistic concurrent load:
    //   REST handlers + Socket.io gateway lookups + ~5 BullMQ workflow
    //   workers + ~5 message-send workers + ~10 webhook-deliver workers +
    //   broadcast runner + ~14 sweepers + bus subscribers (audit + analytics
    //   + workflow-dispatch + outbound-webhooks) + outbox drainer at
    //   concurrency:8 per batch + Better Auth + ingest 8-lane Serializable.
    //   Steady-state at 10 msg/sec routinely holds 18-22 slots; one bulk
    //   import or one broadcast pre-flight can push to 25 and queue.
    // 50 leaves headroom for the burst without sitting unused at idle.
    // `connectionTimeoutMillis` fail-fast so a starved pool surfaces as
    // 503 rather than blocking forever (acquisition hang would otherwise
    // pin Node's event loop on every request).
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 50,
      idleTimeoutMillis: 30_000,
      statement_timeout: 30_000,
      connectionTimeoutMillis: 5_000,
    });
    super({
      adapter: new PrismaPg(pool),
      log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
    });
    this.pool = pool;
  }

  async onModuleInit(): Promise<void> {
    setSharedDb(this);
    await this.$connect();
    this.logger.log("Prisma connected");
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
    await this.pool.end();
    this.logger.log("Prisma disconnected");
  }
}
