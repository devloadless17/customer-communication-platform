import { describe, expect, it } from "vitest";

import { metaProvider } from "@/lib/providers/meta";

/**
 * `user_preferences` webhook (user-preferences reference doc) — the ONLY
 * signal allowed to clear a marketing opt-out, which makes its gating a
 * consent control. Pinned:
 *
 *  - both observed category spellings pass ("marketing" from the older docs,
 *    "marketing_messages" from the current reference — Meta renamed it once
 *    already), and an ABSENT category passes (older payloads);
 *  - an unknown category is skipped: clearing a marketing opt-out off a
 *    future non-marketing "resume" would be a consent violation;
 *  - stop → optedOut, resume → !optedOut, junk values dropped.
 */

function envelope(pref: Record<string, unknown>) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "waba_1",
        changes: [
          {
            field: "user_preferences",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "15550783881", phone_number_id: "pn_1" },
              contacts: [{ wa_id: "16505551234" }],
              user_preferences: [pref],
            },
          },
        ],
      },
    ],
  };
}

function prefEvent(events: ReturnType<typeof metaProvider.parseWebhook>) {
  return events.find((e) => e.kind === "marketing_preference");
}

describe("user_preferences parse", () => {
  it("parses the doc's resume example (category marketing_messages)", () => {
    const evt = prefEvent(
      metaProvider.parseWebhook(
        envelope({
          wa_id: "16505551234",
          detail: "User requested to resume marketing messages",
          category: "marketing_messages",
          value: "resume",
          timestamp: 1731705721,
        }),
      ),
    );
    if (evt?.kind !== "marketing_preference") throw new Error("no event");
    expect(evt.optedOut).toBe(false);
    expect(evt.contactPhone).toBe("16505551234");
    expect(evt.timestamp.getTime()).toBe(1731705721 * 1000);
  });

  it("accepts the older 'marketing' spelling and an absent category", () => {
    for (const category of ["marketing", undefined]) {
      const evt = prefEvent(
        metaProvider.parseWebhook(
          envelope({ wa_id: "16505551234", value: "stop", ...(category ? { category } : {}) }),
        ),
      );
      if (evt?.kind !== "marketing_preference") throw new Error("no event");
      expect(evt.optedOut).toBe(true);
    }
  });

  it("skips unknown categories — a non-marketing resume must not clear a marketing opt-out", () => {
    const events = metaProvider.parseWebhook(
      envelope({ wa_id: "16505551234", category: "calls", value: "resume" }),
    );
    expect(prefEvent(events)).toBeUndefined();
  });

  it("drops junk values and missing wa_id", () => {
    expect(
      prefEvent(metaProvider.parseWebhook(envelope({ wa_id: "165", value: "maybe" }))),
    ).toBeUndefined();
    expect(
      prefEvent(metaProvider.parseWebhook(envelope({ value: "stop" }))),
    ).toBeUndefined();
  });
});
