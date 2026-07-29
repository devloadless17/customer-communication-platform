// Note: no `server-only` import — the NestJS api process loads this on boot,
// outside the Next bundler context (same posture as the sweepers).

import type { PrismaClient } from "@prisma/client";

import {
  DEGRADED_BROADCAST_PAUSED_MIN,
  type StuckBroadcastReport,
} from "./health-thresholds";

/**
 * Probe for broadcasts parked `paused` that auto-recovery has not cleared.
 *
 * WHY THIS EXISTS: the broadcast runner is not a BullMQ job, so none of its
 * failures reach `jobFailures` in the health report. The permanent-error
 * breaker, the sustained-rate-limit pause and the "credentials dead at fire
 * time" park all terminate in a `console.warn` plus a socket frame aimed at a
 * browser tab nobody is watching at 3am. A campaign could sit paused
 * indefinitely with no operator signal whatsoever.
 *
 * The drift sweeper now auto-resumes transient causes on a 10-minute cooldown,
 * which means a broadcast STILL paused well past that is genuinely stuck:
 * either a cause that keeps re-tripping, or a `template` pause, which is
 * deliberately never auto-resumed because only an operator can fix it at Meta.
 * Both need a human, and this is what tells them.
 *
 * Deliberately cheap — one indexed count + one ordered read, both riding
 * `@@index([status, pausedAt])`. It runs on every /health hit and every
 * watchdog tick, so it must stay O(index seek), never a table scan.
 */
export async function probeStuckBroadcasts(
  db: PrismaClient,
  thresholdMin: number,
  /**
   * Wall-clock ceiling, mirroring `probeRedisMemory(redis, timeoutMs)`.
   *
   * WHY IT IS NOT OPTIONAL-BY-OMISSION. `catch` covers a query that FAILS; it
   * does nothing for one that merely takes a long time, and this probe runs on
   * every `/health` hit — which is the api container's Docker healthcheck
   * (`docker-compose.yml`, `timeout: 3s`, `retries: 3`), and the deploy gate
   * reads `docker inspect .State.Health.Status`. Unbounded, a saturated pg pool
   * (the exact moment you least want it) makes this wait behind pool acquisition
   * up to the 30s `statement_timeout`, wget times out, the api reads unhealthy,
   * and a perfectly good release gets auto-rolled-back. Every sibling probe in
   * all three callers is already bounded at 2s for precisely this reason; this
   * one was the exception.
   *
   * On timeout it degrades exactly like the catch does — an all-clear, which is
   * the same posture `outboxLag` takes: /health's job is to report, and a probe
   * that cannot answer must not take the whole report down with it.
   */
  timeoutMs?: number,
): Promise<StuckBroadcastReport> {
  const cutoff = new Date(Date.now() - thresholdMin * 60_000);
  const allClear: StuckBroadcastReport = { count: 0, oldestPausedMin: null, reasons: [] };
  if (timeoutMs && timeoutMs > 0) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<StuckBroadcastReport>((resolve) => {
      timer = setTimeout(() => resolve(allClear), timeoutMs);
    });
    try {
      return await Promise.race([probeStuckBroadcasts(db, thresholdMin), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  try {
    const stuck = await db.broadcast.findMany({
      where: { status: "paused", pausedAt: { lte: cutoff } },
      select: { pausedAt: true, pausedReason: true },
      orderBy: { pausedAt: "asc" },
      // Bounded: we only need the count and the oldest few reasons, and an
      // unbounded read here would be a scan on a bad day.
      take: 50,
    });
    const first = stuck[0];
    if (!first) return { count: 0, oldestPausedMin: null, reasons: [] };
    const oldest = first.pausedAt?.getTime() ?? Date.now();
    return {
      count: stuck.length,
      oldestPausedMin: Math.floor((Date.now() - oldest) / 60_000),
      reasons: [...new Set(stuck.map((b) => b.pausedReason ?? "unknown"))],
    };
  } catch {
    // A probe failure must never take down /health — the endpoint's job is to
    // report, and a false "all clear" here is less harmful than a 500 that
    // makes the whole report unavailable. Mirrors how outboxLag degrades.
    return { count: 0, oldestPausedMin: null, reasons: [] };
  }
}

/**
 * Alert threshold in minutes. Re-exported from the degradation module rather
 * than redeclared, so the value the probe SELECTS on and the value the
 * degradation check COMPARES against cannot drift apart — a probe that looked
 * back further than the alert fires would report rows the check then ignores.
 */
export const STUCK_BROADCAST_PROBE_MIN = DEGRADED_BROADCAST_PAUSED_MIN;
