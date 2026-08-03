import { z } from "zod";

export const SendTextSchema = z.object({
  conversationId: z.string().min(1),
  body: z.string().trim().min(1).max(8000),
  clientTempId: z.string().min(1).optional(),
  replyToMessageId: z.string().min(1).optional(),
});
export type SendTextInput = z.infer<typeof SendTextSchema>;

/** Outbound location share (map pin). */
export const SendLocationSchema = z.object({
  conversationId: z.string().min(1),
  latitude: z.number().gte(-90).lte(90),
  longitude: z.number().gte(-180).lte(180),
  name: z.string().trim().max(200).optional(),
  address: z.string().trim().max(500).optional(),
  clientTempId: z.string().min(1).optional(),
});
export type SendLocationInput = z.infer<typeof SendLocationSchema>;

/** Outbound contact share (vCard). At least one contact, each with a name. */
export const SendContactsSchema = z.object({
  conversationId: z.string().min(1),
  clientTempId: z.string().min(1).optional(),
  contacts: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(200),
        phones: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
        emails: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
        addresses: z.array(z.string().trim().min(1).max(500)).max(10).optional(),
        company: z.string().trim().max(200).optional(),
      }),
    )
    .min(1)
    .max(10),
});
export type SendContactsInput = z.infer<typeof SendContactsSchema>;

/** Outbound emoji reaction to a message. Empty `emoji` removes the reaction. */
export const SendReactionSchema = z.object({
  conversationId: z.string().min(1),
  messageId: z.string().min(1),
  emoji: z.string().max(16),
});
export type SendReactionInput = z.infer<typeof SendReactionSchema>;

// Locally clear a CUSTOMER reaction that's stuck (Instagram never sends a
// removal webhook — see dismissReaction). No Meta call; just clears our stored
// value + fans out so every agent sees it gone.
export const DismissReactionSchema = z.object({
  messageId: z.string().min(1),
});
export type DismissReactionInput = z.infer<typeof DismissReactionSchema>;

/**
 * Composer translate. Stateless text transform (no conversation context).
 * `targetLang` is a language NAME (e.g. "Arabic", "French") — a model reads a
 * name more reliably than a locale code. Constrained to letters/spaces/parens
 * so the UI's curated list is the only realistic input.
 */
export const TranslateSchema = z.object({
  text: z.string().trim().min(1).max(8000),
  targetLang: z
    .string()
    .trim()
    .min(2)
    .max(40)
    .regex(/^[A-Za-z()'\- ]+$/, "Invalid language"),
});
export type TranslateInput = z.infer<typeof TranslateSchema>;

/**
 * Composer "refine" (AI polish). Same stateless shape as Translate — no
 * conversation context, just a draft-text transform. `mode` picks the
 * rewrite style; the curated set mirrors what agents actually reach for
 * (tone up, tone down, trim length, clean up grammar).
 */
export const RefineSchema = z.object({
  text: z.string().trim().min(1).max(8000),
  mode: z.enum(["formal", "friendly", "shorten", "grammar"]),
});
export type RefineInput = z.infer<typeof RefineSchema>;

export const SendTemplateSchema = z.object({
  conversationId: z.string().min(1),
  templateId: z.string().min(1),
  variables: z
    .object({
      body: z.array(z.string()).default([]),
      /**
       * NAMED-format bodies (`parameter_format: NAMED`, `{{order_id}}`).
       *
       * A template is EITHER positional or named, never both, so exactly one of
       * `body` / `bodyNamed` carries values. Without this field a named template
       * synced from WhatsApp Manager was un-sendable from the inbox: the picker
       * had no way to put the values on the wire, and `sendTemplateInternal`
       * rejected the send with `named_body_vars_required`.
       */
      bodyNamed: z
        .array(z.object({ name: z.string().min(1).max(64), text: z.string() }))
        .max(64)
        .optional(),
      header: z.string().optional(),
      // Media for an IMAGE/VIDEO/DOCUMENT template header. `link` is the stable
      // R2 object URL the composer produces (presigned fresh at send time).
      headerMedia: z
        .object({
          kind: z.enum(["image", "video", "document"]),
          // Either form. `id` is a media id already uploaded to Meta — its
          // recommended shape, because a `link` makes Meta fetch from our
          // server on every send. Exactly one is required.
          link: z.string().url().max(2048).optional(),
          id: z.string().min(1).max(255).optional(),
          filename: z.string().max(255).optional(),
        })
        .refine((m) => Boolean(m.link) !== Boolean(m.id), {
          message: "header media needs exactly one of `link` or `id`",
        })
        .optional(),
      /**
       * The pin for a LOCATION template header. Declared with no parameters at
       * template-create time, so the whole thing arrives here at send time.
       */
      headerLocation: z
        .object({
          latitude: z.string().min(1).max(32),
          longitude: z.string().min(1).max(32),
          // Optional per Meta: a pin renders from coordinates alone. Requiring
          // these refused sends Meta accepts.
          name: z.string().max(120).optional(),
          address: z.string().max(255).optional(),
        })
        .optional(),
      /**
       * Send-time parameters for dynamic buttons — a URL button's `{{1}}`
       * suffix, a copy-code coupon, or a quick-reply payload.
       *
       * `/v1` has accepted these since the field existed; the INTERNAL schema
       * did not, so a template with a dynamic URL or copy-code button was
       * sendable through the API and a dead end in the inbox — the picker showed
       * the buttons, then the send failed `button_params_required` with no way
       * for the agent to supply a value. Parity with the UI is a locked rule and
       * this closes it in the direction that was actually broken.
       */
      buttons: z
        .array(
          z.object({
            index: z.number().int().min(0).max(9),
            subType: z.enum(["url", "copy_code", "quick_reply"]),
            text: z.string().min(1).max(2048),
          }),
        )
        .max(10)
        .optional(),
      /**
       * Tap-target override — makes an image/text/header-less template act as a
       * call-to-action showing `title` and opening `url`. Send-time only; Meta
       * gates it on a fully verified WABA with sustained high quality.
       */
      tapTarget: z
        .object({
          url: z.string().url().max(2048),
          title: z.string().trim().min(1).max(120),
        })
        .optional(),
      /**
       * Limited-time offer expiry, a UNIX timestamp in MILLISECONDS. Required
       * when the template carries a LIMITED_TIME_OFFER component — the countdown
       * has nothing to count to without it.
       */
      limitedTimeOfferExpiresAtMs: z.number().int().positive().optional(),
      /**
       * Per-card values for a media-card carousel, in card order. The array
       * length must equal the card count the template was APPROVED with — Meta
       * fixes that number at creation and rejects any other.
       */
      cards: z
        .array(
          z.object({
            headerMedia: z
              .object({
                kind: z.enum(["image", "video"]),
                link: z.string().url().max(2048).optional(),
                id: z.string().min(1).max(255).optional(),
              })
              .refine((m) => Boolean(m.link) !== Boolean(m.id), {
                message: "card media needs exactly one of `link` or `id`",
              }),
            body: z.array(z.string()).max(10).optional(),
            buttons: z
              .array(
                z.object({
                  index: z.number().int().min(0).max(1),
                  subType: z.enum(["url", "quick_reply", "copy_code"]),
                  text: z.string().min(1).max(2048),
                }),
              )
              .max(2)
              .optional(),
          }),
        )
        .max(10)
        .optional(),
    })
    .default({ body: [] }),
  clientTempId: z.string().min(1).optional(),
});
export type SendTemplateInput = z.infer<typeof SendTemplateSchema>;

/**
 * Agent-side interactive send. Buttons + list share the same shape; the
 * `kind` discriminator decides whether Meta gets `interactive.type=button`
 * (max 3 options) or `interactive.type=list` (max 10).
 *
 * Limits enforced at the Zod boundary to fail fast — the provider also caps
 * but its error message is cryptic. The composer UI mirrors these caps so
 * the user never hits this validator under normal use.
 */
export const SendInteractiveSchema = z
  .object({
    conversationId: z.string().min(1),
    body: z.string().trim().min(1).max(1024),
    // `location_request` renders WhatsApp's own "send location" button
    // (interactive.type "location_request_message") — it carries NO authored
    // options, so `options` is optional and must stay EMPTY for it (refined
    // below); buttons/list keep requiring at least one. `cta_url` likewise:
    // one vendor-drawn URL button, configured via `ctaUrl` below.
    // `request_contact_info` is the same shape as `location_request` —
    // WhatsApp draws its own fixed-label "share contact info" button and the
    // reply arrives as a normal inbound contact card.
    kind: z.enum([
      "buttons",
      "list",
      "location_request",
      "request_contact_info",
      "cta_url",
      "carousel",
      "generic",
      "product",
    ]),
    options: z
      .array(
        z.object({
          id: z.string().min(1).max(256),
          title: z.string().min(1).max(24),
          description: z.string().max(72).optional(),
        }),
      )
      .max(10)
      .default([]),
    // `cta_url` only — the single URL-opening button (interactive.type
    // "cta_url"): label + destination, optional text header/footer. Required
    // for that kind, forbidden otherwise (refined below). URL is opened by
    // the CUSTOMER's browser, never fetched by us — http(s) shape only.
    ctaUrl: z
      .object({
        displayText: z.string().trim().min(1).max(20),
        url: z.string().trim().url().max(2000).regex(/^https?:\/\//i, "must be http(s)"),
        headerText: z.string().trim().min(1).max(60).optional(),
        footerText: z.string().trim().min(1).max(60).optional(),
      })
      .optional(),
    // `generic` only — Meta's GENERIC TEMPLATE: 1-10 cards (a carousel beyond
    // one). Per the reference: `title` 80 chars, `subtitle` 80, at most 3
    // buttons per card, and "Only postback and web_url buttons are supported".
    // Meta also requires at least one property BEYOND `title` — a title-only
    // card renders empty — so that is refined rather than left to produce a
    // useless bubble.
    genericCards: z
      .array(
        z
          .object({
            title: z.string().trim().min(1).max(80),
            subtitle: z.string().trim().min(1).max(80).optional(),
            imageUrl: z
              .string()
              .trim()
              .url()
              .max(2048)
              .regex(/^https?:\/\//i, "must be http(s)")
              .optional(),
            defaultActionUrl: z
              .string()
              .trim()
              .url()
              .max(2000)
              .regex(/^https?:\/\//i, "must be http(s)")
              .optional(),
            buttons: z
              .array(
                z.discriminatedUnion("type", [
                  z.object({
                    type: z.literal("web_url"),
                    title: z.string().trim().min(1).max(20),
                    url: z
                      .string()
                      .trim()
                      .url()
                      .max(2000)
                      .regex(/^https?:\/\//i, "must be http(s)"),
                  }),
                  z.object({
                    type: z.literal("postback"),
                    title: z.string().trim().min(1).max(20),
                    payload: z.string().trim().min(1).max(1000),
                  }),
                ]),
              )
              .min(1)
              .max(3)
              .optional(),
          })
          .refine(
            (c) => Boolean(c.subtitle || c.imageUrl || c.defaultActionUrl || c.buttons?.length),
            { message: "a card needs more than a title (subtitle, image, link or buttons)" },
          ),
      )
      .min(1)
      .max(10)
      .optional(),
    // `product` only — 1-10 catalog product ids (Catalog API / Commerce
    // Manager). Meta draws the card from the catalog entry, so there is nothing
    // else to send.
    productIds: z.array(z.string().trim().min(1).max(200)).min(1).max(10).optional(),
    listCtaLabel: z.string().min(1).max(20).optional(),
    // `carousel` only — 2-10 media cards (interactive-carousel doc). Card
    // rules: image/video header LINK required (Meta fetches it); body ≤160
    // chars with ≤2 line breaks; EITHER one `ctaUrl` button OR 1-3
    // `quickReplies` — and the variant + button COUNT must be uniform across
    // cards (Meta rejects mixed carousels; refined below). The doc states no
    // explicit quick-reply max — 3 matches the reply-buttons ceiling and
    // keeps a clean 400 here instead of an opaque Meta error.
    carouselCards: z
      .array(
        z
          .object({
            headerMedia: z.object({
              kind: z.enum(["image", "video"]),
              link: z.string().trim().url().max(2048).regex(/^https?:\/\//i, "must be http(s)"),
            }),
            body: z
              .string()
              .trim()
              .min(1)
              .max(160)
              .refine((t) => (t.match(/\n/g) ?? []).length <= 2, {
                message: "card body allows at most 2 line breaks",
              })
              .optional(),
            ctaUrl: z
              .object({
                displayText: z.string().trim().min(1).max(20),
                url: z.string().trim().url().max(2000).regex(/^https?:\/\//i, "must be http(s)"),
              })
              .optional(),
            quickReplies: z
              .array(
                z.object({
                  id: z.string().min(1).max(256),
                  title: z.string().min(1).max(20),
                }),
              )
              .min(1)
              .max(3)
              .optional(),
          })
          .refine((c) => Boolean(c.ctaUrl) !== Boolean(c.quickReplies), {
            message: "each card needs exactly one of ctaUrl or quickReplies",
          }),
      )
      .min(2)
      .max(10)
      .optional(),
    // Buttons + list — optional text header/footer (reply-buttons +
    // interactive-list docs; both ≤60 chars, text headers only today).
    headerText: z.string().trim().min(1).max(60).optional(),
    footerText: z.string().trim().min(1).max(60).optional(),
    // One-tap "share your phone / email" consent chips. Messenger + Instagram
    // only (capability `contactShareChips`); the send helper rejects the rest.
    // Meta renders these beside the options and pre-fills them from the
    // customer's profile — the only way a social contact's phone/email can ever
    // reach us, and therefore the only way they become auto-mergeable into a
    // unified Customer. See lib/identity/identity-service.ts.
    contactShare: z.array(z.enum(["phone", "email"])).max(2).optional(),
    // Pre-Meta idempotency key (same as text/media/template sends). A double-
    // click or network-retry that re-POSTs the same clientTempId within the
    // window short-circuits to the first result instead of producing a second
    // interactive message + Meta send. Optional — legacy clients run through
    // un-deduped exactly as before.
    clientTempId: z.string().min(1).optional(),
  })
  .refine((b) => new Set(b.contactShare ?? []).size === (b.contactShare ?? []).length, {
    message: "contactShare entries must be unique",
  })
  .refine((b) => b.kind !== "buttons" || b.options.length <= 3, {
    message: "buttons supports at most 3 options — use kind=list for more",
  })
  // Meta caps the two reply-id kinds DIFFERENTLY: button reply ids at 256, LIST
  // row ids at 200. `options` is shared by both kinds, so the field-level
  // `max(256)` is right for buttons and 56 chars too loose for a list.
  //
  // The provider comment at `meta.ts` sendInteractive already relies on this
  // guard existing — it declines to truncate a list id there (truncating at 200
  // once corrupted a >200-char id so `list_reply.id` no longer matched on reply
  // and ask_question routing fell through) on the stated grounds that "the
  // request schemas hold NEW list ids to 200 at authoring time". They did not.
  // A 201-256 char row id therefore reached Meta and came back as an opaque
  // 132xxx surfacing to the operator as "send failed". Reject it here, where the
  // author can actually see and fix it.
  .refine(
    (b) => b.kind !== "list" || b.options.every((o) => o.id.length <= 200),
    { message: "list row ids are limited to 200 characters (button ids allow 256)" },
  )
  // The kinds that carry NO authored options: the vendor draws the affordance
  // (location_request, request_contact_info), or the content lives in a
  // dedicated field (cta_url, carousel, generic, product). Adding a kind
  // without listing it here rejects every send of it with "at least one option
  // is required" — which is exactly what happened to `generic`/`product` until
  // a schema test caught it, because the provider-level tests bypass this gate
  // entirely.
  .refine(
    (b) =>
      [
        "location_request",
        "request_contact_info",
        "cta_url",
        "carousel",
        "generic",
        "product",
      ].includes(b.kind) || b.options.length >= 1,
    {
      message: "at least one option is required",
    },
  )
  .refine(
    (b) =>
      ![
        "location_request",
        "request_contact_info",
        "cta_url",
        "carousel",
        "generic",
        "product",
      ].includes(b.kind) || b.options.length === 0,
    {
      message:
        "this kind carries no options — the vendor or a dedicated field supplies the content",
    },
  )
  .refine(
    // LIST row ids cap at 200 (interactive-list-messages doc) vs 256 for
    // button reply ids. Enforced at authoring time — the provider refuses to
    // truncate (a truncated id silently breaks reply matching).
    (b) => b.kind !== "list" || b.options.every((o) => o.id.length <= 200),
    { message: "list row ids cap at 200 characters" },
  )
  .refine((b) => b.kind !== "carousel" || b.carouselCards !== undefined, {
    message: "carousel requires carouselCards (2-10 cards)",
  })
  .refine((b) => b.kind === "carousel" || b.carouselCards === undefined, {
    message: "carouselCards is only valid with kind carousel",
  })
  .refine(
    // Uniformity across cards: all-ctaUrl or all-quickReplies, and equal
    // quick-reply counts (the doc: "button types and numbers must match").
    (b) => {
      const cards = b.carouselCards;
      if (b.kind !== "carousel" || !cards) return true;
      const urlCount = cards.filter((c) => c.ctaUrl).length;
      if (urlCount !== 0 && urlCount !== cards.length) return false;
      if (urlCount === 0) {
        const n = cards[0]?.quickReplies?.length ?? 0;
        return cards.every((c) => (c.quickReplies?.length ?? 0) === n);
      }
      return true;
    },
    { message: "button type and count must match across all cards", },
  )
  .refine(
    // Quick-reply ids must be unique across the WHOLE carousel — the reply
    // webhook carries only the id, so a duplicate is unroutable.
    (b) => {
      const ids = (b.carouselCards ?? []).flatMap((c) =>
        (c.quickReplies ?? []).map((q) => q.id),
      );
      return new Set(ids).size === ids.length;
    },
    { message: "quick-reply ids must be unique across all cards", },
  )
  .refine((b) => b.kind !== "generic" || b.genericCards !== undefined, {
    message: "generic requires genericCards",
  })
  .refine((b) => b.kind === "generic" || b.genericCards === undefined, {
    message: "genericCards is only valid with kind generic",
  })
  .refine((b) => b.kind !== "product" || b.productIds !== undefined, {
    message: "product requires productIds",
  })
  .refine((b) => b.kind === "product" || b.productIds === undefined, {
    message: "productIds is only valid with kind product",
  })
  .refine((b) => b.kind !== "cta_url" || b.ctaUrl !== undefined, {
    message: "cta_url requires ctaUrl { displayText, url }",
  })
  .refine((b) => b.kind === "cta_url" || b.ctaUrl === undefined, {
    message: "ctaUrl is only valid with kind cta_url",
  })
  .refine(
    (b) => new Set(b.options.map((o) => o.id)).size === b.options.length,
    { message: "option ids must be unique" },
  )
  .refine(
    // Meta rejects interactive buttons/rows that reuse a title (error 131009
    // "Duplicate button title"). Catch it here so the API returns a clean 422
    // instead of bubbling up the raw Meta error. Trimmed + case-insensitive
    // so "Yes" / "yes " can't both slip through.
    (b) => {
      const titles = b.options.map((o) => o.title.trim().toLowerCase());
      return new Set(titles).size === titles.length;
    },
    { message: "button titles must be unique" },
  );
export type SendInteractiveInput = z.infer<typeof SendInteractiveSchema>;

/**
 * Multipart form fields for POST /api/messages/media. The actual file ships
 * separately via @UploadedFile (multer). Everything below is a string because
 * multipart form fields are always strings; `caption` trims to empty for
 * cleaner "no caption" comparisons downstream.
 */
export const SendMediaFormSchema = z.object({
  conversationId: z.string().min(1),
  // WhatsApp caps an inline media caption at 1024 chars (image/video/document);
  // a longer one is rejected by Meta with an opaque error. Social channels don't
  // inline captions at all, so 1024 is the safe ceiling for every channel.
  caption: z
    .string()
    .max(1024)
    .optional()
    .transform((v) => (v ?? "").trim()),
  clientTempId: z.string().min(1).optional(),
  replyToMessageId: z.string().min(1).optional(),
  /**
   * Audio voice-note marker. Multipart form fields are strings — the recorder
   * sends `"true"` so we accept that one literal. Service-side, only audio
   * sends honor it; for anything else it's a no-op.
   */
  voice: z
    .union([z.literal("true"), z.literal("false"), z.boolean()])
    .optional()
    .transform((v) => v === true || v === "true"),
});
export type SendMediaFormInput = z.infer<typeof SendMediaFormSchema>;

// POST /api/messages/forward
//
// Caps chosen to keep worst-case under the reverse-proxy idle timeout
// (~30s). Each Meta send is ~300ms; messages*contacts is the multiplier.
// Past these numbers users should use the broadcast feature instead.
const MAX_FORWARD_MESSAGES = 10;
const MAX_FORWARD_CONTACTS = 5;
const MAX_FORWARD_TOTAL = 40;

export const ForwardMessagesSchema = z
  .object({
    messageIds: z.array(z.string().min(1)).min(1).max(MAX_FORWARD_MESSAGES),
    contactIds: z.array(z.string().min(1)).min(1).max(MAX_FORWARD_CONTACTS),
    // I-1: idempotency identity for the forward action. The client sends a
    // stable id per forward so a transport retry / re-confirmed picker dedupes
    // server-side instead of re-delivering up to 40 messages to customers.
    clientTempId: z.string().min(1).optional(),
  })
  .refine(
    (b) => b.messageIds.length * b.contactIds.length <= MAX_FORWARD_TOTAL,
    {
      message: `too many sends — max ${MAX_FORWARD_TOTAL} messages × recipients per forward (use a broadcast for larger fan-outs)`,
    },
  );
export type ForwardMessagesInput = z.infer<typeof ForwardMessagesSchema>;

/**
 * POST /api/messages/sticker — send a first-party sticker.
 *
 * `imageUrl` is the catalog image. It is OPTIONAL and is only used to capture
 * the picture into R2 at send time; the send itself needs nothing but the id.
 * Restricted to Meta's own CDN host because it is fetched server-side — an
 * arbitrary caller-supplied URL here would be a request-forgery vector even with
 * the SSRF gate behind it, and there is no legitimate reason for a sticker image
 * to live anywhere else.
 */
export const SendStickerSchema = z.object({
  conversationId: z.string().trim().min(1),
  stickerId: z.string().trim().min(1).max(64).regex(/^\d+$/, "sticker ids are numeric"),
  imageUrl: z
    .string()
    .trim()
    .url()
    .refine(
      (u) => {
        try {
          const host = new URL(u).hostname;
          return host.endsWith(".fbcdn.net") || host.endsWith(".facebook.com");
        } catch {
          return false;
        }
      },
      { message: "must be a Meta CDN url" },
    )
    .optional(),
  clientTempId: z.string().trim().min(1).max(128).optional(),
});
export type SendStickerInput = z.infer<typeof SendStickerSchema>;

/**
 * POST /api/messages/messenger-template — send a Messenger template.
 *
 * TWO modes, because Meta has two things called a template and they behave
 * differently:
 *
 *   structured — authored inline, no approval, window-gated like a text reply.
 *   utility    — an APPROVED template, sent with `messaging_type: "UTILITY"`.
 *                The ONLY send that reaches a customer outside the 24-hour
 *                window since Meta retired the three update tags on 2026-04-27.
 *
 * The per-template caps (button counts, E.164 call buttons, 2-6 grid images,
 * Facebook-only media URLs, spaceless coupon codes) are enforced by the payload
 * builder, which owns them next to the doc quotes they come from — validating
 * them a second time here would be two copies of Meta's rules that can drift.
 * The schema's job is shape, not policy.
 */
const MessengerButtonSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("web_url"),
    title: z.string().trim().min(1),
    url: z.string().trim().url(),
    webviewHeightRatio: z.enum(["compact", "tall", "full"]).optional(),
    messengerExtensions: z.boolean().optional(),
    fallbackUrl: z.string().trim().url().optional(),
    hideShareButton: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("postback"),
    title: z.string().trim().min(1),
    payload: z.string().trim().min(1),
  }),
  z.object({
    type: z.literal("phone_number"),
    title: z.string().trim().min(1),
    payload: z.string().trim().min(1),
  }),
]);

const MessengerStructuredTemplateSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("button"),
    text: z.string().trim().min(1),
    buttons: z.array(MessengerButtonSchema).min(1),
  }),
  z.object({
    kind: z.literal("generic"),
    elements: z
      .array(
        z.object({
          title: z.string().trim().min(1),
          subtitle: z.string().trim().optional(),
          imageUrl: z.string().trim().url().optional(),
          defaultActionUrl: z.string().trim().url().optional(),
          buttons: z.array(MessengerButtonSchema).optional(),
        }),
      )
      .min(1),
    sharable: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("media"),
    mediaType: z.enum(["image", "video"]),
    attachmentId: z.string().trim().min(1).optional(),
    url: z.string().trim().url().optional(),
    buttons: z.array(MessengerButtonSchema).optional(),
  }),
  z.object({
    kind: z.literal("image_grid"),
    images: z
      .array(
        z.object({
          url: z.string().trim().url(),
          isHeroImage: z.boolean().optional(),
          action: z
            .discriminatedUnion("type", [
              z.object({ type: z.literal("web_url"), url: z.string().trim().url() }),
              z.object({
                type: z.literal("postback"),
                payload: z.string().trim().min(1),
                // Required by Meta: it is what gets posted into the thread as the
                // recipient's reply, so without it the tap looks inert.
                text: z.string().trim().min(1),
              }),
            ])
            .optional(),
        }),
      )
      .min(2)
      .max(6),
    title: z.string().trim().optional(),
    subtitle: z.string().trim().optional(),
    buttons: z.array(MessengerButtonSchema).optional(),
  }),
  z.object({
    kind: z.literal("receipt"),
    recipientName: z.string().trim().min(1),
    orderNumber: z.string().trim().min(1),
    currency: z.string().trim().min(1),
    paymentMethod: z.string().trim().min(1),
    summary: z.object({
      subtotal: z.number().optional(),
      shippingCost: z.number().optional(),
      totalTax: z.number().optional(),
      totalCost: z.number(),
    }),
    merchantName: z.string().trim().optional(),
    orderUrl: z.string().trim().url().optional(),
    orderedAt: z.coerce.date().optional(),
    elements: z
      .array(
        z.object({
          title: z.string().trim().min(1),
          subtitle: z.string().trim().optional(),
          quantity: z.number().optional(),
          price: z.number(),
          currency: z.string().trim().optional(),
          imageUrl: z.string().trim().url().optional(),
        }),
      )
      .max(100)
      .optional(),
    address: z
      .object({
        street1: z.string().trim().min(1),
        street2: z.string().trim().optional(),
        city: z.string().trim().min(1),
        postalCode: z.string().trim().min(1),
        state: z.string().trim().min(1),
        country: z.string().trim().min(1),
      })
      .optional(),
    adjustments: z
      .array(z.object({ name: z.string().trim().min(1), amount: z.number() }))
      .optional(),
    sharable: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("coupon"),
    title: z.string().trim().min(1),
    subtitle: z.string().trim().optional(),
    couponCode: z.string().trim().optional(),
    couponUrl: z.string().trim().url().optional(),
    couponUrlButtonTitle: z.string().trim().optional(),
    couponPreMessage: z.string().trim().optional(),
    imageUrl: z.string().trim().url().optional(),
    payload: z.string().trim().optional(),
  }),
]);

export const SendMessengerTemplateSchema = z.union([
  z.object({
    conversationId: z.string().trim().min(1),
    mode: z.literal("structured"),
    template: MessengerStructuredTemplateSchema,
    clientTempId: z.string().trim().min(1).max(128).optional(),
  }),
  z.object({
    conversationId: z.string().trim().min(1),
    mode: z.literal("utility"),
    template: z.object({
      templateName: z.string().trim().min(1),
      languageCode: z.string().trim().min(2).max(10),
      // Read from the TEMPLATE, never inferred from its body text — a template
      // whose copy contains a literal {{word}} would otherwise be misread as
      // NAMED and fail every recipient.
      parameterFormat: z.enum(["POSITIONAL", "NAMED"]).optional(),
      bodyParameters: z
        .array(z.object({ text: z.string(), name: z.string().trim().optional() }))
        .optional(),
      buttonParameters: z
        .array(
          z.discriminatedUnion("type", [
            z.object({ type: z.literal("POSTBACK"), payload: z.string().trim().min(1) }),
            // The SUFFIX substituted into the template's own URL, not a full URL.
            z.object({ type: z.literal("URL"), urlSuffix: z.string().trim().min(1) }),
          ]),
        )
        .optional(),
    }),
    clientTempId: z.string().trim().min(1).max(128).optional(),
  }),
]);
export type SendMessengerTemplateInput = z.infer<typeof SendMessengerTemplateSchema>;
