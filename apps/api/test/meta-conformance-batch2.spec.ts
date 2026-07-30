/**
 * Regressions for three doc-conformance fixes (audit 2026-07-30, batch 2).
 *
 *  - W1-04 `messaging_account_id` belongs on CALLING endpoints too, not only
 *    /messages. Changelog 2026-06-16 names "messaging **and calling** endpoints".
 *  - W2-03 Meta caps LIST row ids at 200 while BUTTON reply ids allow 256. The
 *    provider declines to truncate a list id on the stated grounds that the
 *    request schemas reject >200 at authoring time — they did not.
 *  - W11-01 `UNTIERED` is a documented `whatsapp_business_manager_messaging_limit`
 *    value that normalized to null, making it indistinguishable from
 *    TIER_UNLIMITED (which also has a null cap).
 *
 *   pnpm --filter @ccp/api exec vitest run test/meta-conformance-batch2.spec.ts
 */
import { describe, expect, it } from "vitest";

import { normalizeMessagingTier, tierDailyCap } from "@/lib/providers/meta-health";
import {
  classifyMetaStatusError,
  failureBucket,
} from "@/lib/providers/meta-send-error";
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
