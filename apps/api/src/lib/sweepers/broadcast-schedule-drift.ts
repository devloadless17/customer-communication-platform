// Note: no `server-only` import — the NestJS api process loads this on boot
// via @swc-node/register, outside the Next bundler context.

import { db } from "@/lib/db";
import { startBroadcast } from "@/lib/broadcast-runner";
import { enqueueScheduledBroadcast } from "@/lib/broadcasts/schedule-queue";

/**
 * Periodic sweeper that recovers SCHEDULED + QUEUED broadcasts whose firing
 * stranded between deploys. Without it, the ONLY recovery path is the boot
 * reconciler (BroadcastsService.onModuleInit) — i.e. the next deploy/restart,
 * which for a pilot can be days. Two stranding classes (both from the audit):
 *
 *   - `scheduled` rows past their `scheduledAt` whose BullMQ fire job never
 *     ran. The fire job has `attempts: 2, backoff: 5s` (schedule-queue.ts); a
 *     ~10s Postgres/Redis blip exactly at fire time exhausts both attempts and
 *     the worker's `failed` listener only logs — the row stays `scheduled` and
 *     nothing ever fires it. Redis eviction / a non-persistent restart also
 *     drops the delayed job while the row still says `scheduled`.
 *     Recovery: re-enqueue the fire job (idempotent jobId `bcast-<id>`).
 *
 *   - `queued` rows that never got a runner. A partial scheduled-fire flips
 *     scheduled→queued then dies before `startBroadcast` claims it; the
 *     per-team-cap defer / create→claim window can strand one too. The
 *     scheduled-fire `fireScheduled` now self-heals a still-`queued` row when
 *     its CAS misses, but only if the job runs at all — this sweep is the
 *     backstop for the row whose job is gone entirely.
 *     Recovery: re-fire `startBroadcast` (idempotent — runBroadcast's own
 *     queued→running CAS + in-process inFlightRuns dedupe a row already running).
 *
 * Both recoveries are idempotent, so a row a racing path already advanced is a
 * no-op. A grace window keeps the sweep from racing the legitimate fire/claim
 * of a freshly-created row.
 *
 * Interval: 60s — short enough to recover within a minute, cheap enough to run
 * forever (two indexed status scans, bounded per tick).
 */

const SWEEP_INTERVAL_MS = 60_000;
// Grace window — don't touch a row whose scheduledAt/updatedAt is within this
// of now, so we don't race the worker's own fire or the create-path's claim.
const GRACE_MS = 60_000;
// Bound per tick so a backlog can't thundering-herd the runner / queue.
const MAX_PER_TICK = 100;

let timer: NodeJS.Timeout | null = null;
// In-flight guard: a slow sweep MUST NOT overlap the next interval tick. The
// recoveries are idempotent so an overlap is safe today, but the protection is
// implicit — keep it explicit. Cheap flag, no race on Node's single thread.
let inFlight = false;

export function startBroadcastScheduleDriftSweeper(): void {
  if (timer) return;
  timer = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    sweepOnce()
      .catch((err) => {
        console.warn(
          "[broadcast-schedule-drift-sweeper] iteration failed:",
          err instanceof Error ? err.message : err,
        );
      })
      .finally(() => {
        inFlight = false;
      });
  }, SWEEP_INTERVAL_MS);
  timer.unref?.();
}

export function stopBroadcastScheduleDriftSweeper(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

async function sweepOnce(): Promise<void> {
  const now = Date.now();
  const cutoff = new Date(now - GRACE_MS);

  // 1) `scheduled` rows already past their fire time (plus grace) whose job
  //    never fired. Re-enqueue with the remaining delay (clamped to fire now
  //    for an overdue row). Idempotent jobId, so a surviving job isn't dupd.
  const strandedScheduled = await db.broadcast.findMany({
    where: { status: "scheduled", scheduledAt: { lte: cutoff } },
    select: { id: true, scheduledAt: true },
    take: MAX_PER_TICK,
  });

  // 2) `queued` rows that have sat past the grace window without a runner
  //    flipping them to `running`. The Broadcast model has no `updatedAt`, so
  //    we gate on `createdAt` (set at creation; a scheduled row promoted to
  //    `queued` keeps its original createdAt). That's coarse — a just-promoted
  //    scheduled broadcast looks "old" — but re-firing it is a true no-op:
  //    startBroadcast bails instantly when a runner already holds the row
  //    (inFlightRuns dedupe) or the queued→running CAS already fired. The grace
  //    window only matters for an IMMEDIATE-send row whose runner is mid-claim,
  //    which createdAt + grace correctly skips.
  const strandedQueued = await db.broadcast.findMany({
    where: { status: "queued", createdAt: { lte: cutoff } },
    select: { id: true },
    take: MAX_PER_TICK,
  });

  for (const b of strandedScheduled) {
    const delayMs = Math.max(0, (b.scheduledAt?.getTime() ?? now) - now);
    try {
      await enqueueScheduledBroadcast(b.id, delayMs);
    } catch (err) {
      console.warn(
        `[broadcast-schedule-drift-sweeper] re-enqueue failed for broadcast=${b.id}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  for (const b of strandedQueued) {
    // startBroadcast is fire-and-forget + idempotent; a row already claimed by
    // a runner is a no-op (CAS + inFlightRuns dedupe).
    startBroadcast(b.id);
  }

  if (strandedScheduled.length > 0) {
    console.warn(
      `[broadcast-schedule-drift-sweeper] re-enqueued ${strandedScheduled.length} stranded scheduled broadcast(s)`,
    );
  }
  if (strandedQueued.length > 0) {
    console.warn(
      `[broadcast-schedule-drift-sweeper] re-fired ${strandedQueued.length} stranded queued broadcast(s)`,
    );
  }
}
