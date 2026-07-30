/**
 * Meta's ACCOUNT-level analytics — the four surfaces beyond template analytics.
 *
 * These are pure-function tests over the wire shapes and the merges, because
 * that is where the whole risk lives. The fetches themselves are thin; what can
 * silently produce a WRONG NUMBER is:
 *
 *   - the four different response envelopes Meta uses across seven analytics
 *     fields (guess wrong → empty array → "this account sent nothing", forever);
 *   - the volume-tier bound, whose `MAX` upper must not become a real number;
 *   - merging an AVERAGE (call duration) across buckets, which cannot be summed
 *     and must be re-weighted by call count;
 *   - null-vs-zero on every cost field, since Meta WITHHOLDS cost entirely for
 *     partner-billed accounts.
 *
 *   pnpm --filter @ccp/api exec vitest run test/waba-analytics.spec.ts
 */
import { describe, expect, it } from "vitest";

import { analyticsDataPoints, parseTierBounds } from "@/lib/providers/meta";
import { callSlices, tierStandings } from "@/lib/analytics/waba-analytics";

// ---------------------------------------------------------------------------
// Response envelopes
// ---------------------------------------------------------------------------

describe("analyticsDataPoints", () => {
  const point = { start: 1_760_000_000, end: 1_760_086_400, sent: 5 };

  it("reads the FIELD form Meta documents for conversation and pricing analytics", () => {
    // `{ <field>: { data: [ { data_points: [...] } ] } }`
    const out = analyticsDataPoints(
      { pricing_analytics: { data: [{ data_points: [point] }] } },
      "pricing_analytics",
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.sent).toBe(5);
  });

  it("reads the messaging-analytics form, which has NO `data` wrapper", () => {
    // `analytics` puts `data_points` directly on the field object. Requiring the
    // `data` array — as the other surfaces have — would return nothing here, and
    // an empty result reads as "no traffic" rather than as a parse mismatch.
    const out = analyticsDataPoints(
      {
        analytics: {
          phone_numbers: ["16505550111"],
          granularity: "DAY",
          data_points: [point],
        },
      },
      "analytics",
    );
    expect(out).toHaveLength(1);
  });

  it("reads the EDGE form, where the wrapper is unnamed", () => {
    const out = analyticsDataPoints({ data: [{ data_points: [point] }] }, "call_analytics");
    expect(out).toHaveLength(1);
  });

  it("collects points across MULTIPLE nodes rather than stopping at the first", () => {
    const out = analyticsDataPoints(
      { data: [{ data_points: [point] }, { data_points: [point, point] }] },
      "pricing_analytics",
    );
    expect(out).toHaveLength(3);
  });

  it("returns empty — never throws — for absent or malformed payloads", () => {
    // One bad response must not take a whole dashboard down with it.
    expect(analyticsDataPoints({}, "analytics")).toEqual([]);
    expect(analyticsDataPoints(null, "analytics")).toEqual([]);
    expect(analyticsDataPoints({ analytics: "nope" }, "analytics")).toEqual([]);
    expect(analyticsDataPoints({ data: [{ data_points: "nope" }] }, "analytics")).toEqual([]);
  });

  it("skips non-object entries inside data_points", () => {
    const out = analyticsDataPoints(
      { data: [{ data_points: [point, null, 7, ["x"]] }] },
      "analytics",
    );
    expect(out).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Volume tiers
// ---------------------------------------------------------------------------

describe("parseTierBounds", () => {
  it("splits a bounded tier", () => {
    expect(parseTierBounds("0:750000")).toEqual({ lower: 0, upper: 750_000 });
  });

  it("maps an UNBOUNDED tier's upper to null, not a huge number", () => {
    // Meta pins marketing at `0:MAX` because volume tiers don't apply. A
    // sentinel number would render as a reachable target and invite an operator
    // to chase a discount that doesn't exist.
    expect(parseTierBounds("0:MAX")).toEqual({ lower: 0, upper: null });
  });

  it("handles an absent tier — free messages carry none", () => {
    expect(parseTierBounds(null)).toEqual({ lower: null, upper: null });
  });

  it("tolerates a malformed bound instead of throwing", () => {
    expect(parseTierBounds("garbage")).toEqual({ lower: null, upper: null });
  });
});

describe("tierStandings", () => {
  const row = (over: Partial<Parameters<typeof tierStandings>[0][number]> = {}) => ({
    country: "IN",
    category: "UTILITY",
    volume: 100,
    tier: "0:750000",
    tierUpper: 750_000,
    ...over,
  });

  it("SUMS volume across the window's buckets but keeps the bound as-is", () => {
    // Meta repeats the tier bound on every daily point. Volume accumulates;
    // the ceiling is a property of the (country, category) pair, not the day —
    // summing the bound too would report a ceiling of 750k × days.
    const [standing] = tierStandings([row(), row(), row()]);
    expect(standing!.volume).toBe(300);
    expect(standing!.upper).toBe(750_000);
    expect(standing!.toNextTier).toBe(749_700);
  });

  it("keeps the WIDEST bound when the account is promoted mid-window", () => {
    const [standing] = tierStandings([
      row({ tier: "0:750000", tierUpper: 750_000 }),
      row({ tier: "750001:2000000", tierUpper: 2_000_000 }),
    ]);
    // Reporting the old ceiling after a promotion would tell the operator they
    // are near a threshold they have already crossed.
    expect(standing!.upper).toBe(2_000_000);
    expect(standing!.tier).toBe("750001:2000000");
  });

  it("separates each (country, category) pair", () => {
    const out = tierStandings([
      row({ country: "IN", category: "UTILITY" }),
      row({ country: "US", category: "UTILITY" }),
      row({ country: "IN", category: "AUTHENTICATION" }),
    ]);
    expect(out).toHaveLength(3);
  });

  it("SKIPS free rows, which Meta reports with no tier at all", () => {
    // Free messages don't count toward tiering; folding them in would inflate
    // the progress figure with volume that never moves it.
    expect(tierStandings([row({ tier: null, tierUpper: null })])).toEqual([]);
  });

  it("reports no target on an unbounded tier rather than a fake one", () => {
    const [standing] = tierStandings([row({ tier: "0:MAX", tierUpper: null })]);
    expect(standing!.upper).toBeNull();
    expect(standing!.toNextTier).toBeNull();
  });

  it("never reports a NEGATIVE distance once the ceiling is passed", () => {
    const [standing] = tierStandings([row({ volume: 800_000 })]);
    expect(standing!.toNextTier).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

describe("callSlices", () => {
  it("re-weights average duration by CALL COUNT, never a plain mean", () => {
    // The trap: `average_duration` is already an average, so it cannot be
    // summed — and a plain mean of the two buckets below gives 55s, letting a
    // single 1-call bucket count as much as a 499-call one.
    const out = callSlices([
      { direction: "BUSINESS_INITIATED", country: "US", count: 499, cost: 10, averageDuration: 10 },
      { direction: "BUSINESS_INITIATED", country: "US", count: 1, cost: 1, averageDuration: 100 },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.count).toBe(500);
    expect(out[0]!.cost).toBe(11);
    // (499×10 + 1×100) / 500 = 10.18 — not 55.
    expect(out[0]!.averageDurationSec).toBeCloseTo(10.18, 2);
  });

  it("keeps cost NULL when Meta withheld it on every bucket", () => {
    // Partner-billed accounts get volume with no money. Null must survive the
    // merge as null — a 0 would assert the calls were free.
    const out = callSlices([
      { direction: "USER_INITIATED", country: null, count: 3, cost: null, averageDuration: 20 },
    ]);
    expect(out[0]!.cost).toBeNull();
  });

  it("splits by direction, because user-initiated calls are always free", () => {
    const out = callSlices([
      { direction: "USER_INITIATED", country: "US", count: 4, cost: 0, averageDuration: 30 },
      { direction: "BUSINESS_INITIATED", country: "US", count: 2, cost: 5, averageDuration: 60 },
    ]);
    expect(out).toHaveLength(2);
    // Blending them would show a nonzero average cost per call for a set that
    // is mostly free, which is the wrong number to plan against.
    expect(out.find((c) => c.direction === "USER_INITIATED")!.cost).toBe(0);
    expect(out.find((c) => c.direction === "BUSINESS_INITIATED")!.cost).toBe(5);
  });

  it("leaves duration null when no bucket reported one", () => {
    const out = callSlices([
      { direction: "BUSINESS_INITIATED", country: "US", count: 5, cost: 1, averageDuration: null },
    ]);
    expect(out[0]!.averageDurationSec).toBeNull();
  });

  it("ignores a duration attached to a ZERO-count bucket", () => {
    // Weight 0 contributes nothing and must not divide by zero.
    const out = callSlices([
      { direction: "BUSINESS_INITIATED", country: "US", count: 0, cost: null, averageDuration: 42 },
    ]);
    expect(out[0]!.averageDurationSec).toBeNull();
  });
});
