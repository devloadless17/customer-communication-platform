/**
 * In-process job-failure metrics for operator visibility on /health — the
 * audit's "soft DLQ signal". Each worker's `failed` handler calls
 * `recordJobFailure` ONLY on a terminal failure (retries exhausted or
 * UnrecoverableError), so this is a true "jobs that gave up" counter, not
 * per-attempt noise.
 *
 * Deliberately lean per the no-heaviness rule: workers run in-process
 * (RUN_WORKER_INLINE), so this is a shared module — ZERO extra Redis
 * connections and ZERO per-health-probe Redis calls (the alternative,
 * QueueEvents subscriptions, would open a blocking connection per queue).
 *
 * Best-effort observability: counters reset on process restart, which is the
 * correct semantics for "recent failures". For durable forensics the failed
 * BullMQ jobs themselves are retained (removeOnFail 7d) and the per-row DB
 * state (delivery rows, WorkflowRun) survives independently.
 */

interface QueueFailures {
  total: number;
  /** Ring of recent failure epoch-ms, pruned to the 1h window on read. */
  recent: number[];
  lastError?: string;
  lastAt?: number;
}

const WINDOW_MS = 60 * 60_000;
const MAX_RECENT = 1_000;

const byQueue = new Map<string, QueueFailures>();

/** Record one TERMINAL (retries-exhausted / unrecoverable) job failure. */
export function recordJobFailure(
  queue: string,
  jobId: string | undefined,
  reason: string,
): void {
  let q = byQueue.get(queue);
  if (!q) {
    q = { total: 0, recent: [] };
    byQueue.set(queue, q);
  }
  const now = Date.now();
  q.total += 1;
  q.recent.push(now);
  if (q.recent.length > MAX_RECENT) q.recent.shift();
  q.lastError = reason.slice(0, 200);
  q.lastAt = now;
  // Structured line so a log-based alert can fire independently of /health.
  console.warn(
    JSON.stringify({
      event: "job.failed_terminal",
      severity: "warn",
      queue,
      jobId: jobId ?? null,
      reason: reason.slice(0, 300),
    }),
  );
}

export interface JobFailureReport {
  failedLastHour: number;
  failedTotal: number;
  lastError?: string;
  lastFailureAt?: string;
}

/** Point-in-time snapshot for /health. Cheap: pure in-memory, no I/O. */
export function getJobFailureMetrics(): Record<string, JobFailureReport> {
  const cutoff = Date.now() - WINDOW_MS;
  const out: Record<string, JobFailureReport> = {};
  for (const [queue, q] of byQueue) {
    out[queue] = {
      failedLastHour: q.recent.reduce((n, t) => (t >= cutoff ? n + 1 : n), 0),
      failedTotal: q.total,
      ...(q.lastError ? { lastError: q.lastError } : {}),
      ...(q.lastAt ? { lastFailureAt: new Date(q.lastAt).toISOString() } : {}),
    };
  }
  return out;
}
