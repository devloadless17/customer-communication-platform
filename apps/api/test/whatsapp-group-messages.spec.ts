/**
 * A WhatsApp GROUP message must not become a 1:1 conversation.
 *
 * Meta's Groups API delivers group posts on the SAME `messages` webhook field as
 * direct messages. From the group-messaging reference:
 *
 *   "messages": [{ "from": "<GROUP_PARTICIPANT_PHONE_NUMBER>",
 *                  "group_id": "<GROUP_ID>", ... }]
 *
 *   "The from field in the message object and the contact object point to the
 *    same participant who sends this message."
 *
 * So `from`, `contacts[0].wa_id` and every content field look EXACTLY like a
 * direct message from that participant. `group_id` is the only discriminator, and
 * the parser did not read it.
 *
 * Ingested as a DM, one group post fabricated a direct conversation with a person
 * who never messaged the business: it opened their 24h customer-service window,
 * raised unread, fired assignment/SLA/workflows — and an agent answering the
 * group's question would have replied PRIVATELY, because every send goes out
 * `recipient_type: "individual"`. The group would never see the answer.
 *
 * Most reachable on a COEXISTENCE number: it is still in use in the WhatsApp
 * Business app, so it is typically already a member of groups, and ordinary group
 * chatter would arrive as customer inquiries.
 *
 * Pure parser — no DB, no Graph.
 *
 *   pnpm --filter @ccp/api exec vitest run test/whatsapp-group-messages.spec.ts
 */
import { describe, expect, it } from "vitest";

import { metaProvider } from "@/lib/providers/meta";

/** A `messages` webhook body, with `group_id` set only when asked for. */
function inbound(opts: { groupId?: string }): Record<string, unknown> {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA_1",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: {
                display_phone_number: "15550783881",
                phone_number_id: "PHONE_1",
              },
              // Identical in both cases — this is the point.
              contacts: [{ profile: { name: "Sheena Nelson" }, wa_id: "16505551234" }],
              messages: [
                {
                  from: "16505551234",
                  ...(opts.groupId ? { group_id: opts.groupId } : {}),
                  id: "wamid.GROUPTEST1",
                  timestamp: "1749416383",
                  type: "text",
                  text: { body: "Does it come in another color?" },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

describe("a group message", () => {
  it("produces NO events at all", () => {
    const events = metaProvider.parseWebhook(inbound({ groupId: "GROUP_ABC" }));

    expect(events).toEqual([]);
  });

  it("in particular never yields an inbound message for the participant", () => {
    // The specific damage: a contact + conversation for someone who never
    // messaged us, with their 24h window opened.
    const events = metaProvider.parseWebhook(inbound({ groupId: "GROUP_ABC" }));

    expect(events.filter((e) => e.kind === "message")).toHaveLength(0);
  });
});

describe("the identical payload WITHOUT group_id", () => {
  it("still ingests as a normal 1:1 inbound", () => {
    // Non-vacuity guard: proves the group case is dropped by `group_id` and not
    // because the fixture was malformed in some other way.
    const events = metaProvider.parseWebhook(inbound({}));

    const messages = events.filter((e) => e.kind === "message");
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      externalId: "wamid.GROUPTEST1",
      contactPhone: "16505551234",
    });
  });
});

describe("an empty group_id is not a group marker", () => {
  it("falls through to normal handling rather than dropping the message", () => {
    // Guard against the inverse failure: treating a stray empty string as "group"
    // would silently discard a real customer message.
    const events = metaProvider.parseWebhook(inbound({ groupId: "" }));

    expect(events.filter((e) => e.kind === "message")).toHaveLength(1);
  });
});
