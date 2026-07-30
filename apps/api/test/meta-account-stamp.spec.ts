/**
 * Per-event account stamping in the Meta parsers. Pure parse, no DB.
 *
 * Meta's webhook contract: `entry` is an array, and "multiple changes from
 * DIFFERENT OBJECTS that are of the same type may be batched together" (up to
 * 1000 updates, with batching guaranteed in neither direction). The parsers used
 * to emit events with no account on them at all, and the route resolved ONE
 * account for the whole POST body — so in a two-number / two-Page workspace the
 * second account's threads were re-stamped onto the first, and the agent's reply
 * went out a number with no open 24h customer-service window.
 *
 * Pinned here:
 *   1. Every event from a `messages` / `statuses` / `calls` / `smb_message_echoes`
 *      / `history` change carries `externalAccountId === metadata.phone_number_id`.
 *   2. A TWO-ENTRY, TWO-NUMBER body yields events carrying BOTH ids — the exact
 *      regression.
 *   3. Account-level changes stay UNSTAMPED (so ingest resolves their own
 *      subject) while still carrying `wabaId`.
 *   4. Messenger and Instagram stamp their own `entry[].id` per entry.
 *   5. `scanWhatsappEnvelope` reports history + every distinct number.
 *
 *   pnpm --filter @ccp/api exec vitest run test/meta-account-stamp.spec.ts
 */
import { describe, expect, it } from "vitest";

import { metaProvider, scanWhatsappEnvelope } from "@/lib/providers/meta";
import { messengerProvider } from "@/lib/providers/messenger";
import { instagramProvider } from "@/lib/providers/instagram";

const PN_A = "pn_aaa";
const PN_B = "pn_bbb";
const WABA_A = "waba_aaa";
const WABA_B = "waba_bbb";

function textChange(phoneNumberId: string, from: string, wamid: string) {
  return {
    field: "messages",
    value: {
      messaging_product: "whatsapp",
      metadata: { display_phone_number: "15550000001", phone_number_id: phoneNumberId },
      contacts: [{ profile: { name: "Cust" }, wa_id: from }],
      messages: [
        { from, id: wamid, timestamp: "1738796547", type: "text", text: { body: "hi" } },
      ],
    },
  };
}

describe("WhatsApp: the receiving number is stamped per change", () => {
  it("stamps metadata.phone_number_id onto an inbound message", () => {
    const events = metaProvider.parseWebhook({
      object: "whatsapp_business_account",
      entry: [{ id: WABA_A, changes: [textChange(PN_A, "16505551234", "wamid.ONE")] }],
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe("message");
    expect(events[0]!.externalAccountId).toBe(PN_A);
  });

  it("a TWO-ENTRY body for TWO numbers stamps each event with its own number", () => {
    // This is the batched POST the old per-body resolve mis-attributed wholesale.
    const events = metaProvider.parseWebhook({
      object: "whatsapp_business_account",
      entry: [
        { id: WABA_A, changes: [textChange(PN_A, "16505551234", "wamid.A1")] },
        { id: WABA_B, changes: [textChange(PN_B, "16505559999", "wamid.B1")] },
      ],
    });
    expect(events).toHaveLength(2);
    const byId = new Map(
      events.map((e) => [("externalId" in e ? e.externalId : "") as string, e.externalAccountId]),
    );
    expect(byId.get("wamid.A1")).toBe(PN_A);
    expect(byId.get("wamid.B1")).toBe(PN_B);
  });

  it("stamps two numbers batched inside ONE entry's changes[] too", () => {
    const events = metaProvider.parseWebhook({
      object: "whatsapp_business_account",
      entry: [
        {
          id: WABA_A,
          changes: [
            textChange(PN_A, "16505551234", "wamid.SAME_ENTRY_A"),
            textChange(PN_B, "16505559999", "wamid.SAME_ENTRY_B"),
          ],
        },
      ],
    });
    expect(events.map((e) => e.externalAccountId).sort()).toEqual([PN_A, PN_B].sort());
  });

  it("stamps a status update with the number that reported it", () => {
    const events = metaProvider.parseWebhook({
      object: "whatsapp_business_account",
      entry: [
        {
          id: WABA_B,
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: { display_phone_number: "15550000002", phone_number_id: PN_B },
                statuses: [
                  {
                    id: "wamid.OUT",
                    status: "delivered",
                    timestamp: "1738796600",
                    recipient_id: "16505551234",
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe("status");
    expect(events[0]!.externalAccountId).toBe(PN_B);
  });

  it("leaves ACCOUNT-LEVEL changes unstamped but keeps the WABA hint", () => {
    // No `metadata` on the value → the subject is the WABA / a number named in
    // the body, which ingest resolves per-event. Stamping the arriving account
    // here is exactly what wrote number B's quality onto number A.
    const events = metaProvider.parseWebhook({
      object: "whatsapp_business_account",
      entry: [
        {
          id: WABA_B,
          changes: [
            {
              field: "phone_number_quality_update",
              value: {
                display_phone_number: "15550000002",
                event: "FLAGGED",
                current_limit: "TIER_10K",
              },
            },
          ],
        },
      ],
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.externalAccountId).toBeUndefined();
    expect((events[0] as { wabaId?: string }).wabaId).toBe(WABA_B);
  });

  it("keeps a message stamped even when batched WITH an account-level change", () => {
    // The mixed batch: one change names a number, the other doesn't. Each event
    // must keep its own answer.
    const events = metaProvider.parseWebhook({
      object: "whatsapp_business_account",
      entry: [
        { id: WABA_A, changes: [textChange(PN_A, "16505551234", "wamid.MIXED")] },
        {
          id: WABA_B,
          changes: [
            {
              field: "phone_number_quality_update",
              value: { display_phone_number: "15550000002", event: "FLAGGED" },
            },
          ],
        },
      ],
    });
    const message = events.find((e) => e.kind === "message");
    const health = events.find((e) => e.kind === "channel_health");
    expect(message?.externalAccountId).toBe(PN_A);
    expect(health?.externalAccountId).toBeUndefined();
  });
});

describe("scanWhatsappEnvelope", () => {
  it("reports every distinct number in payload order, and no history", () => {
    const scan = scanWhatsappEnvelope({
      object: "whatsapp_business_account",
      entry: [
        { id: WABA_A, changes: [textChange(PN_A, "1650", "w1")] },
        { id: WABA_B, changes: [textChange(PN_B, "1651", "w2")] },
        { id: WABA_A, changes: [textChange(PN_A, "1652", "w3")] },
      ],
    });
    expect(scan.hasHistory).toBe(false);
    expect(scan.accountIds).toEqual([PN_A, PN_B]);
  });

  it("flags a Coexistence history chunk", () => {
    const scan = scanWhatsappEnvelope({
      object: "whatsapp_business_account",
      entry: [
        {
          id: WABA_A,
          changes: [
            {
              field: "history",
              value: {
                messaging_product: "whatsapp",
                metadata: { phone_number_id: PN_A },
                history: [],
              },
            },
          ],
        },
      ],
    });
    expect(scan.hasHistory).toBe(true);
    expect(scan.accountIds).toEqual([PN_A]);
  });

  it("tolerates a malformed envelope without throwing", () => {
    expect(scanWhatsappEnvelope(null)).toEqual({ hasHistory: false, accountIds: [] });
    expect(scanWhatsappEnvelope({ entry: "nope" })).toEqual({
      hasHistory: false,
      accountIds: [],
    });
  });
});

const PAGE_A = "page_aaa";
const PAGE_B = "page_bbb";

function socialTextEntry(accountId: string, psid: string, mid: string) {
  return {
    id: accountId,
    time: 1458692752478,
    messaging: [
      {
        sender: { id: psid },
        recipient: { id: accountId },
        timestamp: 1458692752478,
        message: { mid, text: "hello" },
      },
    ],
  };
}

describe("Messenger / Instagram: entry[].id is stamped per entry", () => {
  it("Messenger stamps each Page's own id in a batched body", () => {
    const events = messengerProvider.parseWebhook({
      object: "page",
      entry: [
        socialTextEntry(PAGE_A, "psid_1", "mid.A"),
        socialTextEntry(PAGE_B, "psid_2", "mid.B"),
      ],
    });
    expect(events).toHaveLength(2);
    const byMid = new Map(
      events.map((e) => [("externalId" in e ? e.externalId : "") as string, e.externalAccountId]),
    );
    expect(byMid.get("mid.A")).toBe(PAGE_A);
    expect(byMid.get("mid.B")).toBe(PAGE_B);
  });

  it("Instagram stamps each IG account's own id in a batched body", () => {
    const events = instagramProvider.parseWebhook({
      object: "instagram",
      entry: [
        socialTextEntry("ig_aaa", "igsid_1", "mid.IGA"),
        socialTextEntry("ig_bbb", "igsid_2", "mid.IGB"),
      ],
    });
    expect(events).toHaveLength(2);
    const byMid = new Map(
      events.map((e) => [("externalId" in e ? e.externalId : "") as string, e.externalAccountId]),
    );
    expect(byMid.get("mid.IGA")).toBe("ig_aaa");
    expect(byMid.get("mid.IGB")).toBe("ig_bbb");
  });

  it("leaves an entry with no id unstamped rather than guessing", () => {
    const events = messengerProvider.parseWebhook({
      object: "page",
      entry: [{ ...socialTextEntry(PAGE_A, "psid_1", "mid.NOID"), id: undefined }],
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.externalAccountId).toBeUndefined();
  });
});
