import { describe, expect, it } from "vitest";

import { metaProvider } from "@/lib/providers/meta";

/**
 * Inbound NFM submissions (`interactive.type: "nfm_reply"`) — the reply shape
 * for WhatsApp Flows AND address-message forms (address-messages doc).
 *
 * Two contracts under test:
 *   1. An nfm_reply is NEVER dropped (we 200 the webhook — a drop is
 *      permanent loss of the customer's submission).
 *   2. When Meta sends `nfm_reply.body` — the human-readable summary the
 *      customer sees in their own chat (for an address form: the address) —
 *      the bubble shows THAT, not a generic placeholder. The structured
 *      `response_json` stays recoverable via rawPayload.
 */

const ADDRESS_BODY =
  "CUSTOMER_NAME\n +91xxxxxxxxxx\n 400063, Goregaon, Wing A, Cello Triumph,IB Patel Rd, Mumbai, 8";

function envelope(interactive: Record<string, unknown>) {
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
              metadata: { display_phone_number: "9611234567", phone_number_id: "pn_1" },
              contacts: [{ profile: { name: "Customer" }, wa_id: "917000000001" }],
              messages: [
                {
                  from: "917000000001",
                  id: "wamid.NFM_TEST_1",
                  timestamp: "1671498855",
                  type: "interactive",
                  interactive,
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

describe("inbound nfm_reply", () => {
  it("renders the customer-visible body (address form) instead of a placeholder", () => {
    const events = metaProvider.parseWebhook(
      envelope({
        type: "nfm_reply",
        nfm_reply: {
          response_json: '{"values":{"city":"Mumbai"}}',
          body: ADDRESS_BODY,
          name: "address_message",
        },
      }),
    );
    const msg = events.find((e) => e.kind === "message");
    expect(msg).toBeTruthy();
    expect(msg && "body" in msg ? msg.body : null).toBe(ADDRESS_BODY);
    expect(msg && "externalId" in msg ? msg.externalId : null).toBe("wamid.NFM_TEST_1");
  });

  it("falls back to the form placeholder when Meta omits body (it's optional)", () => {
    const events = metaProvider.parseWebhook(
      envelope({
        type: "nfm_reply",
        nfm_reply: { response_json: '{"values":{}}', name: "address_message" },
      }),
    );
    const msg = events.find((e) => e.kind === "message");
    expect(msg && "body" in msg ? msg.body : null).toBe("📝 Form response");
  });

  it("still never drops an unknown interactive subtype", () => {
    const events = metaProvider.parseWebhook(
      envelope({ type: "some_future_subtype" }),
    );
    const msg = events.find((e) => e.kind === "message");
    expect(msg && "body" in msg ? msg.body : null).toBe("💬 Interactive reply");
  });
});
