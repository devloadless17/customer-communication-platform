import { db } from "@/lib/db";
import { withSweeperMutex } from "@/lib/sweepers/_mutex";

/**
 * Retention sweeper for the `WorkflowRun` table.
 *
 * Each workflow execution writes one row carrying fat JSON columns
 * (`eventPayload`, `stepLog`, `stepOutputs`). At real automation volume this
 * is the fastest-growing table in the schema — a single busy "on every inbound
 * → tag + reply" workflow produces one row per customer message. The runs UI
 * only needs a recent window; older runs are forensic-at-best.
 *
 * Retention policy:
 *   - status in (completed | failed | skipped) AND startedAt < cutoff → delete
 *   - status in (queued | running | waiting)                          → KEEP
 *     (in-flight; a `waiting` run can legitimately sit for a long timer)
 *
 * Cutoff: 30 days (the runs-UI window). Cadence: daily, batched so a large
 * backlog doesn't lock the table. Mirrors the other retention sweepers
 * (outbound-event-retention, outbound-send-attempt-retention).
 */

const SWEEP_INTERVAL_MS = 24 * 60 * 60_000;
const INITIAL_DELAY_MS = 35 * 60_000; // after the other retention sweepers
const RETENTION_MS = 30 * 24 * 60 * 60_000;
const MAX_PER_SWEEP = 20_000;
const MAX_BATCHES = 4;

let timer: NodeJS.Timeout | null = null;
let initialTimer: NodeJS.Timeout | null = null;
let inFlight = false;

async function runTick(label: string): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    // Mutex serializes the batched DELETE against other heavy sweepers.
    await withSweeperMutex("workflow-run-retention", sweepOnce);
  } catch (err) {
    console.error(`[sweeper.workflow-run-retention] ${label} failed`, err);
  } finally {
    inFlight = false;
  }
}

export function startWorkflowRunRetentionSweeper(): void {
  if (timer || initialTimer) return;
  initialTimer = setTimeout(() => {
    initialTimer = null;
    void runTick("initial sweep");
    timer = setInterval(() => {
      void runTick("sweep");
    }, SWEEP_INTERVAL_MS);
    timer.unref?.();
  }, INITIAL_DELAY_MS);
  initialTimer.unref?.();
}

export function stopWorkflowRunRetentionSweeper(): void {
  if (initialTimer) {
    clearTimeout(initialTimer);
    initialTimer = null;
  }
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

async function sweepOnce(): Promise<void> {
  const cutoff = new Date(Date.now() - RETENTION_MS);
  let totalDeleted = 0;
  for (let i = 0; i < MAX_BATCHES; i++) {
    const stale = await db.workflowRun.findMany({
      where: {
        status: { in: ["completed", "failed", "skipped"] },
        startedAt: { lt: cutoff },
      },
      select: { id: true },
      take: MAX_PER_SWEEP,
    });
    if (stale.length === 0) break;
    const ids = stale.map((r) => r.id);
    const { count } = await db.workflowRun.deleteMany({
      where: { id: { in: ids } },
    });
    totalDeleted += count;
    if (stale.length < MAX_PER_SWEEP) break;
  }
  if (totalDeleted > 0) {
    console.log(
      `[sweeper.workflow-run-retention] removed ${totalDeleted} terminal run(s) older than ${RETENTION_MS / 86_400_000}d`,
    );
  }
}
