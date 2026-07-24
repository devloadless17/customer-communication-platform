// Note: no `server-only` import — the NestJS api process loads this on boot
// via @swc-node/register, outside the Next bundler context.

import { db } from "@/lib/db";
import { enqueueBroadcastMaterialize } from "@/lib/broadcasts/materialize-queue";
import { isPoolClosedError } from "@/lib/sweepers/_mutex";

/**
 * Runtime backstop for broadcasts stranded in `materializing`. The create path
 * enqueues a materialize job (jobId `bcast-mat-<id>`); if that job is lost —
 * Redis eviction / non-persistent restart, or the worker crashing past its retry
 * budget mid-materialize — the row sits `materializing` forever and never sends.
 * The boot reconciler (BroadcastsService.onModuleInit) re-enqueues these on the
 * NEXT restart, but for a pilot that can be days. This sweep re-enqueues the
 * (idempotent) materialize job every 60s so a stranded large broadcast recovers
 * within a minute.
 *
 * Idempotent: `enqueueBroadcastMaterialize` clears a lingering terminal job and
 * re-arms; the worker's status-CAS + createMany(skipDuplicates) make a re-run a
 * no-op for anything already inserted. A grace window keeps the sweep from racing
 * the create-path's own enqueue of a freshly-created row.
 */

const SWEEP_INTERVAL_MS = 60_000;
const GRACE_MS = 60_000;
const MAX_PER_TICK = 50;

let timer: NodeJS.Timeout | null = null;
let inFlight = false;

export function startBroadcastMaterializeDriftSweeper(): void {
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
          stopBroadcastMaterializeDriftSweeper();
          return;
        }
        console.warn(
          "[broadcast-materialize-drift-sweeper] iteration failed:",
          err instanceof Error ? err.message : err,
        );
      })
      .finally(() => {
        inFlight = false;
      });
  }, SWEEP_INTERVAL_MS);
  timer.unref?.();
}

export function stopBroadcastMaterializeDriftSweeper(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

async function sweepOnce(): Promise<void> {
  // The Broadcast model has no `updatedAt`; gate on `createdAt` + grace. A
  // just-created materializing row (whose worker is mid-insert) is skipped by the
  // grace window; a genuinely stranded one has sat well past it. Re-enqueue is a
  // no-op when the worker is already on it (status-CAS + skipDuplicates).
  const cutoff = new Date(Date.now() - GRACE_MS);
  const stranded = await db.broadcast.findMany({
    where: { status: "materializing", createdAt: { lte: cutoff } },
    select: { id: true },
    take: MAX_PER_TICK,
  });
  for (const b of stranded) {
    try {
      await enqueueBroadcastMaterialize(b.id);
    } catch (err) {
      console.warn(
        `[broadcast-materialize-drift-sweeper] re-enqueue failed for broadcast=${b.id}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  if (stranded.length > 0) {
    console.warn(
      `[broadcast-materialize-drift-sweeper] re-enqueued ${stranded.length} stranded materializing broadcast(s)`,
    );
  }
}
