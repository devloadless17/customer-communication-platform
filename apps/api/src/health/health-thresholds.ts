import type { JobFailureReport } from "../common/job-failure-metrics";

/**
 * Degradation thresholds, kept in a dependency-light leaf module so BOTH the
 * /health endpoint and the HealthWatchdogService can import them without an
 * import cycle (the watchdog would otherwise pull in the controller, which
 * pulls in DbService, which is where cycles start). Same discipline as
 * webchatwidget/widget-metrics.ts, and for the same reason: a cycle here
 * typechecks clean and crashes at runtime.
 */

export interface PgPoolReport {
  max: number;
  total: number;
  idle: number;
  waiting: number;
  /** (total - idle) / max * 100 — checked-out slots as % of configured max. */
  saturationPercent: number;
}

export interface OutboxLagReport {
  pendingCount: number;
  oldestPendingSec: number | null;
  stale: boolean;
}

/**
 * Thresholds for `degraded`. Chosen to fire BEFORE users notice, not after:
 * a pool at 85% still serves requests but is one burst from queueing them.
 */
const DEGRADED_POOL_SATURATION_PERCENT = 85;
const DEGRADED_POOL_WAITING = 5;
const DEGRADED_FFMPEG_QUEUED = 8;
const DEGRADED_JOB_FAILURES_LAST_HOUR = 25;

/** Pure — shared by the endpoint and the watchdog so both agree by construction. */
export function computeDegradations(report: {
  db: boolean;
  redis: boolean;
  pgPool: PgPoolReport;
  outboxLag: OutboxLagReport;
  jobFailures: Record<string, JobFailureReport>;
  ffmpeg: { active: number; queued: number };
}): string[] {
  const out: string[] = [];
  if (!report.db) out.push("postgres unreachable");
  if (!report.redis) out.push("redis unreachable — queues, workflows and sends are dark");
  if (report.pgPool.saturationPercent >= DEGRADED_POOL_SATURATION_PERCENT) {
    out.push(`db pool ${report.pgPool.saturationPercent}% saturated`);
  }
  if (report.pgPool.waiting >= DEGRADED_POOL_WAITING) {
    out.push(`${report.pgPool.waiting} requests queued for a db connection`);
  }
  if (report.outboxLag.stale) {
    out.push(
      `outbox drainer behind — oldest pending event ${report.outboxLag.oldestPendingSec}s old ` +
        `(${report.outboxLag.pendingCount} pending)`,
    );
  }
  if (report.outboxLag.pendingCount === -1) out.push("outbox lag probe failed");
  if (report.ffmpeg.queued >= DEGRADED_FFMPEG_QUEUED) {
    out.push(`${report.ffmpeg.queued} media jobs queued behind the ffmpeg cap`);
  }
  for (const [queue, stats] of Object.entries(report.jobFailures)) {
    if (stats.failedLastHour >= DEGRADED_JOB_FAILURES_LAST_HOUR) {
      out.push(`${queue}: ${stats.failedLastHour} jobs exhausted retries in the last hour`);
    }
  }
  return out;
}
