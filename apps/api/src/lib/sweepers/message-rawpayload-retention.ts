import { db } from "@/lib/db";
import { isPoolClosedError, withSweeperMutex } from "@/lib/sweepers/_mutex";

/**
 * rawPayload bloat control (DB-1). Every inbound Message stores the VERBATIM
 * Meta webhook body in `rawPayload` (JSONB) — invaluable for debugging
 * (CLAUDE.md rule #4) but unbounded: at millions of messages it dominates table
 * size + pg_dump time, and the inbound-media sweeper only needs it for minutes
 * after arrival (Meta retains the binary ~30d for re-download retries).
 *
 * This sweeper SHEDS `rawPayload` on messages older than the retention window,
 * keeping recent payloads for debugging while bounding ancient growth. Broadcast
 * rows are the one exception: instead of NULLing them, we collapse them to the
 * minimal `{"sentVia":"broadcast"}` stub. That one-key discriminator is the only
 * signal the analytics-drift sweeper has to EXCLUDE broadcast sends from the
 * outgoing-message recount (broadcasts don't bump the incremental counter); a
 * bare NULL would make an aged broadcast row indistinguishable from a normal
 * send and permanently poison drift-correction for that conversation. The bulky
 * webhook body is still shed for every row (rule #4 intent preserved) — only the
 * 1-key classifier survives on broadcasts.
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
    // Pool already ended (dev hot-reload / shutdown) — the work is
    // over, so stop instead of logging a stack trace every tick.
    if (isPoolClosedError(err)) {
      stopMessageRawPayloadRetentionSweeper();
      return;
    }
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
    // Batched shed via a LIMIT'd id subquery (Prisma updateMany has no LIMIT).
    // Broadcast rows collapse to the 1-key `{"sentVia":"broadcast"}` stub (the
    // discriminator the analytics-drift sweeper needs); everything else NULLs.
    // The WHERE excludes rows already in their terminal shed state (NULL, or the
    // exact broadcast stub) so each pass keeps shrinking + stays idempotent —
    // without the `<> stub` guard, already-collapsed broadcast rows would be
    // re-selected forever and starve the batch.
    const affected = await db.$executeRaw`
      UPDATE "Message"
      SET "rawPayload" = CASE
        WHEN "rawPayload"->>'sentVia' = 'broadcast' THEN '{"sentVia":"broadcast"}'::jsonb
        ELSE NULL
      END
      WHERE id IN (
        SELECT id FROM "Message"
        WHERE "timestamp" < ${cutoff}
          AND "rawPayload" IS NOT NULL
          AND "rawPayload" <> '{"sentVia":"broadcast"}'::jsonb
        LIMIT ${BATCH_SIZE}
      )
    `;
    total += Number(affected);
    if (Number(affected) < BATCH_SIZE) break;
  }
  if (total > 0) {
    console.warn(
      `[sweeper.message-rawpayload] shed rawPayload on ${total} message(s) older than ${days} days`,
    );
  }
}
