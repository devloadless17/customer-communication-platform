import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";

import { getJobFailureMetrics } from "../common/job-failure-metrics";
import { DbService } from "../db/db.service";
import { ffmpegSlotStats } from "../lib/media/ffmpeg-slots";
import { getRedisConnection } from "../lib/workflows/queue";
import { computeDegradations, type OutboxLagReport } from "./health-thresholds";
import { probeRedisMemory } from "./redis-memory";
import { probeStuckBroadcasts, STUCK_BROADCAST_PROBE_MIN } from "./stuck-broadcasts";

/**
 * Periodic self-check that turns the /health report into a LOG SIGNAL.
 *
 * The gap this fills: /health computes a genuinely good picture of the
 * process's condition — pool saturation, outbox lag, queue failures, media
 * backlog — and then, by design, returns 200 for nearly all of it. That is
 * correct for routing (a degraded api must stay in Caddy's rotation rather
 * than drop inbound webhooks) and useless for alerting: nothing polls the
 * endpoint, and nothing would notice if it did, because the status code stays
 * green while the system slides.
 *
 * So the process watches itself. Every 60s it recomputes the same
 * `degraded` list the endpoint returns and logs on TRANSITION — entering
 * degraded, changing which conditions are breached, and recovering. Two
 * greppable prefixes, `HEALTH DEGRADED` and `HEALTH RECOVERED`, so a log
 * drain or `docker logs | grep` alarm needs no threshold config of its own.
 *
 * Transitions, not levels: a broken pool would otherwise emit 1,440 identical
 * lines a day and train everyone to ignore it. A still-degraded state is
 * re-stated once an hour so a long outage doesn't scroll out of sight.
 *
 * This does NOT replace external uptime monitoring — a process that has
 * crashed or is unreachable cannot report on itself, which is precisely the
 * case an external check catches. It is the half we can build from inside.
 *
 * Cost: one `SELECT 1`, one Redis PING, one indexed outbox count per minute.
 */
@Injectable()
export class HealthWatchdogService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger("HealthWatchdog");
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastSignature = "";
  private lastReportedAt = 0;
  private ticking = false;

  private static readonly INTERVAL_MS = 60_000;
  /**
   * Per-probe bound, mirroring the endpoint's. Load-bearing, not defensive
   * garnish: the failure this watchdog exists to catch is a WEDGED dependency,
   * and a wedged (as opposed to refused) Postgres or Redis does not reject —
   * it hangs on the socket until ioredis's 30s commandTimeout, or forever.
   * Unbounded, the tick that finally has something to report would be the one
   * that never finishes, and the watchdog would go silent exactly when it
   * matters. A timed-out probe reports the dependency as down, which is the
   * correct reading of "did not answer in 2 seconds".
   */
  private static readonly PROBE_TIMEOUT_MS = 2_000;
  /** Re-state an unchanged degraded condition at most this often. */
  private static readonly RESTATE_MS = 60 * 60_000;
  /** Same threshold the endpoint uses for `outboxLag.stale`. */
  private static readonly OUTBOX_STALE_SEC = 30;

  constructor(private readonly db: DbService) {}

  onModuleInit(): void {
    // unref so a shutting-down process is never held open by this timer.
    this.timer = setInterval(() => {
      void this.tick();
    }, HealthWatchdogService.INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    // setInterval does not wait for the previous tick. Even with the probe
    // bounds above, a slow tick must not stack: overlapping ticks would race
    // on lastSignature and could log a recovery and a degradation out of order.
    if (this.ticking) return;
    this.ticking = true;
    try {
      const [dbOk, redisOk, redisMemory, outboxLag, stuckBroadcasts] = await Promise.all([
        this.pingDb(),
        this.pingRedis(),
        probeRedisMemory(getRedisConnection(), HealthWatchdogService.PROBE_TIMEOUT_MS),
        this.probeOutboxLag(),
        probeStuckBroadcasts(this.db, STUCK_BROADCAST_PROBE_MIN),
      ]);
      const poolStats = this.db.getPoolStats();
      const degraded = computeDegradations({
        db: dbOk,
        redis: redisOk,
        pgPool: {
          max: poolStats.max,
          total: poolStats.total,
          idle: poolStats.idle,
          waiting: poolStats.waiting,
          saturationPercent:
            poolStats.max > 0
              ? Math.round(((poolStats.total - poolStats.idle) / poolStats.max) * 100)
              : 0,
        },
        outboxLag,
        jobFailures: getJobFailureMetrics(),
        ffmpeg: ffmpegSlotStats(),
        stuckBroadcasts,
        // Same watermark as the /health endpoint — under noeviction PING stays
        // green to 100% while enqueues fail, so the proactive alert MUST key off
        // memory, not reachability.
        redisMemory,
      });

      const signature = degraded.join(" | ");
      const now = Date.now();
      if (signature === this.lastSignature) {
        if (
          signature !== "" &&
          now - this.lastReportedAt >= HealthWatchdogService.RESTATE_MS
        ) {
          this.lastReportedAt = now;
          this.logger.error(`HEALTH DEGRADED (ongoing): ${signature}`);
        }
        return;
      }

      this.lastSignature = signature;
      this.lastReportedAt = now;
      if (signature === "") {
        this.logger.log("HEALTH RECOVERED: all monitored thresholds back within range");
      } else {
        this.logger.error(`HEALTH DEGRADED: ${signature}`);
      }
    } catch (err) {
      // Never let the watchdog itself become a failure source.
      this.logger.warn(
        `watchdog tick failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.ticking = false;
    }
  }

  /** Resolve to `fallback` if `probe` hasn't settled within the probe bound. */
  private async bounded<T>(probe: Promise<T>, fallback: T): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<T>((resolve) => {
      timer = setTimeout(
        () => resolve(fallback),
        HealthWatchdogService.PROBE_TIMEOUT_MS,
      );
    });
    try {
      return await Promise.race([probe, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async pingDb(): Promise<boolean> {
    return this.bounded(
      (async () => {
        try {
          await this.db.$queryRaw`SELECT 1`;
          return true;
        } catch {
          return false;
        }
      })(),
      false,
    );
  }

  private async pingRedis(): Promise<boolean> {
    return this.bounded(
      (async () => {
        try {
          const pong = await getRedisConnection().ping();
          return pong === "PONG";
        } catch {
          return false;
        }
      })(),
      false,
    );
  }

  /** Same raw query the endpoint runs — it is served by the partial
   *  drainer-pending index, which a Prisma count() on publishedAt alone would
   *  miss (the index is partial on `failedAt IS NULL` too). */
  private async probeOutboxLag(): Promise<OutboxLagReport> {
    return this.bounded(this.probeOutboxLagUnbounded(), {
      pendingCount: -1,
      oldestPendingSec: null,
      stale: false,
    });
  }

  private async probeOutboxLagUnbounded(): Promise<OutboxLagReport> {
    try {
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
          oldestPendingSec > HealthWatchdogService.OUTBOX_STALE_SEC,
      };
    } catch {
      return { pendingCount: -1, oldestPendingSec: null, stale: false };
    }
  }
}
