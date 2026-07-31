/**
 * Regressions for the doc-conformance fixes of 2026-07-30, batches 2-3.
 *
 *  - W13-01 `131051` is "Unsupported message type", but sat in `invalid_recipient`
 *    — the ONE bucket that tells the operator to delete the contact.
 *  - W2-03 Meta caps LIST row ids at 200 while BUTTON reply ids allow 256. The
 *    provider declines to truncate a list id on the stated grounds that the
 *    request schemas reject >200 at authoring time — they did not.
 *  - W11-01 `UNTIERED` is a documented `whatsapp_business_manager_messaging_limit`
 *    value that normalized to null, making it indistinguishable from
 *    TIER_UNLIMITED (which also has a null cap).
 *  - BSUID addressing: `resolveContactChannel` carries the BSUID in `.to` and
 *    flags `viaBsuid`; the WIRE form is the provider's call (re-verified
 *    2026-07-31: `whatsappDestination()` emits the top-level `recipient` field
 *    for BSUIDs, with a one-shot legacy-`to` retry on a #100 — see
 *    ResolvedChannel's docblock). A BSUID address cannot receive
 *    authentication templates (131062).
 *
 *   pnpm --filter @ccp/api exec vitest run test/meta-conformance-batch2.spec.ts
 */
import { describe, expect, it } from "vitest";

import { normalizeMessagingTier, tierDailyCap } from "@/lib/providers/meta-health";
import {
  classifyMetaStatusError,
  failureBucket,
} from "@/lib/providers/meta-send-error";
import { resolveContactChannel } from "@/lib/providers/channel";
import { mergePricingSlices } from "@/lib/analytics/waba-analytics";
import {
  resolveSendRate,
  resolveSocialSendRate,
} from "@/lib/broadcasts/send-rate-limiter";
import { SendInteractiveSchema } from "@/messages/messages.schemas";

describe("W13-01 · 131051 is an unsupported MESSAGE, not a bad recipient", () => {
  it("does not classify 131051 as invalid_recipient", () => {
    // `invalid_recipient` is the ONLY bucket that tells the operator to delete
    // the contact. Meta documents 131051 as "Unsupported message type", so
    // bucketing it there had the campaign report recommending they purge
    // perfectly reachable customers.
    expect(classifyMetaStatusError(131051)).toBe("unsupported_message");
    expect(classifyMetaStatusError(131051)).not.toBe("invalid_recipient");
  });

  it("no longer buckets 131051 as permanent (the delete-the-contact bucket)", () => {
    expect(failureBucket(classifyMetaStatusError(131051))).not.toBe("permanent");
  });

  it("leaves 131026 — a genuinely unreachable number — as invalid_recipient", () => {
    expect(classifyMetaStatusError(131026)).toBe("invalid_recipient");
    expect(failureBucket("invalid_recipient")).toBe("permanent");
  });
});

describe("BSUID addressing · to-field is correct, auth templates are not", () => {
  const phoneContact = {
    phoneNumber: "15551234567",
    identityChannel: "whatsapp" as const,
    externalContactId: null,
    bsuid: null,
  };
  const bsuidOnly = {
    phoneNumber: null,
    identityChannel: "whatsapp" as const,
    externalContactId: null,
    bsuid: "LB.946402411360800",
  };

  it("carries the BSUID in `.to` — the resolver's address slot, not the wire field", () => {
    // The resolver hands one destination string to every send path; the WIRE
    // form is the provider's decision — `whatsappDestination()` moves a
    // viaBsuid destination to Meta's top-level `recipient` field (re-verified
    // 2026-07-31, superseding the earlier `to`-only reading) with a one-shot
    // legacy-`to` retry for rollout lag.
    expect(resolveContactChannel(bsuidOnly).to).toBe("LB.946402411360800");
  });

  it("flags a BSUID destination so send paths can refuse what it can't receive", () => {
    expect(resolveContactChannel(bsuidOnly).viaBsuid).toBe(true);
    expect(resolveContactChannel(phoneContact).viaBsuid).toBeUndefined();
    expect(resolveContactChannel(phoneContact).to).toBe("15551234567");
  });

  it("classifies 131062 as a content problem, never as a bad contact", () => {
    // "You can only send authentication messages to recipients' phone numbers,
    // not their business-scoped user IDs." Every BSUID-only recipient fails the
    // same way, so pointing the operator at their contact list is wrong.
    expect(classifyMetaStatusError(131062)).toBe("bsuid_needs_phone");
    expect(failureBucket("bsuid_needs_phone")).toBe("content");
    expect(failureBucket("bsuid_needs_phone")).not.toBe("permanent");
  });
});

describe("W11-01 · UNTIERED is recognised and distinct from unlimited", () => {
  it("normalizes UNTIERED to itself rather than dropping it to null", () => {
    // Dropping to null made it identical to "no snapshot at all".
    expect(normalizeMessagingTier("UNTIERED")).toBe("UNTIERED");
    expect(normalizeMessagingTier("untiered")).toBe("UNTIERED");
  });

  it("keeps UNTIERED distinguishable from TIER_UNLIMITED even though both are uncapped", () => {
    // Both carry a null cap — the STRING is what tells them apart, which is the
    // whole point of recognising the token.
    expect(tierDailyCap("UNTIERED")).toBeNull();
    expect(tierDailyCap("TIER_UNLIMITED")).toBeNull();
    expect(normalizeMessagingTier("UNTIERED")).not.toBe(normalizeMessagingTier("UNLIMITED"));
  });

  it("still sizes the real ladder correctly", () => {
    expect(tierDailyCap(normalizeMessagingTier("TIER_2K"))).toBe(2_000);
    expect(tierDailyCap(normalizeMessagingTier("250"))).toBe(250);
    expect(normalizeMessagingTier("something Meta never shipped")).toBeNull();
  });
});

describe("W2-03 · list row ids cap at 200, button ids at 256", () => {
  const base = { conversationId: "c1", body: "pick one" };
  const opt = (id: string) => ({ id, title: "t" });

  it("rejects a 201-char LIST row id instead of letting Meta fail opaquely", () => {
    const res = SendInteractiveSchema.safeParse({
      ...base,
      kind: "list",
      options: [opt("x".repeat(201))],
    });
    expect(res.success).toBe(false);
    // Assert it failed for the RIGHT reason — a fixture typo would otherwise
    // make this pass on a missing-field error and prove nothing.
    expect(JSON.stringify(res.error?.issues)).toContain("200 characters");
  });

  it("accepts a 200-char LIST row id (the documented ceiling, not one below it)", () => {
    const res = SendInteractiveSchema.safeParse({
      ...base,
      kind: "list",
      options: [opt("x".repeat(200))],
    });
    expect(res.success, JSON.stringify(res.error?.issues)).toBe(true);
  });

  it("still allows a 256-char BUTTON reply id — the caps genuinely differ", () => {
    const res = SendInteractiveSchema.safeParse({
      ...base,
      kind: "buttons",
      options: [opt("x".repeat(256))],
    });
    expect(res.success, JSON.stringify(res.error?.issues)).toBe(true);
  });
});

describe("W6-07 · pricing slices are AGGREGATED, not one row per time bucket", () => {
  const pt = (over: Partial<Parameters<typeof mergePricingSlices>[0][number]> = {}) => ({
    category: "MARKETING",
    type: "REGULAR",
    country: "US",
    phoneNumber: "15550001111",
    volume: 10,
    cost: 1.5,
    ...over,
  });

  it("collapses identical dimension combinations across buckets", () => {
    // Meta emits one point per TIME BUCKET per combination. Un-merged, a 30-day
    // window rendered twelve rows all reading "Marketing · Billed · US" with no
    // date column to tell them apart, so the per-category breakdown — the table's
    // whole purpose — was never visible.
    const out = mergePricingSlices([pt(), pt(), pt()]);
    expect(out).toHaveLength(1);
    expect(out[0]!.volume).toBe(30);
    expect(out[0]!.cost).toBeCloseTo(4.5);
  });

  it("keeps genuinely different slices apart, including by phone number", () => {
    const out = mergePricingSlices([
      pt(),
      pt({ category: "UTILITY" }),
      pt({ country: "GB" }),
      pt({ phoneNumber: "15550002222" }),
    ]);
    expect(out).toHaveLength(4);
  });

  it("keeps cost NULL when every contributing point withheld it", () => {
    // "Meta didn't report the cost" and "it cost nothing" are different facts, and
    // `costWithheld` (the Solution-Partner case) depends on telling them apart.
    const out = mergePricingSlices([pt({ cost: null }), pt({ cost: null })]);
    expect(out).toHaveLength(1);
    expect(out[0]!.cost).toBeNull();
    expect(out[0]!.volume).toBe(20);
  });

  it("sums the reported costs when only SOME points withheld", () => {
    const out = mergePricingSlices([pt({ cost: null }), pt({ cost: 2 })]);
    expect(out[0]!.cost).toBe(2);
  });

  it("treats a null volume as zero rather than NaN-ing the total", () => {
    const out = mergePricingSlices([pt({ volume: null }), pt({ volume: 5 })]);
    expect(out[0]!.volume).toBe(5);
  });
});

describe("MACC-03 · social broadcasts pace off Meta's PAGE limits, not WhatsApp's ladder", () => {
  // The channel argument became REQUIRED once Instagram got its own ceilings:
  // the ~40/s Page-inbox limit these cases are about is Messenger's, and
  // Instagram has no equivalent (its binding figure is 100/s, with a separate
  // cumulative 72,000-message ceiling). Naming the channel here keeps each
  // assertion about the limit it was actually written for.
  it("keeps the MESSENGER rate strictly UNDER Meta's ~40/s Page-inbox ceiling", () => {
    // That ceiling is the binding one — 300/s is the text limit, but past ~40 msg/s
    // the Page silently stops sending, which is worse than an error. Sitting AT 40
    // means the first burst is what discovers it.
    const rate = resolveSocialSendRate("messenger");
    expect(rate).toBeLessThan(40);
    expect(rate).toBeGreaterThan(0);
  });

  it("is NOT the WhatsApp baseline it used to inherit", () => {
    // Social carries no `throughput.level`, so routing it through resolveSendRate
    // landed on the WhatsApp BASELINE — the right ballpark by accident, for the
    // wrong reason, and exactly on the ceiling.
    expect(resolveSocialSendRate("messenger")).not.toBe(resolveSendRate(null, false));
  });

  it("still paces WhatsApp off the throughput ladder and the Coexistence cap", () => {
    expect(resolveSendRate("HIGH", false)).toBeGreaterThan(resolveSocialSendRate("messenger"));
    // Coexistence is a FIXED cap outside the ladder, and must win over the level.
    expect(resolveSendRate("HIGH", true)).toBeLessThanOrEqual(20);
  });
});
