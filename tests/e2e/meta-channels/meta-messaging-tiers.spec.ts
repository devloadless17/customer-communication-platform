/**
 * WhatsApp messaging-limit tier parsing, pinned against Meta's LIVE docs
 * (verified 2026-07-18):
 *   https://developers.facebook.com/docs/whatsapp/messaging-limits/
 *   https://developers.facebook.com/documentation/business-messaging/whatsapp/upcoming-messaging-limits-changes/
 *
 * WHY THIS EXISTS: the tier ladder in our code was written from memory, never
 * checked against Meta, and had gone stale. Meta's 2025-10-07 change moved the
 * ladder to 250 → 2K → 10K → 100K → Unlimited (the auto-scale threshold went
 * 1,000 → 2,000), and our map had no TIER_2K at all. Two live defects resulted:
 *
 *   - `normalizeMessagingTier("TIER_2K")` returned **null**, so a number on
 *     Meta's second tier was recorded as "unknown tier" and left COMPLETELY
 *     UNGATED — a 100k campaign on a 2k number would sail past the pre-send
 *     check and burn ~98k recipients on guaranteed failures.
 *   - a bare cap of `2000` bucketed into TIER_10K, a **5x over-estimate**.
 *
 * These are pure-function assertions (no DB, no network) so they stay fast and
 * cannot flake. They are the regression guard on the ladder itself: if Meta
 * changes tiers again, this is what should fail first.
 */

import { test, expect } from "@playwright/test";

import {
  normalizeMessagingTier,
  tierDailyCap,
} from "../../../apps/api/src/lib/providers/meta-health";

/** Cap for a raw tier value, the way the gate actually derives it. */
function capOf(raw: unknown): number | null {
  return tierDailyCap(normalizeMessagingTier(raw));
}

test.describe("Meta's current tier ladder (post 2025-10-07)", () => {
  test("every current tier normalizes and sizes correctly", () => {
    expect(capOf("TIER_250")).toBe(250);
    expect(capOf("TIER_2K")).toBe(2_000);
    expect(capOf("TIER_10K")).toBe(10_000);
    expect(capOf("TIER_100K")).toBe(100_000);
    // Unlimited is `null` = no cap to gate on, NOT zero.
    expect(capOf("TIER_UNLIMITED")).toBeNull();
    expect(capOf("UNLIMITED")).toBeNull();
  });

  test("THE BUG: TIER_2K used to normalize to null and leave the number ungated", () => {
    expect(normalizeMessagingTier("TIER_2K")).toBe("TIER_2K");
    // The gate treats a null cap as "no snapshot → allow". Returning null here
    // is precisely how a 2k number would have accepted a 100k campaign.
    expect(capOf("TIER_2K")).not.toBeNull();
  });

  test("THE BUG: a bare 2000 cap no longer over-sizes to the 10K tier", () => {
    expect(normalizeMessagingTier(2_000)).toBe("TIER_2K");
    expect(capOf(2_000)).toBe(2_000);
    expect(capOf("2000")).toBe(2_000);
  });
});

test.describe("tier parsing is forgiving about representation", () => {
  test("K-shorthand parses with and without the TIER_ prefix", () => {
    expect(capOf("2K")).toBe(2_000);
    expect(capOf("10K")).toBe(10_000);
    expect(capOf("100K")).toBe(100_000);
    expect(capOf("tier_10k")).toBe(10_000);
    expect(capOf("  TIER_100K  ")).toBe(100_000);
  });

  test("an unfamiliar intermediate cap rounds UP to the covering tier, never above its allowance", () => {
    // The safety property: a number we can't place exactly must never be sized
    // LARGER than its real allowance, or the gate waves through a doomed send.
    expect(capOf(1_500)).toBe(2_000);
    expect(capOf(5_000)).toBe(10_000);
    expect(capOf(50_000)).toBe(100_000);
    expect(capOf(250_000)).toBeNull(); // beyond 100K → treated as unlimited
  });

  test("legacy TIER_1K still sizes correctly rather than going ungated", () => {
    // Removed from Meta's ladder in 2025-10-07, but a snapshot taken before
    // then must still gate at 1,000 instead of normalizing to null.
    expect(capOf("TIER_1K")).toBe(1_000);
  });

  test("genuinely unrecognizable input yields null (ungated), not a crash", () => {
    for (const bad of ["", "   ", "NOT_A_TIER", "TIER_", null, undefined, {}, -5, 0]) {
      expect(normalizeMessagingTier(bad)).toBeNull();
    }
  });
});
