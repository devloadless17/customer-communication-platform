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
import { ffmpegSlotStats } from "../lib/media/ffmpeg-slots";
import { widgetVisitorSocketCount } from "../webchatwidget/widget-metrics";
import { computeDegradations, type PgPoolReport } from "./health-thresholds";

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
  /** ffmpeg subprocess semaphore (lib/media/ffmpeg-slots.ts). A persistently
   *  non-zero `queued` means media work is backing up behind the cap —
   *  thumbnails and voice-note transcodes start degrading before anything else
   *  here turns red. Reported only; never affects ok/503. */
  ffmpeg: { active: number; queued: number };
  /**
   * Human-readable list of breached thresholds — empty when healthy.
   *
   * WHY: every field above is a raw number, and until now a reader had to know
   * all of their safe ranges to tell a healthy report from a dying one. Worse,
   * ok/503 deliberately ignores most of them (a wedged outbox, an exhausted
   * pool, and a failing queue all keep `ok:true` by design, so a degraded api
   * stays in Caddy's rotation instead of dropping inbound webhooks). That is
   * the right routing decision and a terrible alerting one: the process knows
   * it is in trouble and says 200.
   *
   * This field closes that gap. Any uptime monitor that can assert on a JSON
   * body gets a single thing to watch — alert when `degraded` is non-empty —
   * without encoding a dozen thresholds in the monitor's config. The
   * HealthWatchdogService logs the same transitions for log-based alerting.
   */
  degraded: string[];
}

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
    const pgPool: PgPoolReport = {
      max: poolStats.max,
      total: poolStats.total,
      idle: poolStats.idle,
      waiting: poolStats.waiting,
      saturationPercent,
    };
    const jobFailures = getJobFailureMetrics();
    const ffmpeg = ffmpegSlotStats();
    const report: HealthReport = {
      ok: dbOk && redisOk,
      db: dbOk,
      redis: redisOk,
      uptimeSec: Math.floor(process.uptime()),
      pgPool,
      jobFailures,
      outboxLag,
      widgetVisitorSockets: widgetVisitorSocketCount(),
      ffmpeg,
      degraded: computeDegradations({
        db: dbOk,
        redis: redisOk,
        pgPool,
        outboxLag,
        jobFailures,
        ffmpeg,
      }),
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
