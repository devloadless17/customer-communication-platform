/**
 * The per-number send-rate token bucket.
 *
 * Runs the REAL Lua against the REAL Redis, because every interesting property
 * lives in the script rather than in the TypeScript around it: atomic
 * refill-then-take, the burst capacity, and the clock-skew guard. A mocked
 * Redis would test the mock.
 *
 * What is worth proving:
 *   1. It actually LIMITS — N+1 takes in one instant cannot all succeed.
 *   2. It REFILLS at the configured rate, so a campaign isn't throttled forever.
 *   3. It is SHARED — two callers on one number contend; two numbers don't.
 *   4. Redis time going backwards (an NTP step) must not drain the bucket.
 *   5. It is OFF by default. Shipping it hot would change every send's timing.
 *
 *   pnpm --filter @ccp/api exec vitest run test/send-rate-limiter.spec.ts
 */
import { existsSync } from "node:fs";

import IORedis from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ACQUIRE_LUA,
  resolveSendRate,
  sendRateLimiterEnabled,
} from "@/lib/broadcasts/send-rate-limiter";

if (existsSync(".env")) process.loadEnvFile(".env");
if (existsSync("../../.env")) process.loadEnvFile("../../.env");

const redis = new IORedis(process.env.REDIS_URL ?? "redis://127.0.0.1:6379", {
  maxRetriesPerRequest: null,
});

const KEY = `wa-send-rate:test-${Date.now()}`;
const OTHER = `wa-send-rate:other-${Date.now()}`;

/** One take. Returns ms to wait; 0 means a token was granted. */
async function take(key: string, rate: number, capacity: number): Promise<number> {
  return Number(await redis.eval(ACQUIRE_LUA, 1, key, String(rate), String(capacity)));
}

beforeAll(async () => {
  await redis.del(KEY, OTHER);
});

beforeEach(async () => {
  await redis.del(KEY, OTHER);
});

afterAll(async () => {
  await redis.del(KEY, OTHER);
  await redis.quit();
});

describe("the bucket limits", () => {
  it("grants exactly `capacity` tokens in one instant, then makes you wait", async () => {
    const capacity = 5;
    const granted: number[] = [];
    for (let i = 0; i < capacity; i++) granted.push(await take(KEY, 5, capacity));
    // All five immediate — a full bucket must not throttle a campaign opening
    // on an idle number.
    expect(granted).toEqual([0, 0, 0, 0, 0]);

    // The sixth is the whole point.
    const sixth = await take(KEY, 5, capacity);
    expect(sixth).toBeGreaterThan(0);
  });

  it("is ATOMIC — concurrent takes cannot all win", async () => {
    // The bug a GET/SET implementation has: two lanes read the same count and
    // both decrement it. Fire 20 at once against a bucket of 5.
    const capacity = 5;
    const results = await Promise.all(
      Array.from({ length: 20 }, () => take(KEY, 5, capacity)),
    );
    const immediate = results.filter((w) => w === 0).length;
    expect(immediate).toBe(capacity);
  });

  it("refills at the configured rate", async () => {
    const capacity = 2;
    // Drain.
    await take(KEY, 100, capacity);
    await take(KEY, 100, capacity);
    expect(await take(KEY, 100, capacity)).toBeGreaterThan(0);

    // At 100/s a token appears in ~10ms. Wait generously and confirm it granted
    // — a bucket that limits but never refills would stall a campaign forever,
    // which is worse than not limiting at all.
    await new Promise((r) => setTimeout(r, 120));
    expect(await take(KEY, 100, capacity)).toBe(0);
  });

  it("tells you HOW LONG to wait, sized to the rate", async () => {
    const capacity = 1;
    await take(KEY, 10, capacity); // drain
    const wait = await take(KEY, 10, capacity);
    // At 10/s one token is 100ms. Allow slack for the elapsed time between the
    // two calls; what matters is the order of magnitude, not the exact value.
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThanOrEqual(100);
  });
});

describe("the bucket is scoped to the NUMBER", () => {
  it("makes two callers on one number contend, and two numbers independent", async () => {
    const capacity = 1;
    expect(await take(KEY, 1, capacity)).toBe(0);
    // Same number, second caller (a second campaign, or a second process):
    // must contend. This is the property a per-lane sleep cannot express.
    expect(await take(KEY, 1, capacity)).toBeGreaterThan(0);
    // A DIFFERENT number has its own ceiling — Meta's limit is per number.
    expect(await take(OTHER, 1, capacity)).toBe(0);
  });
});

describe("clock safety", () => {
  it("does not drain the bucket when Redis time appears to go backwards", async () => {
    const capacity = 3;
    await take(KEY, 5, capacity);
    // Simulate an NTP step: stamp the bucket a minute into the FUTURE, so the
    // next call computes a negative elapsed. Unguarded, `tokens + negative`
    // reduces the balance and the number is throttled for no reason.
    const future = (Date.now() + 60_000) * 1000;
    await redis.hset(KEY, "ts", String(future));
    const before = Number((await redis.hget(KEY, "tokens")) ?? 0);

    const wait = await take(KEY, 5, capacity);
    expect(wait).toBe(0);

    const after = Number((await redis.hget(KEY, "tokens")) ?? 0);
    // Exactly one token consumed — no phantom drain from the negative elapsed.
    expect(after).toBeCloseTo(before - 1, 5);
  });

  it("expires an idle number's key instead of keeping one row per number forever", async () => {
    await take(KEY, 5, 5);
    const ttl = await redis.pttl(KEY);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60_000);
  });
});

describe("rollout safety", () => {
  it("is OFF unless explicitly enabled", () => {
    const prev = process.env.BROADCAST_RATE_LIMITER_ENABLED;
    delete process.env.BROADCAST_RATE_LIMITER_ENABLED;
    expect(sendRateLimiterEnabled()).toBe(false);
    process.env.BROADCAST_RATE_LIMITER_ENABLED = "0";
    expect(sendRateLimiterEnabled()).toBe(false);
    process.env.BROADCAST_RATE_LIMITER_ENABLED = "1";
    expect(sendRateLimiterEnabled()).toBe(true);
    if (prev === undefined) delete process.env.BROADCAST_RATE_LIMITER_ENABLED;
    else process.env.BROADCAST_RATE_LIMITER_ENABLED = prev;
  });

  it("targets a rate BELOW Meta's ceiling, leaving inbound headroom", () => {
    // Meta publishes 80 msg/s STANDARD and ~1000 HIGH, and the ceiling counts
    // INBOUND too — saturating it starves the inbox exactly when customers are
    // replying to the campaign. The gap is deliberate, so assert it.
    expect(resolveSendRate("STANDARD")).toBe(75);
    expect(resolveSendRate("HIGH")).toBe(900);
    // Unknown throughput must assume the SLOWER tier: too slow costs time, too
    // fast costs the number's quality rating.
    expect(resolveSendRate(null)).toBe(40);
    expect(resolveSendRate(undefined)).toBe(40);
    expect(resolveSendRate("SOMETHING_NEW")).toBe(40);
  });
});
