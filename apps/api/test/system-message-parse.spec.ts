import { describe, expect, it } from "vitest";

import { metaProvider } from "@/lib/providers/meta";

/**
 * Inbound `type:"system"` notices (identity-change doc).
 *
 * `user_changed_number` has a dedicated contact-migration path; every OTHER
 * system subtype must surface Meta's own `system.body` sentence as the bubble
 * instead of a context-free "Unsupported message (system)". The load-bearing
 * case is the opt-in identity-change signal: once it fires, Meta BLOCKS every
 * outbound to that person until the business acknowledges, so this bubble is
 * the only in-inbox explanation agents get for sends suddenly failing.
 */

function systemEnvelope(system: Record<string, unknown>) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "waba_1",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "15550783881", phone_number_id: "pn_1" },
              messages: [
                {
                  from: "16505551234",
                  id: "wamid.SYSTEM_TEST_1",
                  timestamp: "1671498855",
                  type: "system",
                  system,
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

describe("inbound system notices", () => {
  it("surfaces Meta's own body sentence for a non-number-change system notice", () => {
    const events = metaProvider.parseWebhook(
      systemEnvelope({
        body: "User A's identity may have changed",
        type: "user_identity_changed",
      }),
    );
    const msg = events.find((e) => e.kind === "message");
    expect(msg).toBeTruthy();
    expect(msg && "body" in msg ? msg.body : null).toBe(
      "ℹ️ User A's identity may have changed",
    );
  });

  it("falls back to a typed notice when Meta omits the body", () => {
    const events = metaProvider.parseWebhook(
      systemEnvelope({ type: "some_future_notice" }),
    );
    const msg = events.find((e) => e.kind === "message");
    expect(msg && "body" in msg ? msg.body : null).toBe(
      "ℹ️ WhatsApp system notice (some future notice)",
    );
  });

  it("user_changed_number still routes to contact migration, never a bubble", () => {
    const events = metaProvider.parseWebhook(
      systemEnvelope({
        body: "User A changed from 16505551234 to 16505559999",
        type: "user_changed_number",
        wa_id: "16505559999",
      }),
    );
    expect(events.find((e) => e.kind === "message")).toBeUndefined();
    const change = events.find((e) => e.kind === "contact_number_change");
    if (change?.kind !== "contact_number_change") throw new Error("no migration event");
    expect(change.oldPhone).toBe("16505551234");
    expect(change.newPhone).toBe("16505559999");
  });
});
