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

/**
 * Rate used by the TIMING tests, deliberately SLOW.
 *
 * These drain a bucket with a few sequential `take`s — each a real Redis
 * round-trip — then assert the next one has to WAIT. That only holds if less
 * than one refill interval passes while draining. At 100/s the interval is
 * 10ms, which a loaded CI runner blows straight through between round-trips:
 * the bucket quietly refills a token, the "must wait" take is granted
 * instantly, and the test dies on `expected 0 to be greater than 0`.
 *
 * That is not hypothetical — it failed the `unit` job on 2026-07-30 and, since
 * `ship` needs `unit`, it blocked a deploy of an otherwise green tree.
 *
 * 4/s = 250ms per token, which no handful of local Redis calls will outrun.
 * Do NOT raise it to make these tests faster: the speed IS the bug.
 */
const SLOW_RATE = 4;
const SLOW_REFILL_MS = 1000 / SLOW_RATE;

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
    // Drain. SLOW_RATE so draining cannot outrun the refill — see its docblock.
    await take(KEY, SLOW_RATE, capacity);
    await take(KEY, SLOW_RATE, capacity);
    expect(await take(KEY, SLOW_RATE, capacity)).toBeGreaterThan(0);

    // One refill interval later a token exists again. A bucket that limits but
    // never refills would stall a campaign forever, which is worse than not
    // limiting at all.
    await new Promise((r) => setTimeout(r, SLOW_REFILL_MS + 80));
    expect(await take(KEY, SLOW_RATE, capacity)).toBe(0);
  });

  it("tells you HOW LONG to wait, sized to the rate", async () => {
    const capacity = 1;
    await take(KEY, SLOW_RATE, capacity); // drain
    const wait = await take(KEY, SLOW_RATE, capacity);
    // The reported wait is bounded by one refill interval. Same slow rate as
    // above and for the same reason: at 10/s the 100ms interval was only just
    // wider than two Redis round-trips, so this had the same latent flake.
    // What matters is the order of magnitude, not the exact value.
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThanOrEqual(SLOW_REFILL_MS);
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
  it("is ON by default and opt-OUT, since lane sizing depends on it", () => {
    // The bucket is the rate AUTHORITY: `lanesForRate` sizes concurrency to a
    // target rate, which is only safe because the bucket caps the actual rate.
    // Defaulting it off would silently pin every number to fixed-gap pacing
    // (~60 msg/s) no matter what tier Meta had scaled it to.
    const prev = process.env.BROADCAST_RATE_LIMITER_ENABLED;
    delete process.env.BROADCAST_RATE_LIMITER_ENABLED;
    expect(sendRateLimiterEnabled()).toBe(true);
    process.env.BROADCAST_RATE_LIMITER_ENABLED = "1";
    expect(sendRateLimiterEnabled()).toBe(true);
    // Explicit opt-out is the only way off.
    process.env.BROADCAST_RATE_LIMITER_ENABLED = "0";
    expect(sendRateLimiterEnabled()).toBe(false);
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

  it("caps a COEXISTENCE number at Meta's fixed 20/s, ignoring its throughput level", () => {
    // Meta's throughput doc: a WhatsApp Business APP number used with Cloud API
    // simultaneously is capped at 20 messages/second — a FIXED figure, outside the
    // 80 (default) / 1,000 (upgraded) ladder. Meta still reports a `throughput.level`
    // for those numbers, so pacing off the level alone ran them at 75/s (STANDARD)
    // or 40/s (unknown): 2-4x over a hard ceiling. That earns sustained 130429s
    // mid-campaign and damages the quality rating of exactly the fragile numbers
    // Coexistence serves — a small business's own handset.
    //
    // The cap REPLACES the ladder rather than blending with it, so even a HIGH
    // number is held at the Coexistence rate.
    expect(resolveSendRate("HIGH", true)).toBe(18);
    expect(resolveSendRate("STANDARD", true)).toBe(18);
    expect(resolveSendRate(null, true)).toBe(18);
    // Under 20, with the same protective margin HIGH/STANDARD keep under 1000/80.
    expect(resolveSendRate("STANDARD", true)).toBeLessThan(20);

    // NOT coexistence, and NOT-YET-POLLED, both keep the ordinary ladder — a null
    // must never be read as "true" or every unpolled number would crawl.
    expect(resolveSendRate("STANDARD", false)).toBe(75);
    expect(resolveSendRate("STANDARD", null)).toBe(75);
    expect(resolveSendRate("STANDARD", undefined)).toBe(75);
  });
});

// ---------------------------------------------------------------------------
// Tier scaling — how the in-process runner serves 250 → 2K → 10K → 100K without
// a second container. Meta auto-scales a healthy number through those tiers, so
// the send path has to follow it while never crossing Meta's msg/s ceiling.
// ---------------------------------------------------------------------------

describe("tier scaling", () => {
  it("sizes lanes by Little's Law so each tier can actually reach its rate", async () => {
    const { lanesForRate } = await import("@/lib/broadcast-runner");
    // concurrency = rate × latency. At the default 250ms assumed round-trip:
    expect(lanesForRate(900)).toBe(225); // HIGH  — 900/s
    expect(lanesForRate(75)).toBe(19); //  STANDARD — 75/s
    expect(lanesForRate(40)).toBe(10); //  unknown tier — conservative baseline
    // A fixed 16 lanes (the old behaviour) tops out ~60 msg/s regardless of
    // tier — which is the bug this replaces.
    expect(lanesForRate(900)).toBeGreaterThan(16);
  });

  it("clamps lanes so a config typo cannot uncap concurrency", async () => {
    const { lanesForRate } = await import("@/lib/broadcast-runner");
    // Even an absurd rate stays inside the hard ceiling.
    expect(lanesForRate(100_000)).toBe(256);
    expect(lanesForRate(0)).toBe(1);
  });

  it("keeps the per-team cap at or above the lane count", async () => {
    const { lanesForRate, perTeamRecipientConcurrency } = await import(
      "@/lib/broadcast-runner"
    );
    const prev = process.env.BROADCAST_PER_TEAM_RECIPIENT_CONCURRENCY;
    delete process.env.BROADCAST_PER_TEAM_RECIPIENT_CONCURRENCY;
    // Effective rate is min(lanes, thisCap) — a cap below the lane count would
    // silently throttle a HIGH-tier number back to the old ceiling.
    expect(perTeamRecipientConcurrency()).toBeGreaterThanOrEqual(lanesForRate(900));
    if (prev === undefined) delete process.env.BROADCAST_PER_TEAM_RECIPIENT_CONCURRENCY;
    else process.env.BROADCAST_PER_TEAM_RECIPIENT_CONCURRENCY = prev;
  });

  it("bounds TOTAL in-flight sends process-wide, not just per team", async () => {
    const { globalSendConcurrency, lanesForRate } = await import(
      "@/lib/broadcast-runner"
    );
    const cap = globalSendConcurrency();
    // The per-team cap alone would allow (teams × lanes) concurrent Meta calls
    // in the process that also serves the inbox. The global ceiling is what
    // actually protects interactive latency.
    expect(cap).toBeGreaterThan(0);
    expect(cap).toBeLessThanOrEqual(1_000);
    // Big enough that one full-rate broadcast is never starved by it.
    expect(cap).toBeGreaterThanOrEqual(lanesForRate(900));
  });

  it("never targets Meta's actual ceiling — headroom is deliberate", () => {
    // Meta publishes 80 msg/s STANDARD and ~1000 HIGH, and BOTH count inbound.
    // Saturating either starves the inbox exactly when customers reply to the
    // campaign, so the targets sit under them on purpose.
    expect(resolveSendRate("STANDARD")).toBeLessThan(80);
    expect(resolveSendRate("HIGH")).toBeLessThan(1000);
  });
});
