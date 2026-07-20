import type Redis from "ioredis";

import type { RedisMemoryReport } from "./health-thresholds";

/**
 * Redis memory watermark probe, shared by the /health endpoint AND the
 * HealthWatchdog alerting loop so both degrade on the SAME signal.
 *
 * Under `noeviction` (BullMQ HARD-requires it) a PING still succeeds at 100%
 * maxmemory while every enqueue FAILS — so reachability alone hides the most
 * dangerous Redis failure mode. Read `used_memory` vs `maxmemory` from INFO and
 * express it as a percent. Bounded by `timeoutMs`; any failure or unbounded
 * config → `usedPercent: null` (no degradation on it).
 */
export async function probeRedisMemory(
  redis: Redis,
  timeoutMs: number,
): Promise<RedisMemoryReport> {
  const timeout = new Promise<RedisMemoryReport>((resolve) =>
    setTimeout(() => resolve({ usedPercent: null }), timeoutMs),
  );
  const probe = (async (): Promise<RedisMemoryReport> => {
    try {
      const info = await redis.info("memory");
      const used = Number(/(?:^|\n)used_memory:(\d+)/.exec(info)?.[1]);
      let max = Number(/(?:^|\n)maxmemory:(\d+)/.exec(info)?.[1]);
      if (!Number.isFinite(max) || max === 0) {
        // maxmemory absent from INFO on some builds — fall back to CONFIG GET.
        const cfg = (await redis.config("GET", "maxmemory")) as unknown as string[];
        max = Number(cfg?.[1]);
      }
      if (!Number.isFinite(used) || !Number.isFinite(max) || max <= 0) {
        return { usedPercent: null };
      }
      return { usedPercent: Math.round((used / max) * 100) };
    } catch {
      return { usedPercent: null };
    }
  })();
  return Promise.race([probe, timeout]);
}
