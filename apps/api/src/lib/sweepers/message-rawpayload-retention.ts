import { db } from "@/lib/db";
import { withSweeperMutex } from "@/lib/sweepers/_mutex";

/**
 * rawPayload bloat control (DB-1). Every inbound Message stores the VERBATIM
 * Meta webhook body in `rawPayload` (JSONB) — invaluable for debugging
 * (CLAUDE.md rule #4) but unbounded: at millions of messages it dominates table
 * size + pg_dump time, and the inbound-media sweeper only needs it for minutes
 * after arrival (Meta retains the binary ~30d for re-download retries).
 *
 * This sweeper NULLs `rawPayload` on messages older than the retention window,
 * keeping recent payloads for debugging while bounding ancient growth.
 *
 * OPT-IN by design: rule #4 says keep raw payloads, so the default is to keep
 * them FOREVER. Set `MESSAGE_RAWPAYLOAD_RETENTION_DAYS` (e.g. `90`) to enable —
 * a deliberate operator decision, not a silent default. Unset / 0 / invalid =
 * disabled (the sweeper no-ops). The window must comfortably exceed the
 * inbound-media re-download window; 90d is a safe, debug-friendly floor.
 */
function retentionDays(): number {
  const raw = process.env.MESSAGE_RAWPAYLOAD_RETENTION_DAYS;
  if (!raw) return 0;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const INITIAL_DELAY_MS = 12 * 60 * 1000;
// Per-batch cap so a first run over a huge backlog doesn't lock the table or
// blow the statement timeout. Loops until drained or MAX_BATCHES.
const BATCH_SIZE = 2000;
const MAX_BATCHES = 50;

let timer: NodeJS.Timeout | null = null;
let initialTimer: NodeJS.Timeout | null = null;
let inFlight = false;

async function runTick(label: string): Promise<void> {
  if (inFlight) return;
  const days = retentionDays();
  if (days <= 0) return; // disabled — opt-in only
  inFlight = true;
  try {
    await withSweeperMutex("message-rawpayload-retention", () => sweepOnce(days));
  } catch (err) {
    console.error(`[sweeper.message-rawpayload] ${label} failed`, err);
  } finally {
    inFlight = false;
  }
}

export function startMessageRawPayloadRetentionSweeper(): void {
  if (timer || initialTimer) return;
  if (retentionDays() <= 0) {
    // Don't even schedule when disabled — keeps the default path zero-cost.
    return;
  }
  initialTimer = setTimeout(() => {
    initialTimer = null;
    void runTick("initial sweep");
    timer = setInterval(() => void runTick("sweep"), SWEEP_INTERVAL_MS);
    timer.unref?.();
  }, INITIAL_DELAY_MS);
  initialTimer.unref?.();
}

export function stopMessageRawPayloadRetentionSweeper(): void {
  if (initialTimer) {
    clearTimeout(initialTimer);
    initialTimer = null;
  }
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

async function sweepOnce(days: number): Promise<void> {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  let total = 0;
  for (let i = 0; i < MAX_BATCHES; i++) {
    // Batched NULL via a LIMIT'd id subquery (Prisma updateMany has no LIMIT).
    // `rawPayload IS NOT NULL` keeps each pass shrinking + idempotent.
    const affected = await db.$executeRaw`
      UPDATE "Message"
      SET "rawPayload" = NULL
      WHERE id IN (
        SELECT id FROM "Message"
        WHERE "timestamp" < ${cutoff} AND "rawPayload" IS NOT NULL
        LIMIT ${BATCH_SIZE}
      )
    `;
    total += Number(affected);
    if (Number(affected) < BATCH_SIZE) break;
  }
  if (total > 0) {
    console.warn(
      `[sweeper.message-rawpayload] nulled rawPayload on ${total} message(s) older than ${days} days`,
    );
  }
}
