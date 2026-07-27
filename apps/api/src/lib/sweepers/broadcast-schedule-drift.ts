// Note: no `server-only` import — the NestJS api process loads this on boot
// via @swc-node/register, outside the Next bundler context.

import { db } from "@/lib/db";
import {
  reconcileCanceledMarkerRecipients,
  resumePausedBroadcasts,
  startBroadcast,
} from "@/lib/broadcast-runner";
import { enqueueScheduledBroadcast } from "@/lib/broadcasts/schedule-queue";
import { isPoolClosedError } from "@/lib/sweepers/_mutex";

/**
 * Periodic sweeper that recovers SCHEDULED + QUEUED + PAUSED broadcasts whose
 * firing stranded between deploys. Without it, the ONLY recovery path is the boot
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
 *   - `paused` rows. A broadcast parks itself `paused` when its credentials are
 *     dead at fire time, when the mid-run permanent-error breaker trips, or when
 *     a graceful shutdown stops it mid-send. Until now the ONLY thing that ever
 *     resumed one was the boot reconciler — so a campaign paused at 2am sat dead
 *     until the next deploy, which for a pilot can be days.
 *     Recovery: `resumePausedBroadcasts` (paused→queued CAS + re-fire), gated on
 *     a COOLDOWN rather than the 60s grace. The cooldown is what makes this safe
 *     to run on a timer: if the underlying cause is still broken the row simply
 *     re-parks, so retrying costs one cheap credential check per cooldown
 *     instead of a hot loop. Resuming never re-sends — every recipient advances
 *     through its own queued→sent CAS.
 *
 * All three recoveries are idempotent, so a row a racing path already advanced
 * is a no-op. A grace window keeps the sweep from racing the legitimate
 * fire/claim of a freshly-created row.
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
// How long a row must have been `paused` before the sweep retries it. Much
// longer than GRACE_MS on purpose: a paused row usually means something is
// genuinely broken (expired token, disabled template), and retrying every 60s
// would spin on that failure. 10 minutes recovers a transient cause promptly
// while keeping a permanent one to ~6 cheap retries an hour.
const PAUSED_COOLDOWN_MS = 10 * 60_000;
// Paused rows re-fire the runner, so keep the per-tick bound tighter than the
// scheduled/queued branches.
const MAX_PAUSED_PER_TICK = 20;

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
        // Pool already ended (dev hot-reload / graceful shutdown). The work
        // is simply over — stop the timer instead of logging a stack trace on
        // every remaining tick. `clearInterval` does NOT cancel a tick already
        // in flight, so without this the sweeper keeps querying a closed pool
        // and Prisma logs "Cannot use a pool after calling end on the pool"
        // once per tick for the whole drain.
        if (isPoolClosedError(err)) {
          stopBroadcastScheduleDriftSweeper();
          return;
        }
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
    // a runner is a no-op (CAS + inFlightRuns dedupe). It does a DB lookup
    // BEFORE its own internal .catch is armed, so a transient pool error there
    // rejects the returned promise — `void ….catch` keeps that from surfacing
    // as a context-less [unhandledRejection].
    void startBroadcast(b.id).catch((err) => {
      console.warn(
        `[broadcast-schedule-drift-sweeper] re-fire failed for broadcast=${b.id}:`,
        err instanceof Error ? err.message : err,
      );
    });
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

  // 3) `paused` rows past the cooldown. Shares the boot reconciler's resume
  //    path, so the "every recipient already sent, row never stamped
  //    completed" case is handled identically in both.
  try {
    const resumed = await resumePausedBroadcasts({
      pausedBefore: new Date(now - PAUSED_COOLDOWN_MS),
      limit: MAX_PAUSED_PER_TICK,
      // Sweeper-only: a template disabled at Meta is fixed by an operator, not
      // by waiting, so retrying it every 10min just burns recipients. Boot
      // still resumes them — see resumePausedBroadcasts' doc-comment for why
      // excluding them everywhere would strand the broadcast permanently.
      skipTemplatePauses: true,
      label: "broadcast-schedule-drift-sweeper",
    });
    if (resumed > 0) {
      console.warn(
        `[broadcast-schedule-drift-sweeper] resumed ${resumed} paused broadcast(s)`,
      );
    }
  } catch (err) {
    // Isolated from the branches above: a failure resuming paused rows must not
    // stop the scheduled/queued recoveries that already ran this tick.
    console.warn(
      "[broadcast-schedule-drift-sweeper] paused-resume failed:",
      err instanceof Error ? err.message : err,
    );
  }

  // 4) Cancel-race repair. Boot-only invocation raced the 7-day send-attempt
  //    retention: a crash + cancel race on a box that stayed up a week lost the
  //    completed-attempt evidence and a billed, delivered send stayed recorded
  //    `failed` forever. The query is empty in the normal case — see the fn doc.
  try {
    await reconcileCanceledMarkerRecipients();
  } catch (err) {
    console.warn(
      "[broadcast-schedule-drift-sweeper] cancel-race reconcile failed:",
      err instanceof Error ? err.message : err,
    );
  }
}
