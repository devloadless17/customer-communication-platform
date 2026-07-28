import { describe, expect, it } from "vitest";

import { metaProvider } from "@/lib/providers/meta";

/**
 * `account_alerts` webhook (account-alerts reference doc). The envelope's
 * useful content lives in `alert_info` — type as the discriminator,
 * description as the operator-readable sentence — and `entity_id` names the
 * exact phone number when `entity_type: "PHONE_NUMBER"` (our strongest
 * attribution key: it equals ChannelConnection.externalAccountId verbatim).
 *
 * Pinned: the doc's own example parses into a structured last-alert slot,
 * the PHONE_NUMBER entity flows out as the phoneNumberId hint, and an
 * undocumented variant keeps the JSON-blob fallback instead of regressing
 * to silence.
 */

function envelope(value: Record<string, unknown>) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "waba_1",
        time: 1745612159,
        changes: [{ field: "account_alerts", value }],
      },
    ],
  };
}

describe("account_alerts parse", () => {
  it("parses the doc's example into a structured alert (BUSINESS entity → no number hint)", () => {
    const events = metaProvider.parseWebhook(
      envelope({
        entity_type: "BUSINESS",
        entity_id: "506914307656634",
        alert_info: {
          alert_severity: "WARNING",
          alert_status: "ACTIVE",
          alert_type: "INCREASED_CAPABILITIES_ELIGIBILITY_DEFERRED",
          alert_description:
            "Limits cannot be increased for your business. Use WhatsApp Business platform actively for several days and follow our messaging policies.",
        },
      }),
    );
    const health = events.find((e) => e.kind === "channel_health");
    expect(health).toBeTruthy();
    if (health?.kind !== "channel_health") return;
    expect(health.accountAlert?.event).toBe("INCREASED_CAPABILITIES_ELIGIBILITY_DEFERRED");
    expect(health.accountAlert?.detail).toBe(
      "[WARNING/ACTIVE] Limits cannot be increased for your business. Use WhatsApp Business platform actively for several days and follow our messaging policies.",
    );
    expect(health.phoneNumberId).toBeUndefined();
    expect(health.wabaId).toBe("waba_1");
  });

  it("surfaces entity_id as the phoneNumberId hint for PHONE_NUMBER alerts", () => {
    const events = metaProvider.parseWebhook(
      envelope({
        entity_type: "PHONE_NUMBER",
        entity_id: "106540352242922",
        alert_info: {
          alert_severity: "INFORMATIONAL",
          alert_status: "NONE",
          alert_type: "OBA_APPROVED",
          alert_description:
            "This phone number now has a green badge next to its name.",
        },
      }),
    );
    const health = events.find((e) => e.kind === "channel_health");
    if (health?.kind !== "channel_health") throw new Error("no health event");
    expect(health.phoneNumberId).toBe("106540352242922");
    expect(health.accountAlert?.event).toBe("OBA_APPROVED");
  });

  it("keeps the JSON-blob fallback for undocumented variants (never regresses to silence)", () => {
    const events = metaProvider.parseWebhook(
      envelope({ some_future_field: "surprise", entity_type: "BUSINESS" }),
    );
    const health = events.find((e) => e.kind === "channel_health");
    if (health?.kind !== "channel_health") throw new Error("no health event");
    expect(health.accountAlert?.event).toBeNull();
    expect(health.accountAlert?.detail).toContain("some_future_field");
  });
});

describe("account_review_update parse (account-review-update reference doc)", () => {
  function reviewEnvelope(decision?: string) {
    return {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "waba_1",
          time: 1739321024,
          changes: [
            {
              field: "account_review_update",
              value: decision !== undefined ? { decision } : {},
            },
          ],
        },
      ],
    };
  }

  it("parses the doc's APPROVED example, WABA-attributed", () => {
    const events = metaProvider.parseWebhook(reviewEnvelope("APPROVED"));
    const health = events.find((e) => e.kind === "channel_health");
    if (health?.kind !== "channel_health") throw new Error("no health event");
    expect(health.accountAlert?.source).toBe("account_review_update");
    expect(health.accountAlert?.event).toBe("APPROVED");
    expect(health.wabaId).toBe("waba_1");
  });

  it("REJECTED carries the operator explanation for every send failing", () => {
    const events = metaProvider.parseWebhook(reviewEnvelope("REJECTED"));
    const health = events.find((e) => e.kind === "channel_health");
    if (health?.kind !== "channel_health") throw new Error("no health event");
    expect(health.accountAlert?.detail).toMatch(/cannot be used with the API/);
  });

  it("an unknown decision is recorded verbatim, never dropped", () => {
    const events = metaProvider.parseWebhook(reviewEnvelope("SOME_NEW_STATE"));
    const health = events.find((e) => e.kind === "channel_health");
    if (health?.kind !== "channel_health") throw new Error("no health event");
    expect(health.accountAlert?.event).toBe("SOME_NEW_STATE");
  });
});

describe("phone_number_quality_update current_limit overload (quality-update reference)", () => {
  function qualityEnvelope(value: Record<string, unknown>) {
    return {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "waba_1",
          changes: [{ field: "phone_number_quality_update", value }],
        },
      ],
    };
  }

  it("does NOT read current_limit as a messaging tier on THROUGHPUT_UPGRADE (the doc's own example)", () => {
    const events = metaProvider.parseWebhook(
      qualityEnvelope({
        display_phone_number: "15550783881",
        event: "THROUGHPUT_UPGRADE",
        current_limit: "TIER_UNLIMITED",
      }),
    );
    // No tier, no quality → nothing usable; a wrong read here would have set
    // the portfolio's 24h cap to UNLIMITED off a throughput event.
    const health = events.find((e) => e.kind === "channel_health");
    expect(
      health?.kind === "channel_health" ? health.messagingTier : undefined,
    ).toBeUndefined();
  });

  it("still reads current_limit as the (legacy) messaging limit on other events", () => {
    const events = metaProvider.parseWebhook(
      qualityEnvelope({
        display_phone_number: "15550783881",
        event: "ONBOARDING",
        current_limit: "TIER_2K",
      }),
    );
    const health = events.find((e) => e.kind === "channel_health");
    if (health?.kind !== "channel_health") throw new Error("no health event");
    expect(health.messagingTier).toBe("TIER_2K");
  });

  it("max_daily_conversations_per_business wins regardless of event", () => {
    const events = metaProvider.parseWebhook(
      qualityEnvelope({
        display_phone_number: "15550783881",
        event: "THROUGHPUT_UPGRADE",
        current_limit: "TIER_UNLIMITED",
        max_daily_conversations_per_business: "TIER_2K",
      }),
    );
    const health = events.find((e) => e.kind === "channel_health");
    if (health?.kind !== "channel_health") throw new Error("no health event");
    expect(health.messagingTier).toBe("TIER_2K");
  });
});

describe("account_update spam-enforcement restrictions (policy-enforcement guide)", () => {
  function restrictionEnvelope(value: Record<string, unknown>) {
    return {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "waba_1",
          time: 1745612159,
          changes: [{ field: "account_update", value }],
        },
      ],
    };
  }
  const EXPIRY = 1_790_000_000;

  it("routes every entry of a full 5/7/30-day block — first-match-wins would drop half of it", () => {
    // The guide's severe tier: a block on ALL messages arrives as
    // BIZ_INITIATED + CUSTOMER_INITIATED + ADD_PHONE entries in ONE webhook.
    const events = metaProvider.parseWebhook(
      restrictionEnvelope({
        event: "ACCOUNT_RESTRICTION",
        restriction_info: [
          { restriction_type: "RESTRICTED_BIZ_INITIATED_MESSAGING", expiration: EXPIRY },
          { restriction_type: "RESTRICTED_CUSTOMER_INITIATED_MESSAGING", expiration: EXPIRY },
          { restriction_type: "RESTRICTED_ADD_PHONE_NUMBER_ACTION", expiration: EXPIRY },
        ],
      }),
    );
    const health = events.find((e) => e.kind === "channel_health");
    if (health?.kind !== "channel_health") throw new Error("no health event");
    expect(health.bizMessagingRestrictionType).toBe("RESTRICTED_BIZ_INITIATED_MESSAGING");
    expect(health.bizMessagingRestrictedUntil?.getTime()).toBe(EXPIRY * 1000);
    expect(health.customerMessagingRestrictionType).toBe(
      "RESTRICTED_CUSTOMER_INITIATED_MESSAGING",
    );
    expect(health.customerMessagingRestrictedUntil?.getTime()).toBe(EXPIRY * 1000);
    // The unrecognised ADD_PHONE leg lands in the alert slot, never silence.
    expect(health.accountAlert?.detail).toContain("RESTRICTED_ADD_PHONE_NUMBER_ACTION");
    // Partial state: the other enforcement families stay untouched, not cleared.
    expect(health.utilityRestrictionType).toBeUndefined();
    expect(health.callingRestrictionType).toBeUndefined();
    expect(health.wabaId).toBe("waba_1");
  });

  it("a 1/3-day template block restricts ONLY the business-initiated direction", () => {
    const events = metaProvider.parseWebhook(
      restrictionEnvelope({
        event: "ACCOUNT_RESTRICTION",
        restriction_info: [
          { restriction_type: "RESTRICTED_BIZ_INITIATED_MESSAGING", expiration: EXPIRY },
        ],
      }),
    );
    const health = events.find((e) => e.kind === "channel_health");
    if (health?.kind !== "channel_health") throw new Error("no health event");
    expect(health.bizMessagingRestrictionType).toBe("RESTRICTED_BIZ_INITIATED_MESSAGING");
    // Replies still work — the customer direction must stay untouched.
    expect(health.customerMessagingRestrictionType).toBeUndefined();
    // Everything recognised → no spurious alert.
    expect(health.accountAlert).toBeUndefined();
  });

  it("mixed utility + calling + messaging entries all land on one update", () => {
    const events = metaProvider.parseWebhook(
      restrictionEnvelope({
        event: "ACCOUNT_RESTRICTION",
        restriction_info: [
          { restriction_type: "RATE_LIMITED_UTILITY_TEMPLATE_MESSAGING", expiration: EXPIRY },
          { restriction_type: "RESTRICTED_BUSINESS_INITIATED_CALLING", expiration: EXPIRY },
          { restriction_type: "RESTRICTED_BIZ_INITIATED_MESSAGING", expiration: EXPIRY },
        ],
      }),
    );
    const health = events.find((e) => e.kind === "channel_health");
    if (health?.kind !== "channel_health") throw new Error("no health event");
    expect(health.utilityRestrictionType).toBe("RATE_LIMITED_UTILITY_TEMPLATE_MESSAGING");
    expect(health.callingRestrictionType).toBe("RESTRICTED_BUSINESS_INITIATED_CALLING");
    expect(health.bizMessagingRestrictionType).toBe("RESTRICTED_BIZ_INITIATED_MESSAGING");
    expect(health.accountAlert).toBeUndefined();
  });

  it("ignoring the non-preferred calling direction is not an 'unknown restriction' alert", () => {
    const events = metaProvider.parseWebhook(
      restrictionEnvelope({
        event: "ACCOUNT_RESTRICTION",
        restriction_info: [
          { restriction_type: "RESTRICTED_BUSINESS_INITIATED_CALLING", expiration: EXPIRY },
          { restriction_type: "RESTRICTED_USER_INITIATED_CALLING", expiration: EXPIRY },
        ],
      }),
    );
    const health = events.find((e) => e.kind === "channel_health");
    if (health?.kind !== "channel_health") throw new Error("no health event");
    expect(health.callingRestrictionType).toBe("RESTRICTED_BUSINESS_INITIATED_CALLING");
    expect(health.accountAlert).toBeUndefined();
  });

  it("DISABLED_UPDATE DISABLE marks both directions blocked indefinitely (the account-lock leg)", () => {
    const events = metaProvider.parseWebhook(
      restrictionEnvelope({
        event: "DISABLED_UPDATE",
        ban_info: { waba_ban_state: "DISABLE", waba_ban_date: "January 31, 2027" },
      }),
    );
    const health = events.find((e) => e.kind === "channel_health");
    if (health?.kind !== "channel_health") throw new Error("no health event");
    expect(health.bizMessagingRestrictionType).toBe("WABA_BAN_DISABLE");
    expect(health.customerMessagingRestrictionType).toBe("WABA_BAN_DISABLE");
    // Indefinite: a ban has no expiry — cleared only by REINSTATE.
    expect(health.bizMessagingRestrictedUntil).toBeNull();
    expect(health.accountAlert?.event).toBe("DISABLED_UPDATE:DISABLE");
    expect(health.accountAlert?.detail).toContain("January 31, 2027");
  });

  it("DISABLED_UPDATE REINSTATE clears both stored directions (appeal reversed the ban)", () => {
    const events = metaProvider.parseWebhook(
      restrictionEnvelope({
        event: "DISABLED_UPDATE",
        ban_info: { waba_ban_state: "REINSTATE" },
      }),
    );
    const health = events.find((e) => e.kind === "channel_health");
    if (health?.kind !== "channel_health") throw new Error("no health event");
    // Explicit nulls (clear), not undefined (untouched) — the distinction the
    // whole health-update contract rides on.
    expect(health.bizMessagingRestrictionType).toBeNull();
    expect(health.customerMessagingRestrictionType).toBeNull();
  });

  it("an unknown ban state falls back to the generic trace, never silence", () => {
    const events = metaProvider.parseWebhook(
      restrictionEnvelope({
        event: "DISABLED_UPDATE",
        ban_info: { waba_ban_state: "SOME_NEW_STATE" },
      }),
    );
    const health = events.find((e) => e.kind === "channel_health");
    if (health?.kind !== "channel_health") throw new Error("no health event");
    expect(health.bizMessagingRestrictionType).toBeUndefined();
    expect(health.accountAlert?.detail).toContain("SOME_NEW_STATE");
  });
});

describe("standalone value.errors → persisted alert (local-storage / No-Storage doc)", () => {
  it("parses the doc's 131035 example — a permanently dropped inbound gets an operator sentence", () => {
    // No-Storage numbers: webhook undeliverable past the 1-hour retention →
    // Meta drops the inbound and this errors webhook is the ONLY signal the
    // customer's message ever existed. Used to be warn-logged and invisible.
    const events = metaProvider.parseWebhook({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "102290129340398",
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: {
                  display_phone_number: "15550783881",
                  phone_number_id: "106540352242922",
                },
                errors: [
                  {
                    code: 131035,
                    title: "Webhook could not be delivered within data retention limit",
                    message: "Webhook could not be delivered within data retention limit",
                    error_data: {
                      details: "Webhook could not be delivered within data retention limit",
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    const health = events.find((e) => e.kind === "channel_health");
    if (health?.kind !== "channel_health") throw new Error("no health event");
    expect(health.accountAlert?.source).toBe("webhook_errors");
    expect(health.accountAlert?.event).toBe("131035");
    expect(health.accountAlert?.detail).toMatch(/permanently dropped/i);
    // Number-attributed so the alert lands on the right ChannelConnection.
    expect(health.phoneNumberId).toBe("106540352242922");
  });

  it("a non-131035 standalone error carries Meta's own title/detail verbatim", () => {
    const events = metaProvider.parseWebhook({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "waba_1",
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: { phone_number_id: "106540352242922" },
                errors: [
                  {
                    code: 130429,
                    title: "Rate limit hit",
                    error_data: { details: "Cloud API message throughput has been reached" },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    const health = events.find((e) => e.kind === "channel_health");
    if (health?.kind !== "channel_health") throw new Error("no health event");
    expect(health.accountAlert?.event).toBe("130429");
    expect(health.accountAlert?.detail).toContain("Rate limit hit");
    expect(health.accountAlert?.detail).toContain("throughput has been reached");
  });
});

describe("security webhook (security reference doc)", () => {
  function securityEnvelope(value: Record<string, unknown>) {
    return {
      object: "whatsapp_business_account",
      entry: [
        { id: "waba_1", time: 1748811473, changes: [{ field: "security", value }] },
      ],
    };
  }

  it("parses the doc's PIN_RESET_REQUEST example with the requester named", () => {
    const events = metaProvider.parseWebhook(
      securityEnvelope({
        display_phone_number: "15550783881",
        event: "PIN_RESET_REQUEST",
        requester: "61555822107539",
      }),
    );
    const health = events.find((e) => e.kind === "channel_health");
    if (health?.kind !== "channel_health") throw new Error("no health event");
    expect(health.accountAlert?.source).toBe("security");
    expect(health.accountAlert?.event).toBe("PIN_RESET_REQUEST");
    expect(health.accountAlert?.detail).toContain("61555822107539");
    // Per-number attribution rides the flat display number hint.
    expect(health.displayPhoneNumber).toBe("15550783881");
  });

  it("PIN_REQUEST_SUCCESS tells the operator to re-enable the PIN", () => {
    const events = metaProvider.parseWebhook(
      securityEnvelope({ display_phone_number: "15550783881", event: "PIN_REQUEST_SUCCESS" }),
    );
    const health = events.find((e) => e.kind === "channel_health");
    if (health?.kind !== "channel_health") throw new Error("no health event");
    expect(health.accountAlert?.detail).toMatch(/re-enable a PIN/i);
  });

  it("an unknown security event is recorded verbatim, never dropped", () => {
    const events = metaProvider.parseWebhook(
      securityEnvelope({ display_phone_number: "15550783881", event: "NEW_THING" }),
    );
    const health = events.find((e) => e.kind === "channel_health");
    if (health?.kind !== "channel_health") throw new Error("no health event");
    expect(health.accountAlert?.event).toBe("NEW_THING");
  });
});
