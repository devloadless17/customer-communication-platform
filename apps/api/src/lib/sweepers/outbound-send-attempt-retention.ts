import { db } from "@/lib/db";
import { isPoolClosedError, withSweeperMutex } from "@/lib/sweepers/_mutex";

/**
 * Retention sweeper for OutboundSendAttempt rows. The model is bookkeeping
 * for the BEFORE-Meta-call idempotency check in two places:
 *   - `MessagesService.executeTextSendJob` (jobId `msg-send-*`) — once a job is
 *     past BullMQ's `removeOnFail` window (7 days) there can be no more retries
 *     using the same jobId, so the row's "block double-send" purpose is moot.
 *   - the broadcast runner's per-recipient guard (jobId `bc-recipient-*`,
 *     added 2026-05-22) — completed rows are reconcile breadcrumbs; the rare
 *     stuck/incomplete row (crash mid-send) is GC'd here after 7 days too.
 *
 * Without cleanup, the table grows monotonically (1 row per outbound text
 * send per attempt × team × forever). At pilot scale that's slow, but the
 * growth is unbounded so a sweeper is the right shape.
 *
 * Retention window: 7 days. Matches send-queue's `removeOnFail: { age:
 * 24h * 7 }` so a row we delete here is guaranteed to have no
 * corresponding BullMQ job left to retry. Bumping this only changes
 * disk usage; it never affects correctness.
 *
 * Cadence: 24h. Cheap — one indexed DELETE.
 */
const RETENTION_DAYS = 7;
const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
// Initial delay so the sweeper doesn't compete with boot-time work on the
// DB. 10min is long enough that migrations + boot reconcilers have all
// settled.
const INITIAL_DELAY_MS = 10 * 60 * 1000;

let timer: NodeJS.Timeout | null = null;
let initialTimer: NodeJS.Timeout | null = null;
let inFlight = false;

async function runTick(label: string): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    // Mutex serializes the indexed DELETE against other heavy sweepers.
    await withSweeperMutex("outbound-send-attempt-retention", sweepOnce);
  } catch (err) {
    // Pool already ended (dev hot-reload / shutdown) — the work is
    // over, so stop instead of logging a stack trace every tick.
    if (isPoolClosedError(err)) {
      stopOutboundSendAttemptRetentionSweeper();
      return;
    }
    console.error(`[sweeper.outbound-send-attempt] ${label} failed`, err);
  } finally {
    inFlight = false;
  }
}

export function startOutboundSendAttemptRetentionSweeper(): void {
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

export function stopOutboundSendAttemptRetentionSweeper(): void {
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
  const cutoff = new Date(
    Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000,
  );

  // ── 1) Non-broadcast rows (`msg-send-*` queue sends) ────────────────────
  // These have a BOUNDED retry window: BullMQ `removeOnFail` (7d). Once past
  // 7d there is no surviving retry path, so the row's double-send-guard
  // purpose is moot. (/v1 sends do NOT write here — they guard with
  // ApiIdempotencyKey and its own TTL; an earlier comment claimed a
  // `v1-send-*` prefix in this table that no code ever wrote.)
  // EXCLUDE `bc-recipient-*` — broadcasts have NO BullMQ layer and their
  // resume path is the UNBOUNDED-in-time boot reconciler, so a time-based
  // window would GC a still-load-bearing guard (BC-1).
  const nonBroadcast = await db.outboundSendAttempt.deleteMany({
    where: {
      attemptStartedAt: { lt: cutoff },
      NOT: { jobId: { startsWith: "bc-recipient-" } },
    },
  });

  // ── 2) Broadcast rows whose parent broadcast is TERMINAL ───────────────────
  // A `bc-recipient-*` row is the per-recipient double-send guard consulted by
  // the boot reconciler on resume. It is ONLY safe to drop once the parent
  // broadcast can never resume — i.e. status ∈ {completed, failed, canceled}
  // (the reconciler resumes only queued/running/paused). A paused broadcast
  // sitting >7d on a rotated credential keeps ALL its guard rows (it is not
  // terminal) so an auto-resume can't re-send a billed template. We still apply
  // the cutoff so a just-finished broadcast keeps its reconcile breadcrumbs
  // briefly. `status::text` avoids enum-literal casting issues.
  const terminalBroadcast = await db.$executeRaw`
    DELETE FROM "OutboundSendAttempt" osa
    USING "BroadcastRecipient" br, "Broadcast" b
    WHERE osa."jobId" = ('bc-recipient-' || br.id)
      AND br."broadcastId" = b.id
      AND b.status::text IN ('completed', 'failed', 'canceled')
      AND osa."attemptStartedAt" < ${cutoff}
  `;

  // ── 3) Orphaned broadcast rows ─────────────────────────────────────────────
  // OutboundSendAttempt has no FK to BroadcastRecipient, so a hard-deleted
  // broadcast (cascades its recipients) leaves dangling `bc-recipient-*` rows.
  // With the recipient gone no resume can ever consult them → safe to drop.
  const orphanBroadcast = await db.$executeRaw`
    DELETE FROM "OutboundSendAttempt" osa
    WHERE osa."jobId" LIKE 'bc-recipient-%'
      AND osa."attemptStartedAt" < ${cutoff}
      AND NOT EXISTS (
        SELECT 1 FROM "BroadcastRecipient" br
        WHERE osa."jobId" = ('bc-recipient-' || br.id)
      )
  `;

  const total =
    nonBroadcast.count + Number(terminalBroadcast) + Number(orphanBroadcast);
  if (total > 0) {
    console.warn(
      `[sweeper.outbound-send-attempt] pruned ${total} row(s) ` +
        `(${nonBroadcast.count} send, ${Number(terminalBroadcast)} terminal-broadcast, ` +
        `${Number(orphanBroadcast)} orphan-broadcast) older than ${RETENTION_DAYS} days`,
    );
  }
}
