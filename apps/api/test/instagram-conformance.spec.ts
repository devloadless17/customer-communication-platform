/**
 * Instagram conformance — the claims this channel makes that only a live Meta
 * account would otherwise falsify.
 *
 * Every case below encodes something taken VERBATIM from Meta's Instagram
 * Messaging docs (re-verified 2026-07-30), because each one is a silent failure
 * in production rather than a loud one:
 *
 *  1. A Shop-product referral carries neither `ad_id` nor `ref`, so it used to
 *     produce `source:"unknown"` — an attribution object with nothing in it, which
 *     the bubble renders as "From your ad" to a shopper who clicked no ad.
 *  2. The business reaction has exactly ONE legal value on Instagram (`love`).
 *     Passing the agent's emoji through is a #100 on every send.
 *  3. The `cta_url` link button is a BUTTON TEMPLATE on Instagram, not a quick
 *     reply — a quick reply carries no destination, so collapsing it would send
 *     the text with the link silently missing.
 *  4. The Moderate Conversations API answers `{"success":"true"}` with a STRING.
 *     A truthy-object check reports a refused block as applied, after which
 *     `Contact.blockedAt` claims a block Meta is not enforcing.
 *  5. `entry[].id` on an `object:"instagram"` webhook is the INSTAGRAM account id,
 *     which is what per-event account attribution keys on.
 *  6. Entry points (ice breakers / persistent menu) need `platform=instagram`,
 *     live under a per-LOCALE envelope, and are CLEARED by a DELETE carrying the
 *     field list in its body — posting an empty list clears nothing, so the UI
 *     would show none while the customer still saw the old ones.
 *
 *   pnpm --filter @ccp/api exec vitest run test/instagram-conformance.spec.ts
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/providers/meta-graph", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/providers/meta-graph")>();
  return {
    ...actual,
    graphPostJson: vi.fn(),
    graphGetJson: vi.fn(),
    graphDeleteJson: vi.fn(),
  };
});

import { graphDeleteJson, graphGetJson, graphPostJson } from "@/lib/providers/meta-graph";
import { instagramProvider } from "@/lib/providers/instagram";
import {
  INSTAGRAM_HIGH_VOLUME_MESSAGE_CEILING,
  resolveSocialSendRate,
} from "@/lib/broadcasts/send-rate-limiter";
import type { InstagramSendConfig } from "@/lib/providers/instagram-config";
import {
  CHANNEL_CAPABILITIES,
  BROADCASTABLE_CHANNELS,
  channelInboxSources,
  COMMENT_PRIVATE_REPLY_WINDOW_MS,
  isAccountScopedIdentity,
  hasAnswerableComment,
  INBOX_SOURCES,
  inboxSourceOfStructuredKind,
} from "@ccp/shared/providers/capabilities";
import type { NormalizedInboundMessage } from "@ccp/shared/providers/types";

const postJson = vi.mocked(graphPostJson);

const CONFIG: InstagramSendConfig = {
  igId: "17841400000000001",
  pageId: "100000000000001",
  igAccessToken: "PAGE_TOKEN",
  graphVersion: "v26.0",
  appSecret: "APP_SECRET",
};

/** The body the provider actually put on the wire for call `n`. */
function sentBody(n = 0): Record<string, unknown> {
  return postJson.mock.calls[n]![2] as Record<string, unknown>;
}

beforeEach(() => {
  postJson.mockReset();
  postJson.mockResolvedValue({ message_id: "mid.OUT" });
  vi.mocked(graphGetJson).mockReset();
  vi.mocked(graphGetJson).mockResolvedValue({ data: [] });
  vi.mocked(graphDeleteJson).mockReset();
  vi.mocked(graphDeleteJson).mockResolvedValue({});
});

describe("inbound: Instagram Shop product referral", () => {
  it("attributes a product referral to the shop, not to an ad", () => {
    // Meta's `messages` reference: `"referral": { "product": { "id": "PRODUCT-ID" } }`
    // — "Included when a customer clicks an Instagram Shop product".
    const events = instagramProvider.parseWebhook({
      object: "instagram",
      entry: [
        {
          id: CONFIG.igId,
          time: 1_769_000_000_000,
          messaging: [
            {
              sender: { id: "IGSID_SHOPPER" },
              recipient: { id: CONFIG.igId },
              timestamp: 1_769_000_000_000,
              message: {
                mid: "mid.SHOP",
                text: "is this in stock?",
                referral: { product: { id: "PROD-42" } },
              },
            },
          ],
        },
      ],
    });

    const msg = events.find((e) => e.kind === "message") as NormalizedInboundMessage;
    expect(msg.attribution).toEqual({ source: "post", productId: "PROD-42" });
    // And the event is stamped with the IG account that received it — the id
    // per-event attribution resolves against.
    expect(msg.externalAccountId).toBe(CONFIG.igId);
  });

  it("keeps a Click-to-Instagram ad an ad, and carries the welcome-flow id", () => {
    const events = instagramProvider.parseWebhook({
      object: "instagram",
      entry: [
        {
          id: CONFIG.igId,
          messaging: [
            {
              sender: { id: "IGSID_LEAD" },
              recipient: { id: CONFIG.igId },
              timestamp: 1_769_000_000_000,
              message: {
                mid: "mid.AD",
                text: "hi",
                referral: {
                  ref: "spring",
                  source: "ADS",
                  type: "OPEN_THREAD",
                  ad_id: "AD-7",
                  flow_id: "FLOW-9",
                  ads_context_data: { ad_title: "Spring sale" },
                },
              },
            },
          ],
        },
      ],
    });

    const msg = events.find((e) => e.kind === "message") as NormalizedInboundMessage;
    expect(msg.attribution).toEqual({
      source: "ad",
      headline: "Spring sale",
      clickId: "AD-7",
      ref: "spring",
      flowId: "FLOW-9",
    });
  });
});

describe("outbound: business reaction", () => {
  it("coerces any emoji to Instagram's single legal value", async () => {
    await instagramProvider.sendReaction!(
      { to: "IGSID_1", messageExternalId: "mid.IN", emoji: "😂" },
      CONFIG,
    );
    expect(sentBody()).toMatchObject({
      recipient: { id: "IGSID_1" },
      sender_action: "react",
      payload: { message_id: "mid.IN", reaction: "love" },
    });
  });

  it("sends unreact with message_id only", async () => {
    await instagramProvider.sendReaction!(
      { to: "IGSID_1", messageExternalId: "mid.IN", emoji: "" },
      CONFIG,
    );
    expect(sentBody()).toMatchObject({
      sender_action: "unreact",
      payload: { message_id: "mid.IN" },
    });
    expect(sentBody().payload).not.toHaveProperty("reaction");
  });
});

describe("outbound: cta_url is a button template", () => {
  it("sends template_type button with one web_url button, header/footer folded in", async () => {
    await instagramProvider.sendInteractive!(
      {
        to: "IGSID_1",
        bodyText: "Track your order",
        kind: "cta_url",
        options: [],
        useHumanAgentTag: false,
        ctaUrl: {
          displayText: "Track",
          url: "https://example.com/t/1",
          headerText: "Shipped",
          footerText: "Arrives Friday",
        },
      },
      CONFIG,
    );
    expect(sentBody()).toMatchObject({
      recipient: { id: "IGSID_1" },
      messaging_type: "RESPONSE",
      message: {
        attachment: {
          type: "template",
          payload: {
            template_type: "button",
            text: "Shipped\n\nTrack your order\n\nArrives Friday",
            buttons: [
              { type: "web_url", url: "https://example.com/t/1", title: "Track" },
            ],
          },
        },
      },
    });
    // Not a quick reply — the whole point.
    expect(sentBody().message).not.toHaveProperty("quick_replies");
  });

  it("still sends authored options as quick replies, dropping the email chip", async () => {
    await instagramProvider.sendInteractive!(
      {
        to: "IGSID_1",
        bodyText: "Pick one",
        kind: "buttons",
        options: [{ id: "a", title: "Alpha" }],
        contactShare: ["phone", "email"],
        useHumanAgentTag: false,
      },
      CONFIG,
    );
    // Instagram documents ONLY `user_phone_number`; a `user_email` chip makes
    // Meta reject the entire message.
    expect(sentBody().message).toMatchObject({
      text: "Pick one",
      quick_replies: [
        { content_type: "text", title: "Alpha", payload: "a" },
        { content_type: "user_phone_number" },
      ],
    });
  });
});

describe("outbound: generic + product templates", () => {
  it("sends template_type generic with Meta's exact element shape", async () => {
    await instagramProvider.sendInteractive!(
      {
        to: "IGSID_1",
        bodyText: "ignored for this kind",
        kind: "generic",
        options: [],
        useHumanAgentTag: false,
        genericCards: [
          {
            title: "Welcome!",
            subtitle: "We have the right hat for everyone.",
            imageUrl: "https://example.com/hat.jpg",
            defaultActionUrl: "https://example.com/shop",
            buttons: [
              { type: "web_url", title: "Shop Now", url: "https://example.com/shop" },
              { type: "postback", title: "Help Me Choose", payload: "HELP" },
            ],
          },
          // A second, deliberately SPARSE card: the generic template does not
          // demand uniformity the way WhatsApp's carousel does, so absent
          // properties must simply be omitted rather than sent as null.
          { title: "Just a title and a link", defaultActionUrl: "https://example.com/x" },
        ],
      },
      CONFIG,
    );

    expect(sentBody().message).toEqual({
      attachment: {
        type: "template",
        payload: {
          template_type: "generic",
          elements: [
            {
              title: "Welcome!",
              subtitle: "We have the right hat for everyone.",
              image_url: "https://example.com/hat.jpg",
              // `default_action` is a web_url action with NO title — Meta's
              // shape for "tapping the card itself opens this".
              default_action: { type: "web_url", url: "https://example.com/shop" },
              buttons: [
                { type: "web_url", url: "https://example.com/shop", title: "Shop Now" },
                { type: "postback", title: "Help Me Choose", payload: "HELP" },
              ],
            },
            {
              title: "Just a title and a link",
              default_action: { type: "web_url", url: "https://example.com/x" },
            },
          ],
        },
      },
    });
  });

  it("sends template_type product as bare catalog ids", async () => {
    await instagramProvider.sendInteractive!(
      {
        to: "IGSID_1",
        bodyText: "ignored",
        kind: "product",
        options: [],
        useHumanAgentTag: false,
        productIds: ["PROD-1", "PROD-2"],
      },
      CONFIG,
    );

    // Meta draws each card from the catalog entry, so `elements` carries ids and
    // nothing else — any extra field here would be us inventing content.
    expect(sentBody().message).toEqual({
      attachment: {
        type: "template",
        payload: {
          template_type: "product",
          elements: [{ id: "PROD-1" }, { id: "PROD-2" }],
        },
      },
    });
  });

  it("does not collapse a template kind into quick replies", async () => {
    await instagramProvider.sendInteractive!(
      {
        to: "IGSID_1",
        bodyText: "hi",
        kind: "generic",
        options: [{ id: "a", title: "Alpha" }],
        useHumanAgentTag: false,
        genericCards: [{ title: "Card", subtitle: "sub" }],
      },
      CONFIG,
    );
    // `options` are meaningless for a template kind; sending them as quick
    // replies alongside would be a second, unasked-for message shape.
    expect(sentBody().message).not.toHaveProperty("quick_replies");
    expect(sentBody().message).not.toHaveProperty("text");
  });
});

describe("outbound: Moderate Conversations blocklist", () => {
  it("posts the documented body to the PAGE node", async () => {
    postJson.mockResolvedValue({ success: "true" });
    const res = await instagramProvider.blockUsers!(["IGSID_1"], CONFIG);
    expect(postJson.mock.calls[0]![0]).toContain(`/${CONFIG.pageId}/moderate_conversations`);
    expect(sentBody()).toEqual({
      user_ids: [{ id: "IGSID_1" }],
      actions: ["block_user"],
    });
    expect(res.succeeded.map((s) => s.input)).toEqual(["IGSID_1"]);
    expect(res.failed).toEqual([]);
  });

  it('treats the STRING "false" as a failure, not a truthy success', async () => {
    postJson.mockResolvedValue({ success: "false" });
    const res = await instagramProvider.blockUsers!(["IGSID_1"], CONFIG);
    expect(res.succeeded).toEqual([]);
    expect(res.failed).toHaveLength(1);
  });

  it("refuses more than Meta's 10 ids per request instead of truncating", async () => {
    postJson.mockResolvedValue({ success: "true" });
    const eleven = Array.from({ length: 11 }, (_, i) => `IGSID_${i}`);
    await expect(instagramProvider.unblockUsers!(eleven, CONFIG)).rejects.toThrow(/10/);
    expect(postJson).not.toHaveBeenCalled();
  });
});

describe("conversation entry points (messenger_profile)", () => {
  it("reads with platform=instagram and unwraps the default locale", async () => {
    const get = vi.mocked(graphGetJson);
    get.mockResolvedValue({
      data: [
        {
          ice_breakers: [
            {
              locale: "default",
              call_to_actions: [{ question: "Where is my order?", payload: "ORDER" }],
            },
            // A locale someone else configured. We only manage `default`, so
            // merging this in would show rows the save would then overwrite.
            { locale: "fr_FR", call_to_actions: [{ question: "Bonjour", payload: "FR" }] },
          ],
          persistent_menu: [
            {
              locale: "default",
              call_to_actions: [
                { type: "web_url", title: "Shop", url: "https://example.com" },
                { type: "postback", title: "Help", payload: "HELP" },
                // Unsupported on Instagram — must not be surfaced as editable.
                { type: "phone_number", title: "Call", payload: "+15550100" },
              ],
            },
          ],
        },
      ],
    });

    const res = await instagramProvider.getEntryPoints!(CONFIG);
    expect(get.mock.calls[0]![0]).toContain("platform=instagram");
    expect(get.mock.calls[0]![0]).toContain(`/${CONFIG.pageId}/messenger_profile`);
    expect(res.iceBreakers).toEqual([{ question: "Where is my order?", payload: "ORDER" }]);
    expect(res.menuItems).toEqual([
      { type: "web_url", title: "Shop", url: "https://example.com" },
      { type: "postback", title: "Help", payload: "HELP" },
    ]);
  });

  it("writes both fields wrapped in the default locale", async () => {
    await instagramProvider.setEntryPoints!(
      {
        iceBreakers: [{ question: "Track order", payload: "TRACK" }],
        menuItems: [{ type: "postback", title: "Help", payload: "HELP" }],
      },
      CONFIG,
    );
    expect(sentBody()).toEqual({
      ice_breakers: [
        { locale: "default", call_to_actions: [{ question: "Track order", payload: "TRACK" }] },
      ],
      persistent_menu: [
        {
          locale: "default",
          call_to_actions: [{ type: "postback", title: "Help", payload: "HELP" }],
        },
      ],
    });
    expect(vi.mocked(graphDeleteJson)).not.toHaveBeenCalled();
  });

  it("DELETEs a field that is now empty instead of posting an empty array", async () => {
    // Meta documents no "post an empty list to clear" behaviour — an empty
    // `call_to_actions` would leave the previous set live while our UI showed
    // none. Clearing is its own DELETE with the field list in the BODY.
    await instagramProvider.setEntryPoints!(
      { iceBreakers: [], menuItems: [{ type: "postback", title: "Help", payload: "H" }] },
      CONFIG,
    );
    expect(sentBody()).not.toHaveProperty("ice_breakers");
    const del = vi.mocked(graphDeleteJson);
    expect(del.mock.calls[0]![2]).toEqual({ fields: ["ice_breakers"] });
    // …and the menu the operator still wants was NOT swept up in the clear.
    expect(del.mock.calls[0]![2]).not.toMatchObject({ fields: ["persistent_menu"] });
  });

  it("clears both, and makes no POST at all, when everything is removed", async () => {
    await instagramProvider.setEntryPoints!({ iceBreakers: [], menuItems: [] }, CONFIG);
    expect(postJson).not.toHaveBeenCalled();
    expect(vi.mocked(graphDeleteJson).mock.calls[0]![2]).toEqual({
      fields: ["ice_breakers", "persistent_menu"],
    });
  });
});

describe("inbound: comments", () => {
  const commentPayload = (field: string, value: Record<string, unknown>) => ({
    object: "instagram",
    entry: [{ id: CONFIG.igId, time: 1_769_000_000_000, changes: [{ field, value }] }],
  });

  it("files a comment as an inbound message keyed on the IGSID", () => {
    // Meta: the comments webhook's `from.id` is "an Instagram-scoped ID suitable
    // for the Send API" — the SAME id space as a DM sender. That is the fact the
    // whole design rests on; a different space would fork every commenter into a
    // duplicate contact.
    const events = instagramProvider.parseWebhook(
      commentPayload("comments", {
        from: { id: "IGSID_FAN", username: "fan_handle" },
        comment_id: "COMMENT-1",
        text: "do you ship to Spain?",
        media: { id: "MEDIA-9", media_product_type: "FEED" },
      }),
    );

    expect(events).toHaveLength(1);
    const msg = events[0] as NormalizedInboundMessage;
    expect(msg.externalContactId).toBe("IGSID_FAN");
    expect(msg.body).toBe("do you ship to Spain?");
    // Namespaced so a comment id can never collide with a message `mid` in the
    // (workspace, channel, externalId) dedupe key.
    expect(msg.externalId).toBe("comment:COMMENT-1");
    expect(msg.structured).toEqual({
      kind: "comment",
      commentId: "COMMENT-1",
      username: "fan_handle",
      mediaId: "MEDIA-9",
      mediaProductType: "FEED",
    });
    // THE load-bearing assertion: a comment does not open a 24h window. If this
    // ever flips, the composer, every send guard and the broadcast runner all
    // start believing the thread is open and hand Meta guaranteed rejections.
    expect(msg.opensMessagingWindow).toBe(false);
    expect(msg.externalAccountId).toBe(CONFIG.igId);
  });

  it("labels a text-less comment and marks a live one", () => {
    const events = instagramProvider.parseWebhook(
      commentPayload("live_comments", {
        from: { id: "IGSID_FAN" },
        comment_id: "COMMENT-2",
      }),
    );
    const msg = events[0] as NormalizedInboundMessage;
    expect(msg.body).toBe("💬 Commented on your live");
    expect(msg.structured).toMatchObject({ isLive: true });
  });

  it("drops a comment carrying no author or no id rather than inventing one", () => {
    expect(
      instagramProvider.parseWebhook(
        commentPayload("comments", { comment_id: "C", text: "hi" }),
      ),
    ).toEqual([]);
    expect(
      instagramProvider.parseWebhook(
        commentPayload("comments", { from: { id: "IGSID" }, text: "hi" }),
      ),
    ).toEqual([]);
  });

  it("still ignores the non-message change topics", () => {
    // `mentions` and `story_insights` are subscribed but are not messages; they
    // must not become inbox rows.
    expect(
      instagramProvider.parseWebhook(
        commentPayload("mentions", { media_id: "M", comment_id: "C" }),
      ),
    ).toEqual([]);
  });

  it("parses comments even when the entry ALSO carries messaging[]", () => {
    // Meta's contract permits both arrays on one entry. Hanging comment parsing
    // off "there was no messaging array" would drop them exactly then.
    const events = instagramProvider.parseWebhook({
      object: "instagram",
      entry: [
        {
          id: CONFIG.igId,
          time: 1_769_000_000_000,
          changes: [
            {
              field: "comments",
              value: { from: { id: "IGSID_A" }, comment_id: "C-1", text: "nice" },
            },
          ],
          messaging: [
            {
              sender: { id: "IGSID_B" },
              recipient: { id: CONFIG.igId },
              timestamp: 1_769_000_000_000,
              message: { mid: "mid.DM", text: "hello" },
            },
          ],
        },
      ],
    });
    expect(events).toHaveLength(2);
    expect(events.map((e) => (e as NormalizedInboundMessage).externalId).sort()).toEqual([
      "comment:C-1",
      "mid.DM",
    ]);
  });
});

describe("outbound: private reply to a comment", () => {
  it("addresses the COMMENT and omits every window field", async () => {
    await instagramProvider.sendText(
      {
        to: "IGSID_FAN",
        body: "We ship to Spain — want a link?",
        privateReplyToCommentId: "COMMENT-1",
        // Deliberately passed: the private-reply shape must ignore them, because
        // there is no messaging window yet to describe.
        useHumanAgentTag: true,
        replyToExternalId: "mid.SOMETHING",
      },
      CONFIG,
    );
    expect(sentBody()).toEqual({
      recipient: { comment_id: "COMMENT-1" },
      message: { text: "We ship to Spain — want a link?" },
    });
    expect(sentBody()).not.toHaveProperty("messaging_type");
    expect(sentBody()).not.toHaveProperty("tag");
    expect(sentBody()).not.toHaveProperty("reply_to");
  });

  it("is unchanged for an ordinary DM", async () => {
    await instagramProvider.sendText(
      { to: "IGSID_FAN", body: "hi", useHumanAgentTag: false },
      CONFIG,
    );
    expect(sentBody()).toMatchObject({
      recipient: { id: "IGSID_FAN" },
      messaging_type: "RESPONSE",
      message: { text: "hi" },
    });
  });
});

describe("outbound: move_to_spam and thread control", () => {
  it("files a conversation as spam with the documented action", async () => {
    postJson.mockResolvedValue({ success: "true" });
    const res = await instagramProvider.markSpam!(["IGSID_1"], CONFIG);
    expect(postJson.mock.calls[0]![0]).toContain(`/${CONFIG.pageId}/moderate_conversations`);
    expect(sentBody()).toEqual({
      user_ids: [{ id: "IGSID_1" }],
      actions: ["move_to_spam"],
    });
    expect(res.failed).toEqual([]);
  });

  it("takes thread control on the PAGE node — Instagram uses Conversation Routing", async () => {
    // Meta discontinued Instagram's Handover Protocol on 2025-10-23 and migrated
    // everyone to Conversation Routing, which runs on the same Page endpoints.
    // `take` is what unblocks an agent whose reply failed with 2018300 because a
    // routing-enabled bot holds the thread.
    postJson.mockResolvedValue({ success: true });
    await instagramProvider.threadControl!({ action: "take", to: "IGSID_1" }, CONFIG);
    expect(postJson.mock.calls[0]![0]).toContain(`/${CONFIG.pageId}/take_thread_control`);
    expect(sentBody()).toMatchObject({ recipient: { id: "IGSID_1" } });
  });
});

describe("outbound: PUBLIC reply to a comment", () => {
  it("posts to the COMMENT node, not the Page, and returns the new comment id", async () => {
    postJson.mockResolvedValue({ id: "17873440459141029" });
    const res = await instagramProvider.replyToComment!(
      "COMMENT-1",
      "We ship worldwide!",
      CONFIG,
    );
    // Doc-exact: `POST /<IG_COMMENT_ID>/replies` with `{ message }`. Unlike every
    // other call on this provider, the host is the COMMENT — sending it to the
    // Page would silently post nothing where anyone can see it.
    expect(postJson.mock.calls[0]![0]).toContain("/COMMENT-1/replies");
    expect(postJson.mock.calls[0]![0]).not.toContain(`/${CONFIG.pageId}/`);
    expect(sentBody()).toEqual({ message: "We ship worldwide!" });
    expect(res.commentId).toBe("17873440459141029");
  });

  it("refuses a response with no id rather than reporting a phantom reply", async () => {
    postJson.mockResolvedValue({});
    await expect(
      instagramProvider.replyToComment!("COMMENT-1", "hi", CONFIG),
    ).rejects.toThrow(/missing id/);
  });
});

describe("the non-DM inbox gate", () => {
  it("classifies a comment as a gated source and a DM as core", () => {
    // The mapping lives in ONE place so the ingest gate and every future reader
    // agree about what counts as non-DM.
    expect(inboxSourceOfStructuredKind("comment")).toBe("comments");
    // Ordinary DM content is never a gated source — a shared location or a story
    // reply IS a direct message, just a rich one.
    expect(inboxSourceOfStructuredKind("location")).toBeNull();
    expect(inboxSourceOfStructuredKind("story")).toBeNull();
    expect(inboxSourceOfStructuredKind(undefined)).toBeNull();
  });

  it("offers non-DM sources only on channels that have one", () => {
    expect(channelInboxSources("instagram")).toEqual(["comments"]);
    // WhatsApp has no non-DM surface at all; its settings page must show no
    // toggles rather than an empty section.
    expect(channelInboxSources("whatsapp")).toEqual([]);
    expect(channelInboxSources("messenger")).toEqual([]);
  });

  it("keeps every offered source inside the canonical list", () => {
    // A channel map entry naming a source the gate doesn't know would store a
    // preference that silently matches nothing.
    for (const source of channelInboxSources("instagram")) {
      expect(INBOX_SOURCES).toContain(source);
    }
  });
});

describe("the composer must be able to REACH a private reply", () => {
  const iso = (ageMs: number) => new Date(Date.now() - ageMs).toISOString();
  const DAY = 24 * 60 * 60 * 1000;

  it("unlocks on an unanswered comment — otherwise the feature is unreachable", () => {
    // The composer locks whenever the window is closed. A comment-only thread
    // has no window BY DESIGN, so without this the one legal reply could never
    // be typed: a send path nobody can reach.
    expect(
      hasAnswerableComment([
        { id: "m1", direction: "in", timestamp: iso(0), structuredKind: "comment" },
      ]),
    ).toBe(true);
  });

  it("stays locked once that comment has been answered", () => {
    expect(
      hasAnswerableComment([
        { id: "m1", direction: "in", timestamp: iso(0), structuredKind: "comment" },
        { id: "m2", direction: "out", timestamp: iso(0), replyToMessageId: "m1" },
      ]),
    ).toBe(false);
  });

  it("stays locked past Meta's 7 days", () => {
    expect(
      hasAnswerableComment([
        { id: "m1", direction: "in", timestamp: iso(8 * DAY), structuredKind: "comment" },
      ]),
    ).toBe(false);
  });

  it("does not unlock for an ordinary DM thread", () => {
    // A story reply and a location share ARE direct messages. Unlocking on them
    // would let an agent type into a genuinely closed window and get a Meta
    // rejection instead of the honest "window closed" they see today.
    expect(
      hasAnswerableComment([
        { id: "m1", direction: "in", timestamp: iso(0), structuredKind: "story" },
        { id: "m2", direction: "in", timestamp: iso(0) },
      ]),
    ).toBe(false);
  });

  it("agrees with the server's window constant", () => {
    // Both ends read ONE constant. Two copies would eventually disagree about
    // whether the agent may type at all.
    expect(COMMENT_PRIVATE_REPLY_WINDOW_MS).toBe(7 * DAY);
  });
});

describe("cross-account broadcasting is impossible on scoped-identity channels", () => {
  it("marks Instagram and Messenger as account-scoped, WhatsApp as not", () => {
    // Meta, verbatim: an Instagram-scoped ID is "specific to the person and the
    // Instagram account they are interacting with". A PSID is page-scoped the
    // same way. So account A's id is not a resolvable recipient for account B —
    // a broadcast that tried would queue an entire audience of guaranteed
    // failures and report them as delivery faults.
    expect(isAccountScopedIdentity("instagram")).toBe(true);
    expect(isAccountScopedIdentity("messenger")).toBe(true);
    // A phone number is globally valid, which is why WhatsApp CAN reach another
    // number's contacts — the cost there is thread-ownership migration, a real
    // tradeoff the composer exposes rather than an impossibility.
    expect(isAccountScopedIdentity("whatsapp")).toBe(false);
    // The widget's visitor id is per-browser, not per-account, and it is not
    // broadcastable at all — but the predicate must still answer honestly.
    expect(isAccountScopedIdentity("webchatwidget")).toBe(false);
  });

  it("keeps the scoped set inside the broadcastable channels it constrains", () => {
    // A channel listed here that cannot be broadcast at all would be a rule with
    // nothing to govern — and a broadcastable channel MISSING from it is the
    // dangerous direction, so both are asserted.
    for (const ch of ["instagram", "messenger"] as const) {
      expect(BROADCASTABLE_CHANNELS.has(ch)).toBe(true);
    }
  });
});

describe("broadcast pacing uses INSTAGRAM's ceilings, not Messenger's", () => {
  it("paces Instagram under its own 100/s, separately from Messenger's 40/s", () => {
    const ig = resolveSocialSendRate("instagram");
    const messenger = resolveSocialSendRate("messenger");
    // Instagram: "100 calls per second per Instagram professional account for
    // messages that contain text, links, reactions, and stickers". Meta's
    // Messenger Platform page says 300 for Instagram; the Instagram Platform
    // overview and the Graph API reference both say 100. We take the lower,
    // Instagram-specific number — the failure mode is a throttled live campaign.
    expect(ig).toBeLessThanOrEqual(100);
    expect(ig).toBeGreaterThan(0);
    // Messenger's binding limit is the ~40/s PAGE-INBOX ceiling, which does not
    // exist for Instagram — so the two must not share a number.
    expect(messenger).toBeLessThan(40);
    expect(ig).not.toBe(messenger);
  });

  it("states the 72,000-message ceiling as a capacity fact, not a rate", () => {
    // "If an Instagram Professional account sends and receives more than 72,000
    // messages … the account cannot send new messages until the volume
    // decreases." It counts BOTH directions and is cumulative, so no token
    // bucket can pace around it — which is exactly why it is a named constant
    // rather than a limiter input.
    expect(INSTAGRAM_HIGH_VOLUME_MESSAGE_CEILING).toBe(72_000);
  });
});

describe("capability map matches the documented limits", () => {
  const caps = CHANNEL_CAPABILITIES.instagram;

  it("carries Instagram's real ceilings", () => {
    // "Text message must be less than 1000 characters … UTF-8 and be 1,000 bytes
    // or less"; the button template's own `text` is "up to 640 characters".
    expect(caps.messageTextMaxChars).toBe(1000);
    expect(caps.textLimitIsBytes).toBe(true);
    expect(caps.templateTextMaxChars).toBe(640);
    // No approved-template catalog, no delivery receipt, no calling API.
    expect(caps.templates).toBe(false);
    expect(caps.deliveryReceipts).toBe(false);
    expect(caps.calling).toBe(false);
    // Documented and now implemented.
    expect(caps.ctaUrlButton).toBe(true);
    expect(caps.genericTemplate).toBe(true);
    expect(caps.productTemplate).toBe(true);
    expect(caps.blockUsers).toBe(true);
    expect(caps.moderateSpam).toBe(true);
    expect(caps.publicCommentReply).toBe(true);
    expect(caps.threadControl).toBe(true);
    expect(caps.entryPoints).toBe(true);
    expect(caps.commentPrivateReply).toBe(true);
  });
});
