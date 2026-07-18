import {
  Controller,
  Get,
  ServiceUnavailableException,
} from "@nestjs/common";

import { DbService } from "../db/db.service";
import {
  getJobFailureMetrics,
  type JobFailureReport,
} from "../common/job-failure-metrics";
import { getRedisConnection } from "../lib/workflows/queue";
import { widgetVisitorSocketCount } from "../webchatwidget/widget-metrics";

interface PgPoolReport {
  max: number;
  total: number;
  idle: number;
  waiting: number;
  /** (total - idle) / max * 100 — checked-out slots as % of configured max. */
  saturationPercent: number;
}

interface HealthReport {
  ok: boolean;
  db: boolean;
  redis: boolean;
  uptimeSec: number;
  pgPool: PgPoolReport;
  /** Per-queue terminal (retries-exhausted) job-failure counters — the soft
   *  DLQ signal. In-process, resets on restart. Empty when nothing has failed.
   *  Does NOT affect ok/503 (a failed backlog must not pull the api from
   *  rotation) — purely operator visibility. */
  jobFailures: Record<string, JobFailureReport>;
  /** Transactional-outbox backlog (obs-1). The whole event surface (realtime,
   *  audit, analytics, workflows, webhooks) rides the single in-process drainer;
   *  a wedge leaves rows `publishedAt IS NULL` accumulating behind a green
   *  /health. Surfaced here so an external monitor can alarm on it. `stale` =
   *  oldest pending row older than the WARN threshold. Does NOT 503 (same
   *  posture as jobFailures). `pendingCount: -1` = the probe itself failed. */
  outboxLag: {
    pendingCount: number;
    oldestPendingSec: number | null;
    stale: boolean;
  };
  /** Live website-chat visitor sockets on the "/widget" namespace. The widget is
   *  embedded on customers' own sites, so when it breaks THEY notice before we do
   *  and there is otherwise no server-side signal at all — every other probe here
   *  stays green while the channel is dark. Also the capacity number to watch:
   *  visitor sockets are the fastest-growing use of this process's memory.
   *  Reported only; never affects ok/503. */
  widgetVisitorSockets: number;
}

/**
 * Public health endpoint — no auth. Used by:
 *   - Docker compose + Dockerfile healthcheck (`wget … || exit 1` — exits
 *     non-zero on a 5xx, so a down dependency flips the container unhealthy)
 *   - Caddy upstream availability check
 *   - Manual smoke during deploys (greps the body for `"ok":true`)
 *
 * Probes BOTH Postgres and Redis so a half-down dependency surfaces
 * immediately instead of waiting for a real request to fail.
 *
 * Returns HTTP 200 when **Postgres** is up, **503 only when Postgres is down**.
 * Redis is reported in the body (`redis:false` → `ok:false`) but does NOT 503:
 * a Redis outage degrades queues / workflows / sends, yet the api still serves
 * reads, realtime, and Postgres-only WEBHOOK INGEST — so it must stay in
 * Caddy's rotation. 503ing on a Redis blip would make Caddy stop routing Meta
 * webhooks that would otherwise succeed, silently dropping inbound messages.
 * The body keeps the full report so the deploy smoke's `"ok":true` grep still
 * fails a Redis-down deploy (you don't want to ship with workers dark), while
 * the continuous Docker/Caddy probe only reacts to a wedged Postgres.
 */
@Controller("health")
export class HealthController {
  constructor(private readonly db: DbService) {}

  /** Oldest pending outbox row past this → `stale: true` (operator alarm). The
   *  drainer polls every 100ms, so anything older than a few seconds means it is
   *  not keeping up or is wedged. */
  private static readonly OUTBOX_STALE_SEC = 30;

  @Get()
  async check(): Promise<HealthReport> {
    const [dbOk, redisOk, outboxLag] = await Promise.all([
      this.pingDb(),
      this.pingRedis(),
      this.probeOutboxLag(),
    ]);
    const poolStats = this.db.getPoolStats();
    const saturationPercent =
      poolStats.max > 0
        ? Math.round(((poolStats.total - poolStats.idle) / poolStats.max) * 100)
        : 0;
    const report: HealthReport = {
      ok: dbOk && redisOk,
      db: dbOk,
      redis: redisOk,
      uptimeSec: Math.floor(process.uptime()),
      pgPool: {
        max: poolStats.max,
        total: poolStats.total,
        idle: poolStats.idle,
        waiting: poolStats.waiting,
        saturationPercent,
      },
      jobFailures: getJobFailureMetrics(),
      outboxLag,
      widgetVisitorSockets: widgetVisitorSocketCount(),
    };
    if (!dbOk) {
      // 503 ONLY when Postgres — the routing-critical dependency — is down. A
      // Redis outage still reports ok:false in the body (so the deploy smoke's
      // `"ok":true` grep fails a Redis-down deploy), but it must NOT 503: the
      // api still serves reads, realtime, and Postgres-only webhook ingest, so
      // taking it out of Caddy's rotation would silently drop inbound Meta
      // messages. Workers queue and resume when Redis returns.
      // ServiceUnavailableException serializes its payload as the JSON body, so
      // the per-dependency flags stay visible to operators.
      throw new ServiceUnavailableException(report);
    }
    return report;
  }

  // Bound each probe so /health always responds fast and reports the down
  // dependency as `false` — without this, a FROZEN (not refused) dependency
  // would hang on ioredis's 30s commandTimeout / the pg socket, and /health
  // would block well past the 3s container-healthcheck timeout. 2s is
  // comfortably under that probe timeout while tolerating a slow-but-alive DB.
  private static readonly PROBE_TIMEOUT_MS = 2_000;

  private async withTimeout(probe: Promise<boolean>): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(
        () => resolve(false),
        HealthController.PROBE_TIMEOUT_MS,
      );
    });
    try {
      return await Promise.race([probe, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async pingDb(): Promise<boolean> {
    return this.withTimeout(
      (async () => {
        try {
          await this.db.$queryRaw`SELECT 1`;
          return true;
        } catch {
          return false;
        }
      })(),
    );
  }

  private async probeOutboxLag(): Promise<HealthReport["outboxLag"]> {
    const failed = { pendingCount: -1, oldestPendingSec: null, stale: false };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<HealthReport["outboxLag"]>((resolve) => {
      timer = setTimeout(() => resolve(failed), HealthController.PROBE_TIMEOUT_MS);
    });
    const probe = (async (): Promise<HealthReport["outboxLag"]> => {
      try {
        // Served by the partial drainer-pending index, so count is cheap.
        const rows = await this.db.$queryRaw<
          Array<{ pending: number; oldest: number | null }>
        >`
          SELECT count(*)::int AS pending,
                 EXTRACT(EPOCH FROM (now() - MIN("createdAt")))::int AS oldest
          FROM   "OutboundEvent"
          WHERE  "publishedAt" IS NULL AND "failedAt" IS NULL
        `;
        const row = rows[0] ?? { pending: 0, oldest: null };
        const oldestPendingSec = row.oldest ?? null;
        return {
          pendingCount: row.pending,
          oldestPendingSec,
          stale:
            oldestPendingSec != null &&
            oldestPendingSec > HealthController.OUTBOX_STALE_SEC,
        };
      } catch {
        return failed;
      }
    })();
    try {
      return await Promise.race([probe, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async pingRedis(): Promise<boolean> {
    return this.withTimeout(
      (async () => {
        try {
          const reply = await getRedisConnection().ping();
          return reply === "PONG";
        } catch {
          return false;
        }
      })(),
    );
  }
}
