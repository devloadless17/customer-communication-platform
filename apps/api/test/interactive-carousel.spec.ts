import { afterEach, describe, expect, it, vi } from "vitest";

import { SendInteractiveSchema } from "@/messages/messages.schemas";
import { ExternalSendInteractiveSchema } from "@/external/v1/external-v1.schemas";
import { metaProvider } from "@/lib/providers/meta";

/**
 * Interactive media carousel messages (interactive-carousel doc): 2-10
 * scrollable media cards, each with an image/video header LINK and either one
 * URL button or uniform quick-reply buttons. Pinned:
 *
 *  - the doc's component rules on both schema mirrors (2-10 cards, exactly one
 *    button variant per card, UNIFORM variant + count across cards, card body
 *    ≤160 with ≤2 line breaks, globally-unique quick-reply ids);
 *  - the exact wire for BOTH doc examples — including Meta's own quirk of
 *    `type: "cta_url"` on every card even in the quick-reply variant.
 */

const IMG = (n: string) => ({ kind: "image" as const, link: `https://x.example/${n}.jpeg` });

const URL_CARDS = [
  { headerMedia: IMG("a"), body: "*Blue Echeveria*", ctaUrl: { displayText: "Buy now", url: "https://shop.example/a" } },
  { headerMedia: IMG("b"), ctaUrl: { displayText: "Buy now", url: "https://shop.example/b" } },
];

const QR_CARDS = [
  { headerMedia: IMG("a"), quickReplies: [{ id: "learn-a", title: "Learn more" }, { id: "fav-a", title: "Add to favorites" }] },
  { headerMedia: IMG("b"), quickReplies: [{ id: "learn-b", title: "Learn more" }, { id: "fav-b", title: "Add to favorites" }] },
];

describe("schemas (composer + /v1 mirror)", () => {
  const base = { conversationId: "c1", body: "Here are our latest arrivals:" };

  it("accepts both doc variants", () => {
    for (const cards of [URL_CARDS, QR_CARDS]) {
      expect(
        SendInteractiveSchema.safeParse({ ...base, kind: "carousel", carouselCards: cards }).success,
      ).toBe(true);
      expect(
        ExternalSendInteractiveSchema.safeParse({ body: base.body, kind: "carousel", carouselCards: cards }).success,
      ).toBe(true);
    }
  });

  it("enforces 2-10 cards and carouselCards-iff-carousel", () => {
    expect(
      SendInteractiveSchema.safeParse({ ...base, kind: "carousel", carouselCards: [URL_CARDS[0]] }).success,
    ).toBe(false);
    expect(SendInteractiveSchema.safeParse({ ...base, kind: "carousel" }).success).toBe(false);
    expect(
      SendInteractiveSchema.safeParse({
        ...base,
        kind: "buttons",
        options: [{ id: "a", title: "A" }],
        carouselCards: URL_CARDS,
      }).success,
    ).toBe(false);
  });

  it("rejects mixed button variants and mismatched quick-reply counts", () => {
    const mixed = [URL_CARDS[0], QR_CARDS[1]];
    expect(
      SendInteractiveSchema.safeParse({ ...base, kind: "carousel", carouselCards: mixed }).success,
    ).toBe(false);
    const uneven = [QR_CARDS[0], { ...QR_CARDS[1], quickReplies: [{ id: "solo-b", title: "Learn" }] }];
    expect(
      SendInteractiveSchema.safeParse({ ...base, kind: "carousel", carouselCards: uneven }).success,
    ).toBe(false);
  });

  it("rejects duplicate quick-reply ids across cards, both-buttons cards, and 3-line bodies", () => {
    const dupIds = [QR_CARDS[0], { ...QR_CARDS[1], quickReplies: QR_CARDS[0].quickReplies }];
    expect(
      SendInteractiveSchema.safeParse({ ...base, kind: "carousel", carouselCards: dupIds }).success,
    ).toBe(false);
    const both = [{ ...URL_CARDS[0], quickReplies: QR_CARDS[0].quickReplies }, URL_CARDS[1]];
    expect(
      SendInteractiveSchema.safeParse({ ...base, kind: "carousel", carouselCards: both }).success,
    ).toBe(false);
    const wordy = [{ ...URL_CARDS[0], body: "a\nb\nc\nd" }, URL_CARDS[1]];
    expect(
      SendInteractiveSchema.safeParse({ ...base, kind: "carousel", carouselCards: wordy }).success,
    ).toBe(false);
  });
});

describe("provider wire shape", () => {
  afterEach(() => vi.unstubAllGlobals());

  async function capture(cards: unknown): Promise<Record<string, unknown>> {
    let captured: Record<string, unknown> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: { body?: string }) => {
        captured = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
        return new Response(JSON.stringify({ messages: [{ id: "wamid.CAR_1" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    await metaProvider.sendInteractive!(
      {
        to: "96170000004",
        bodyText: "Here are our latest arrivals:",
        kind: "carousel",
        options: [],
        carouselCards: cards,
      } as Parameters<NonNullable<typeof metaProvider.sendInteractive>>[0],
      { phoneNumberId: "pn_1", accessToken: "tok", graphVersion: "v25.0" } as Parameters<
        NonNullable<typeof metaProvider.sendInteractive>
      >[1],
    );
    return captured;
  }

  it("URL-button variant matches the doc example shape", async () => {
    const body = await capture(URL_CARDS);
    expect(body).toMatchObject({
      type: "interactive",
      interactive: {
        type: "carousel",
        body: { text: "Here are our latest arrivals:" },
        action: {
          cards: [
            {
              card_index: 0,
              type: "cta_url",
              header: { type: "image", image: { link: "https://x.example/a.jpeg" } },
              body: { text: "*Blue Echeveria*" },
              action: {
                name: "cta_url",
                parameters: { display_text: "Buy now", url: "https://shop.example/a" },
              },
            },
            {
              card_index: 1,
              type: "cta_url",
              header: { type: "image", image: { link: "https://x.example/b.jpeg" } },
              action: {
                name: "cta_url",
                parameters: { display_text: "Buy now", url: "https://shop.example/b" },
              },
            },
          ],
        },
      },
    });
    // Card 1 has no body — the wire must omit it, not send an empty object.
    const cards = (body.interactive as { action: { cards: Array<Record<string, unknown>> } })
      .action.cards;
    expect(cards[1]!.body).toBeUndefined();
  });

  it("quick-reply variant keeps Meta's `type: cta_url` card literal + nests quick_reply", async () => {
    const body = await capture(QR_CARDS);
    const cards = (body.interactive as { action: { cards: Array<Record<string, unknown>> } })
      .action.cards;
    expect(cards[0]).toMatchObject({
      card_index: 0,
      type: "cta_url", // Meta's own examples use this literal even for QR cards
      action: {
        buttons: [
          { type: "quick_reply", quick_reply: { id: "learn-a", title: "Learn more" } },
          { type: "quick_reply", quick_reply: { id: "fav-a", title: "Add to favorites" } },
        ],
      },
    });
  });
});
