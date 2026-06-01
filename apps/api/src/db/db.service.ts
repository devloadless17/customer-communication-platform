import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { Pool } from "pg";

import { setSharedDb } from "@/lib/db";

/** Below this many idle connections, log a WARN (pool nearing saturation). */
const POOL_LOW_IDLE_THRESHOLD = 5;
/** Throttle: at most one WARN per state per this many ms. */
const POOL_WARN_THROTTLE_MS = 30_000;
/** Poll cadence for pool stats. */
const POOL_POLL_INTERVAL_MS = 10_000;

export interface PoolStats {
  /** Configured max pool size. */
  max: number;
  /** Total clients currently in the pool (idle + checked out). */
  total: number;
  /** Idle clients currently in the pool. */
  idle: number;
  /** Requests waiting for a client (non-zero = pool saturated). */
  waiting: number;
}

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
  /** Configured max — pg.Pool doesn't expose the original opts after construct. */
  private readonly poolMax: number;
  private poolPollTimer?: NodeJS.Timeout;
  /** Timestamp of last "low idle" warn (throttle key). */
  private lastLowIdleWarnAt = 0;
  /** Timestamp of last "waiting" warn (throttle key). */
  private lastWaitingWarnAt = 0;

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
    const poolMax = 50;
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: poolMax,
      idleTimeoutMillis: 30_000,
      statement_timeout: 30_000,
      connectionTimeoutMillis: 5_000,
    });
    super({
      adapter: new PrismaPg(pool),
      log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
    });
    this.pool = pool;
    this.poolMax = poolMax;
  }

  async onModuleInit(): Promise<void> {
    setSharedDb(this);
    await this.$connect();
    this.logger.log("Prisma connected");
    // Periodic pool observability — pg.Pool emits 'connect' / 'remove' / etc.
    // events but no "request waiting" signal, so poll the public counters
    // (totalCount / idleCount / waitingCount) and warn on near-saturation.
    // Throttled per-state so a sustained busy period doesn't spam logs.
    this.poolPollTimer = setInterval(() => this.checkPoolHealth(), POOL_POLL_INTERVAL_MS);
    this.poolPollTimer.unref?.();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.poolPollTimer) {
      clearInterval(this.poolPollTimer);
      this.poolPollTimer = undefined;
    }
    await this.$disconnect();
    await this.pool.end();
    this.logger.log("Prisma disconnected");
  }

  /**
   * Snapshot of the underlying pg.Pool. Exposed for the /health endpoint so
   * an operator can see saturation in real time without scraping logs.
   */
  getPoolStats(): PoolStats {
    return {
      max: this.poolMax,
      total: this.pool.totalCount,
      idle: this.pool.idleCount,
      waiting: this.pool.waitingCount,
    };
  }

  private checkPoolHealth(): void {
    const stats = this.getPoolStats();
    const now = Date.now();
    // Waiting > 0 is the strongest signal — all `max` clients are checked out
    // and at least one request is blocked acquiring one. Warn first since this
    // implies real latency hits.
    if (stats.waiting > 0 && now - this.lastWaitingWarnAt >= POOL_WARN_THROTTLE_MS) {
      this.lastWaitingWarnAt = now;
      this.logger.warn(
        `pg pool saturated: waiting=${stats.waiting} total=${stats.total}/${stats.max} idle=${stats.idle}`,
      );
      return;
    }
    // Low idle (without waiting yet) is the leading indicator — the pool is
    // near-saturated but hasn't yet started blocking. Useful for catching a
    // sustained burst before it tips into hard contention.
    if (
      stats.idle < POOL_LOW_IDLE_THRESHOLD &&
      stats.total >= this.poolMax * 0.8 &&
      now - this.lastLowIdleWarnAt >= POOL_WARN_THROTTLE_MS
    ) {
      this.lastLowIdleWarnAt = now;
      this.logger.warn(
        `pg pool near saturation: idle=${stats.idle} total=${stats.total}/${stats.max} waiting=${stats.waiting}`,
      );
    }
  }
}
