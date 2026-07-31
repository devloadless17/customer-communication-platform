/**
 * Messenger conformance — the four things the current Meta docs say that this
 * code used to disagree with. Every assertion below is pinned to a specific,
 * dated statement in Meta's own reference, quoted at the test.
 *
 *   pnpm --filter @ccp/api exec vitest run test/messenger-conformance.spec.ts
 */
import { describe, expect, it } from "vitest";

import { parseSocialMessaging } from "@/lib/providers/meta-social";
import { failureBucket, normalizeMetaSendError, MetaSendError } from "@/lib/providers/meta-send-error";
import type { NormalizedInboundMessage, NormalizedOutboundEcho } from "@ccp/shared/providers/types";

const PAGE = "PAGE_1";

/** Wrap one `messaging[]` item in the `object:"page"` envelope Meta sends. */
function pageEvent(messaging: Record<string, unknown>): unknown {
  return { object: "page", entry: [{ id: PAGE, time: 1_700_000_000_000, messaging: [messaging] }] };
}

/** Build the JSON body Graph returns for an error, as `MetaSendError` sees it. */
function metaError(code: number, subcode?: number, message = "boom"): MetaSendError {
  return new MetaSendError(
    message,
    400,
    JSON.stringify({
      error: { message, type: "OAuthException", code, ...(subcode ? { error_subcode: subcode } : {}) },
    }),
  );
}

describe("send-error classification (Messenger common error codes)", () => {
  // Changelog, Jun 25 2026: "Added error code 10 – 1893063 to the Messenger
  // Platform common error codes reference for Pages temporarily restricted from
  // sending messages." It is the social twin of WhatsApp's 368/131031 lock, so
  // it must reach the run-fatal family — unclassified it read `provider_rejected`
  // and a broadcast burned its whole audience against a Page that cannot send.
  it("maps 10 – 1893063 to account_restricted, not the 24h window", () => {
    const norm = normalizeMetaSendError(metaError(10, 1893063, "Page is restricted from sending messages"));
    expect(norm?.code).toBe("account_restricted");
  });

  // The window branch shares `code: 10` and ends in a free-form body regex, so
  // the ordering between the two is load-bearing rather than incidental.
  it("still maps 10 – 2018278 to outside_24h_window", () => {
    const norm = normalizeMetaSendError(metaError(10, 2018278, "outside the 24 hour window"));
    expect(norm?.code).toBe("outside_24h_window");
  });

  // "2018300 Message failed to send because another app is controlling this
  // thread now." / "2018321 The chat is currently controlled by Messenger while
  // the user is in an automated question and answer flow."
  it.each([2018300, 2018321])("maps %i to a retryable thread_control_lost", (code) => {
    const norm = normalizeMetaSendError(metaError(code));
    expect(norm?.code).toBe("thread_control_lost");
    // Never `permanent` — that is the bucket that tells an operator to delete a
    // contact, and nothing is wrong with this recipient.
    expect(failureBucket(norm!.code)).toBe("retryable");
  });

  // "200 Permission Error: Cannot message users who are not admins, developers
  // or testers of the app until pages_messaging permission is reviewed and the
  // app is live." Fails every real customer identically until App Review clears.
  it("maps a bare 200 to app_permission_required", () => {
    const norm = normalizeMetaSendError(metaError(200));
    expect(norm?.code).toBe("app_permission_required");
  });

  // The other documented 200 subcodes are classified EARLIER in the ladder.
  // Pinned because the new bare-200 branch sits downstream of both, and swapping
  // the order would relabel a blocked person as an App Review problem.
  //
  // "200 – 2534041 The account owner has disabled access to instagram direct
  // messages" is the reason the 2534 family had to learn to read the SUBCODE:
  // Meta documents it only as a code–subcode pair, so the code-only test that
  // stood there matched nothing and the case fell to the catch-all.
  //
  // It now normalizes to `account_restricted`, not `invalid_recipient`. Meta's
  // own gloss is "the owner of the Instagram Professional account has revoked
  // your app's access" — that is the ACCOUNT, and every recipient on it fails
  // identically. Calling it a bad recipient told an operator to blame the
  // contact and try the next one, which walks the whole audience into the same
  // wall; `account_restricted` rides the run-fatal family and pauses instead.
  // The ORDERING this case exists to pin is unchanged: both specific subcodes
  // still resolve ahead of the bare-200 `app_permission_required` branch.
  it("keeps the more specific 200 subcodes ahead of it", () => {
    expect(normalizeMetaSendError(metaError(200, 1545041))?.code).toBe("recipient_unavailable");
    expect(normalizeMetaSendError(metaError(200, 2534041))?.code).toBe("account_restricted");
  });
});

describe("messages webhook: attachment payloads we used to discard", () => {
  // Changelog, Mar 3 2026: appointment booking data is surfaced on the messages
  // webhook "so partners can access appointment details — including status,
  // scheduled time, and timezone — directly from their own platform without
  // switching to Meta Business Suite". We kept only the "📅 Appointment" label.
  it("lifts an appointment_booking into structured content", () => {
    const [evt] = parseSocialMessaging(
      pageEvent({
        sender: { id: "PSID_1" },
        recipient: { id: PAGE },
        timestamp: 1_700_000_000_000,
        message: {
          mid: "m_appt",
          attachments: [
            {
              type: "appointment_booking",
              payload: {
                booking_id: "BK_1",
                status: "confirmed",
                start_time: 1_760_000_000,
                end_time: 1_760_003_600,
                timezone: "America/Los_Angeles",
              },
            },
          ],
        },
      }),
      "page",
    ) as [NormalizedInboundMessage];

    expect(evt.kind).toBe("message");
    expect(evt.structured).toEqual({
      kind: "appointment",
      bookingId: "BK_1",
      status: "confirmed",
      // Meta sends Unix SECONDS; the parser normalizes at the seam.
      startTime: new Date(1_760_000_000 * 1000).toISOString(),
      endTime: new Date(1_760_003_600 * 1000).toISOString(),
      timezone: "America/Los_Angeles",
    });
    // The label stays the body — it is what search and the list preview read.
    expect(evt.body).toBe("📅 Appointment");
  });

  // Same changelog entry: "Message Echoes Webhook — When a business responds to
  // an appointment (eg, confirming or declining), the message_echoes webhook
  // payload includes the updated appointment data." The echo branch dropped it,
  // so an agent saw a bare label for their own colleague's confirmation.
  it("lifts it on an ECHO too", () => {
    const [evt] = parseSocialMessaging(
      pageEvent({
        sender: { id: PAGE },
        recipient: { id: "PSID_1" },
        timestamp: 1_700_000_000_000,
        message: {
          mid: "m_appt_echo",
          is_echo: true,
          attachments: [{ type: "appointment_booking", payload: { status: "declined" } }],
        },
      }),
      "page",
    ) as [NormalizedOutboundEcho];

    expect(evt.kind).toBe("echo");
    expect(evt.structured).toEqual({ kind: "appointment", status: "declined" });
  });

  // Changelog, Mar 26 2026: post/reel shares now carry "share metadata (such as
  // url, id, type, and title)". Without the title the card says "Shared a post"
  // and the agent has to open the link to learn which post they were asked about.
  it("carries a share's title onto the story card", () => {
    const [evt] = parseSocialMessaging(
      pageEvent({
        sender: { id: "PSID_1" },
        recipient: { id: PAGE },
        timestamp: 1_700_000_000_000,
        message: {
          mid: "m_share",
          attachments: [
            { type: "post", title: "Summer sale ends Friday", payload: { url: "https://fb.test/p/1" } },
          ],
        },
      }),
      "page",
    ) as [NormalizedInboundMessage];

    expect(evt.structured).toEqual({
      kind: "story",
      storyType: "share",
      url: "https://fb.test/p/1",
      title: "Summer sale ends Friday",
    });
  });

  // Changelog, Jun 1 2026: during the 90-day transition (to Aug 30 2026) a
  // sticker arrives as BOTH a `sticker` and an `image` attachment; after it,
  // only `sticker`. Preferring `sticker` makes the cutover a no-op AND stops the
  // twin being ingested as a second, duplicate media row.
  it("prefers the sticker attachment over its transition-period image twin", () => {
    const events = parseSocialMessaging(
      pageEvent({
        sender: { id: "PSID_1" },
        recipient: { id: PAGE },
        timestamp: 1_700_000_000_000,
        message: {
          mid: "m_sticker",
          attachments: [
            { type: "sticker", payload: { url: "https://cdn.test/s.webp", sticker_id: 369239263222822 } },
            { type: "image", payload: { url: "https://cdn.test/s.png" } },
          ],
        },
      }),
      "page",
    ) as NormalizedInboundMessage[];

    expect(events).toHaveLength(1);
    expect(events[0]!.media?.kind).toBe("sticker");
    expect(events[0]!.media?.sourceUrl).toBe("https://cdn.test/s.webp");
  });
});

describe("ad referral: every documented field is captured", () => {
  // `messaging_referrals` reference. Each of these answers a question a campaign
  // report is actually asked, and each was previously parsed and thrown away.
  it("keeps post_id, product_id and referer_uri", () => {
    const [evt] = parseSocialMessaging(
      pageEvent({
        sender: { id: "PSID_1" },
        recipient: { id: PAGE },
        timestamp: 1_700_000_000_000,
        message: { mid: "m_ad", text: "hi" },
        referral: {
          source: "ADS",
          type: "OPEN_THREAD",
          ad_id: "AD_123",
          ref: "spring",
          referer_uri: "https://shop.test/landing",
          ads_context_data: {
            ad_title: "Spring sale",
            post_id: "POST_9",
            product_id: "SKU_7",
          },
        },
      }),
      "page",
    ) as [NormalizedInboundMessage];

    expect(evt.attribution).toEqual({
      source: "ad",
      headline: "Spring sale",
      adId: "AD_123",
      ref: "spring",
      // WHICH post drove this — several ads can promote one post, so an ad id
      // alone can't answer "which content brings people in".
      postId: "POST_9",
      // WHICH product they were looking at when they wrote in.
      productId: "SKU_7",
      // WHERE they came from — the landing page that actually converts.
      sourceUrl: "https://shop.test/landing",
    });
  });

  it("does not invent a sourceUrl when Meta gives none", () => {
    const [evt] = parseSocialMessaging(
      pageEvent({
        sender: { id: "PSID_1" },
        recipient: { id: PAGE },
        timestamp: 1_700_000_000_000,
        message: { mid: "m_ad2", text: "hi" },
        referral: { source: "ADS", ad_id: "AD_1" },
      }),
      "page",
    ) as [NormalizedInboundMessage];
    expect(evt.attribution).not.toHaveProperty("sourceUrl");
    expect(evt.attribution).not.toHaveProperty("postId");
  });
});

describe("ad creative is unified across Meta channels", () => {
  // WhatsApp's referral spells it `image_url`; Messenger's ads_context_data
  // spells it `photo_url`. Both are the creative the customer was looking at when
  // they wrote in, so both land on ONE field — a report must not have to know
  // which channel someone arrived on to answer the same question.
  it("maps Messenger photo_url onto imageUrl and infers the media type", () => {
    const [evt] = parseSocialMessaging(
      pageEvent({
        sender: { id: "PSID_1" },
        recipient: { id: PAGE },
        timestamp: 1_700_000_000_000,
        message: { mid: "m_c", text: "hi" },
        referral: {
          source: "ADS",
          ad_id: "AD_1",
          ads_context_data: { photo_url: "https://cdn.test/creative.jpg" },
        },
      }),
      "page",
    ) as [NormalizedInboundMessage];

    expect(evt.attribution).toMatchObject({
      adId: "AD_1",
      imageUrl: "https://cdn.test/creative.jpg",
      mediaType: "image",
    });
  });

  it("prefers video when Meta sends one", () => {
    const [evt] = parseSocialMessaging(
      pageEvent({
        sender: { id: "PSID_1" },
        recipient: { id: PAGE },
        timestamp: 1_700_000_000_000,
        message: { mid: "m_v", text: "hi" },
        referral: {
          source: "ADS",
          ad_id: "AD_2",
          ads_context_data: { video_url: "https://cdn.test/clip.mp4" },
        },
      }),
      "page",
    ) as [NormalizedInboundMessage];
    expect(evt.attribution).toMatchObject({
      videoUrl: "https://cdn.test/clip.mp4",
      mediaType: "video",
    });
  });
});
