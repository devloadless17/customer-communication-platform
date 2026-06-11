/**
 * Global sweeper mutex + last-completion bookkeeping.
 *
 * Why: 14+ sweepers run on independent setInterval timers, sharing the same
 * 50-slot Prisma pool. Under unlucky alignment (daily ones aligning at boot
 * + delay, blob-orphan paging while drift is running, retention scans during
 * peak traffic) the pool can starve HTTP requests. A single in-process mutex
 * serializes the heavy sweepers without queueing — if held, the contender
 * SKIPS this tick. Skipping is correct: each sweeper's interval is its own
 * desired cadence, missing one tick costs at most one cadence cycle, and
 * coalescing prevents tail-of-ticks pileup (which would defeat the point).
 *
 * Hot-path sweepers (workflow-waiting at 5s, workflow-awaiting-reply at 1h
 * but trivial) are EXEMPT — they have their own per-sweeper in-flight guard
 * and the queries are cheap. Their being held back by a longer retention
 * scan would delay recovery of stranded workflow runs, which we never want.
 *
 * Health: every wrapped sweep records its last completion timestamp, and
 * each tick checks whether the previous completion is stale past a per-
 * sweeper threshold (24h cadence ones flagged after 25h, weekly ones after
 * 8d). Surfaces as a single structured WARN log line operators can grep —
 * no metrics backend required at pilot scale.
 */

type SweeperName =
  | "contact-drift"
  | "blob-orphan"
  | "outbound-event-retention"
  | "outbound-send-attempt-retention"
  | "conversation-event-retention"
  | "workflow-run-retention"
  | "auth-cleanup"
  | "api-idempotency"
  | "inbound-media"
  | "stale-calls"
  | "conversation-analytics-drift"
  | "outbound-webhook-delivery-cleanup";

// Single in-process mutex; sweepers serialize through it. Boolean is enough
// because Node's event loop is single-threaded — the only way two callers
// race here is the cooperative `await` between check + set inside a single
// async function, which we never do (acquire is synchronous).
let mutexHeld = false;

const lastCompletion = new Map<SweeperName, number>();

// Per-sweeper "stale" threshold. Slightly past the cadence so a normally-
// running sweeper never trips the warning. Weekly ones get a longer
// runway because a skipped tick can take a full week to retry.
const STALE_THRESHOLD_MS: Record<SweeperName, number> = {
  "contact-drift": 25 * 60 * 60 * 1000, // 24h cadence
  "blob-orphan": 8 * 24 * 60 * 60 * 1000, // weekly cadence
  "outbound-event-retention": 25 * 60 * 60 * 1000,
  "outbound-send-attempt-retention": 25 * 60 * 60 * 1000,
  "conversation-event-retention": 25 * 60 * 60 * 1000,
  "workflow-run-retention": 25 * 60 * 60 * 1000,
  "auth-cleanup": 25 * 60 * 60 * 1000,
  "api-idempotency": 75 * 60 * 1000, // hourly
  "inbound-media": 5 * 60 * 1000, // 60s cadence
  "stale-calls": 5 * 60 * 1000, // 60s cadence
  "conversation-analytics-drift": 25 * 60 * 60 * 1000, // 24h cadence
  "outbound-webhook-delivery-cleanup": 25 * 60 * 60 * 1000, // nightly cadence
};

/**
 * Run `fn` under the global sweeper mutex. If the mutex is held, SKIP — do
 * not queue. The contending sweeper's next setInterval tick will retry,
 * which is exactly the right backoff shape for "the pool is busy right now".
 *
 * Always emits the stale-completion WARN if applicable, even when skipping
 * — operators care about "did this sweeper actually run recently?" not
 * "did we attempt it?".
 */
export async function withSweeperMutex(
  name: SweeperName,
  fn: () => Promise<void>,
): Promise<void> {
  // Always check stale-completion first so a perpetually-skipped sweeper
  // gets surfaced (otherwise a sweeper that loses the race every tick
  // would silently never warn).
  emitStaleWarnIfDue(name);

  if (mutexHeld) {
    // Skipped because another sweeper is already running. Quiet — emitting
    // a log per skip would be noisy when daily sweepers cluster on boot.
    return;
  }
  mutexHeld = true;
  try {
    await fn();
    lastCompletion.set(name, Date.now());
  } finally {
    mutexHeld = false;
  }
}

function emitStaleWarnIfDue(name: SweeperName): void {
  const last = lastCompletion.get(name);
  if (last === undefined) return; // never completed yet — normal during boot grace period
  const sinceMs = Date.now() - last;
  const threshold = STALE_THRESHOLD_MS[name];
  if (sinceMs > threshold) {
    // Structured one-liner so `grep '"sweeper_stale"'` finds them. Operator
    // alerting plugs in here without a metrics backend.
    console.warn(
      `[sweeper.health] sweeper_stale name=${name} since_ms=${sinceMs} threshold_ms=${threshold}`,
    );
  }
}

/** Test/diagnostic helper. Not used in production code. */
export function _resetSweeperMutex(): void {
  mutexHeld = false;
  lastCompletion.clear();
}
