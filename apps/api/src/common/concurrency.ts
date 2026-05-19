/**
 * Bounded-concurrency map. Replaces `Promise.all(items.map(worker))` for
 * paths where `items` is user-supplied — unbounded Promise.all on a 500-id
 * bulk publish would push every subscriber chain into the event loop at
 * once, pinning it for the duration of the slowest subscriber.
 *
 * Per-worker rejection IS propagated — caller decides whether to wrap. If
 * you need "best-effort, log on failure, never reject," wrap `worker` in
 * a try/catch yourself.
 */
export async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  const queue = items.slice();
  const lanes = Math.min(concurrency, queue.length);
  const runners = Array.from({ length: lanes }, async () => {
    while (queue.length > 0) {
      const next = queue.shift();
      if (next === undefined) return;
      await worker(next);
    }
  });
  await Promise.all(runners);
}
