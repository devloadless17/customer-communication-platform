/**
 * Global sweeper mutex + last-completion bookkeeping.
 *
 * Why: 14+ sweepers run on independent setInterval timers, sharing the same
 * 50-slot Prisma pool. Under unlucky alignment (daily ones aligning at boot
 * + delay, blob-orphan paging while drift is running, retention scans during
 * peak traffic) the pool can starve HTTP requests. A single in-process mutex
 * serializes the heavy sweepers without a real queue — if held, the contender
 * waits ONE short RANDOM backoff and retries; if still held it SKIPS this
 * tick. The jittered single retry (not a skip-forever) is load-bearing:
 * timers armed in the same synchronous onModuleInit get identical libuv
 * expiries and fire back-to-back in creation order EVERY cadence, so a plain
 * skip lets the later sweeper of a colliding pair lose the race forever and
 * starve (stale-calls behind inbound-media; the daily retention pairs). A
 * random backoff breaks that lockstep without queueing: missing at most one
 * cadence cycle is fine, and capping at a single retry prevents tail-of-ticks
 * pileup (which would defeat the point).
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
  | "customer-link"
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
  | "message-flag-count-drift"
  | "open-ticket-count-drift"
  | "outbound-webhook-delivery-cleanup"
  | "message-rawpayload-retention"
  | "broadcast-delivery-drift"
  | "webchat-visitor-retention"
  | "contact-transfer-artifacts"
  | "work-hours"
  | "assignment-rebalance"
  | "ticket-sla-breach"
  | "template-analytics-capture"
  | "abandoned-registration";

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
  "message-flag-count-drift": 25 * 60 * 60 * 1000, // 24h cadence
  "open-ticket-count-drift": 25 * 60 * 60 * 1000, // 24h cadence
  "customer-link": 5 * 60 * 1000, // 60s cadence
  "blob-orphan": 8 * 24 * 60 * 60 * 1000, // weekly cadence
  "outbound-event-retention": 25 * 60 * 60 * 1000,
  "outbound-send-attempt-retention": 25 * 60 * 60 * 1000,
  "conversation-event-retention": 25 * 60 * 60 * 1000,
  "workflow-run-retention": 25 * 60 * 60 * 1000,
  "auth-cleanup": 25 * 60 * 60 * 1000,
  "api-idempotency": 75 * 60 * 1000, // hourly
  "inbound-media": 5 * 60 * 1000, // 60s cadence
  "stale-calls": 5 * 60 * 1000, // 60s cadence
  "ticket-sla-breach": 5 * 60 * 1000, // 60s cadence
  "conversation-analytics-drift": 25 * 60 * 60 * 1000, // 24h cadence
  "outbound-webhook-delivery-cleanup": 25 * 60 * 60 * 1000, // nightly cadence
  "message-rawpayload-retention": 25 * 60 * 60 * 1000, // 24h cadence (opt-in)
  "broadcast-delivery-drift": 7 * 60 * 60 * 1000, // 6h cadence
  "template-analytics-capture": 7 * 60 * 60 * 1000, // 6h cadence
  "contact-transfer-artifacts": 20 * 60 * 1000, // 15m cadence
  "webchat-visitor-retention": 25 * 60 * 60 * 1000, // 24h cadence
  "work-hours": 5 * 60 * 1000, // 60s cadence
  "assignment-rebalance": 11 * 60 * 1000, // 5m cadence
  "abandoned-registration": 25 * 60 * 60 * 1000, // 24h cadence
};

// First time we ATTEMPTED each sweeper. Lets the stale-warn fire for a sweeper
// that has NEVER once completed (always errors / always loses the mutex race) —
// otherwise its `lastCompletion` stays undefined forever and it warns never
// (failure-recovery-added-1). A generous boot grace avoids false positives
// while daily sweepers cluster at startup.
const firstAttempt = new Map<SweeperName, number>();
const NEVER_COMPLETED_GRACE_MS = 60 * 60 * 1000;

// When the mutex is held, wait a RANDOM 1–10s before retrying once. Random is
// the point: it breaks the deterministic same-tick lockstep (see module doc)
// where colliding timers fire in a fixed creation order every cadence and the
// loser would otherwise starve forever. A same-tick collision clears well
// within this window (the holder is mid-await on a fast query); a genuinely
// long scan is still running after it, so the retry skips as before.
const RETRY_BACKOFF_MIN_MS = 1_000;
const RETRY_BACKOFF_JITTER_MS = 9_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run `fn` under the global sweeper mutex. If the mutex is held, wait one
 * short RANDOM backoff and retry; if it's STILL held, SKIP — do not queue.
 * The single jittered retry breaks the same-tick lockstep that would
 * otherwise permanently starve the later sweeper of a colliding pair, while
 * the skip-on-second-check keeps the anti-pileup property for genuinely long
 * scans.
 *
 * Always emits the stale-completion WARN if applicable, even when skipping
 * — operators care about "did this sweeper actually run recently?" not
 * "did we attempt it?".
 */
export async function withSweeperMutex<T>(
  name: SweeperName,
  fn: () => Promise<T>,
): Promise<T | undefined> {
  // Record the first attempt so emitStaleWarnIfDue can fire for a sweeper that
  // has NEVER completed (failure-recovery-added-1).
  if (!firstAttempt.has(name)) firstAttempt.set(name, Date.now());
  // Always check stale-completion first so a perpetually-skipped sweeper
  // gets surfaced (otherwise a sweeper that loses the race every tick
  // would silently never warn).
  emitStaleWarnIfDue(name);

  if (mutexHeld) {
    // Another sweeper is running. Wait a short RANDOM backoff and retry once
    // rather than skipping the whole cadence — otherwise same-tick timer
    // collisions starve the loser forever (see module doc). Random jitter is
    // what breaks the deterministic ordering; a fixed delay would re-collide.
    await sleep(RETRY_BACKOFF_MIN_MS + Math.random() * RETRY_BACKOFF_JITTER_MS);
    if (mutexHeld) {
      // Still held after the backoff — a genuinely long scan is in flight, not
      // a same-tick collision. Skip (no queue). Quiet: a log per skip would be
      // noisy when daily sweepers cluster on boot. Callers that read the return
      // value treat `undefined` as "skipped".
      return undefined;
    }
  }
  // Acquire is synchronous from here (no await between the check and the set),
  // so two sweepers waking from backoff can't both acquire: the first sets the
  // flag before yielding into fn(), the second re-checks and skips.
  mutexHeld = true;
  try {
    const result = await fn();
    lastCompletion.set(name, Date.now());
    return result;
  } finally {
    mutexHeld = false;
  }
}

function emitStaleWarnIfDue(name: SweeperName): void {
  const last = lastCompletion.get(name);
  const threshold = STALE_THRESHOLD_MS[name];
  if (last === undefined) {
    // Never completed. Warn once the time since the FIRST attempt exceeds the
    // threshold + a boot grace — so a sweeper that always errors/skips surfaces
    // instead of staying silent forever (failure-recovery-added-1).
    const first = firstAttempt.get(name);
    if (first === undefined) return; // not attempted yet
    const sinceFirst = Date.now() - first;
    if (sinceFirst > threshold + NEVER_COMPLETED_GRACE_MS) {
      console.warn(
        `[sweeper.health] sweeper_never_completed name=${name} since_first_attempt_ms=${sinceFirst} threshold_ms=${threshold}`,
      );
    }
    return;
  }
  const sinceMs = Date.now() - last;
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
  firstAttempt.clear();
}


/**
 * Is this the "pool already closed" error?
 *
 * Every sweeper is a `setInterval` that outlives the thing it queries. Two
 * situations end the Prisma pool while a timer is still armed:
 *
 *   · dev hot-reload — the module is replaced, the new instance disconnects the
 *     old pool, and the OLD interval keeps firing against it (`unref()` stops
 *     the timer holding the process open, it does not stop the timer);
 *   · graceful shutdown — Nest tears providers down and nothing guarantees the
 *     sweepers stop before `PrismaService` disconnects.
 *
 * Neither is a fault worth a stack trace: the work is simply over. Sweepers use
 * this to stop themselves instead of logging an alarming error on every tick.
 */
export function isPoolClosedError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("Cannot use a pool after calling end on the pool");
}
