import { z } from "zod";

import { TAG_COLORS } from "@ccp/shared/types";

// Shared limits — declared at the top so every schema below can reference
// them (was previously declared mid-file which broke after the top-level
// send-message schema started using MAX_TEXT).
const MAX_TEXT = 500;
const MAX_BULK_IDS = 500;
const MAX_FIELDS = 50;

/**
 * Opt-in "don't trigger reactions" flag, shared by the mutating /v1 endpoints
 * (assign / status / contact-update / tag ops). When `true` the published
 * domain event carries `silent: true`, which both the workflow-dispatch and
 * outbound-webhook subscribers honor — so a partner changing a tag (or
 * (un)assigning) via the API doesn't re-trigger a workflow or echo a webhook
 * back to itself and loop. Defaults `false`: existing integrations are
 * unaffected; you opt out of reactions per request only when you'd loop.
 * Socket UI updates + audit timeline still happen.
 *
 * Named `silent` to match the wire all the way down: request `silent` →
 * event `silent` → subscriber `if (e.silent) return`. Same word everywhere.
 * See ConversationAssignedEvent.silent in @ccp/shared/events/types.
 */
const SilentFlag = z.boolean().optional();

// ===========================================================================
// EXISTING (do not break — partners depend on these shapes)
// ===========================================================================

export const ListConversationsQuerySchema = z.object({
  phone: z.string().optional(),
  status: z.enum(["open", "pending", "closed"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
  /**
   * A saved inbox view (`GET /v1/inbox-views`) to filter by. Its stored
   * criteria are ANDed with `status` / `phone` rather than replacing them, so
   * the two compose predictably; a key only sees SHARED views, and an unknown
   * id is a 404.
   */
  viewId: z.string().min(1).optional(),
  /**
   * One channel ACCOUNT — a specific WhatsApp number, Facebook Page or
   * Instagram handle (`ChannelConnection.id`, from `GET /v1/channel-accounts`).
   *
   * Parity with the inbox's account picker, which is a locked rule: the UI can
   * narrow to one number, so a partner must be able to as well. ANDed with
   * everything else rather than replacing it — "unassigned" and "on the Sales
   * number" are different questions.
   *
   * An unknown id is not an error: it simply matches nothing, the same as a
   * `status` that no thread has. Validating it would leak whether an id exists.
   */
  accountId: z.string().min(1).optional(),
});
export type ListConversationsQueryInput = z.infer<typeof ListConversationsQuerySchema>;

export const ListMessagesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).optional(),
});
export type ListMessagesQueryInput = z.infer<typeof ListMessagesQuerySchema>;

export const ExternalSendMessageSchema = z.object({
  body: z.string().trim().min(1).max(4096),
  replyToMessageId: z.string().min(1).optional(),
  // No-interrupt guard for AI auto-replies: when true, the send is skipped
  // (200 `{ skipped: "ai_disabled" }`, no WhatsApp send) if AI Autopilot has
  // been paused for the conversation since the inbound arrived — i.e. a human
  // took over mid-generation. The n8n reply node sets this so the AI can never
  // talk over a human.
  onlyIfAiEnabled: z.boolean().optional(),
});
export type ExternalSendMessageInput = z.infer<typeof ExternalSendMessageSchema>;

/**
 * Top-level POST /v1/messages — n8n-shaped send. Resolves a contact (by id
 * OR phone) → finds-or-opens a conversation → sends. Mirrors respond.io's
 * `Send Message` node which accepts either identifier. Saves the customer
 * from a contact-lookup → channel-lookup → send chain.
 *
 * `channel_id` is accepted but advisory today (single channel per team);
 * passing the team's actual channel id is a no-op, passing something else
 * is ignored (we don't reject for forward-compat with multi-channel UX).
 *
 * `client_temp_id` round-trips through the message envelope so n8n nodes
 * (or any caller doing optimistic UI) can correlate the sent message back
 * to their local in-flight state.
 */
export const ExternalTopLevelSendMessageSchema = z.object({
  contact: z.union([
    z.object({ id: z.string().min(1) }).strict(),
    z.object({ phone: z.string().min(1) }).strict(),
  ]),
  text: z.string().trim().min(1).max(4096).optional(),
  media: z
    .object({
      url: z.string().url(),
      mime_type: z.string().min(1).max(120),
      filename: z.string().max(MAX_TEXT).optional(),
      caption: z.string().max(1024).optional(), // WhatsApp inline-caption max
    })
    .optional(),
  template: z
    .object({
      name: z.string().min(1).max(MAX_TEXT),
      language: z.string().min(2).max(12),
      // Positional variables matching Meta's `{{1}}, {{2}}, …` placeholder
      // model. `body` is the ordered list of body placeholder values;
      // `header` is the (optional) single header placeholder value.
      // Mirrors how the internal sendTemplate path takes variables so the
      // resolution + validation logic in send-template-internal.ts can
      // catch placeholder-count mismatches in one place.
      variables: z
        .object({
          body: z.array(z.string().max(MAX_TEXT)).default([]),
          header: z.string().max(MAX_TEXT).optional(),
          // Media for an IMAGE/VIDEO/DOCUMENT template header. Partners supply
          // a public URL to the media; Meta fetches it at send time.
          headerMedia: z
            .object({
              kind: z.enum(["image", "video", "document"]),
              // Either form. `id` is a media id already uploaded to Meta —
              // Meta's recommended shape, since a `link` makes it fetch from
              // your server on every send. Exactly one is required.
              link: z.string().url().max(2048).optional(),
              id: z.string().min(1).max(255).optional(),
              filename: z.string().max(255).optional(),
            })
            .refine((m) => Boolean(m.link) !== Boolean(m.id), {
              message: "header media needs exactly one of `link` or `id`",
            })
            .optional(),
          // The pin for a LOCATION template header. The component is declared
          // with no parameters at template-create time, so the whole pin is
          // supplied per message here. Parity with the inbox composer, which
          // gained the same field — a locked rule for /v1.
          headerLocation: z
            .object({
              latitude: z.string().min(1).max(32),
              longitude: z.string().min(1).max(32),
              // Optional per Meta — a pin renders from coordinates alone.
              name: z.string().max(120).optional(),
              address: z.string().max(255).optional(),
            })
            .optional(),
          // NAMED-format bodies (`parameter_format: NAMED`, `{{order_id}}`).
          // When present the provider ignores the positional `body` array.
          bodyNamed: z
            .array(
              z.object({
                name: z.string().min(1).max(80),
                text: z.string().max(MAX_TEXT),
              }),
            )
            .max(32)
            .optional(),
          // Send-time parameters for dynamic buttons: a URL button's `{{1}}`
          // suffix, a coupon copy-code, or a quick-reply payload. Meta rejects
          // the send without them, so a template with one is undeliverable
          // unless the caller supplies it here.
          buttons: z
            .array(
              z.object({
                index: z.number().int().min(0).max(9),
                subType: z.enum(["url", "copy_code", "quick_reply"]),
                text: z.string().min(1).max(MAX_TEXT),
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
    })
    .optional(),
  channel_id: z.string().min(1).optional(),
  client_temp_id: z.string().min(1).max(255).optional(),
  reply_to_message_id: z.string().min(1).optional(),
}).refine(
  (b) => Boolean(b.text || b.media || b.template),
  { message: "must include text, media, or template" },
);
export type ExternalTopLevelSendMessageInput = z.infer<typeof ExternalTopLevelSendMessageSchema>;

/**
 * Contact-keyed conversation actions (assign/unassign + status). Mirrors
 * respond.io's `Assign or unassign a Conversation` + `Open or close a
 * Conversation` nodes — both keyed by contactId. We resolve the contact's
 * (most-recent) conversation server-side and apply the existing action.
 */
/** Contact-keyed assign. Same options as ExternalAssignSchema — kept in
 *  lockstep so the two entry points can't drift. */
export const ExternalContactAssignSchema = z
  .object({
    assignedUserId: z.string().min(1).nullable().optional(),
    autoAssign: z.boolean().optional(),
    policyId: z.string().min(1).nullable().optional(),
    overwrite: z.boolean().optional(),
    silent: SilentFlag,
  })
  .refine((v) => v.autoAssign === true || v.assignedUserId !== undefined, {
    message: "provide assignedUserId (or null), or autoAssign: true",
  });
export type ExternalContactAssignInput = z.infer<typeof ExternalContactAssignSchema>;

export const ExternalContactStatusSchema = z.object({
  status: z.enum(["open", "pending", "closed"]),
  silent: SilentFlag,
});
export type ExternalContactStatusInput = z.infer<typeof ExternalContactStatusSchema>;

// Move a contact along the lifecycle pipeline (Lead → Customer → …). The
// dedicated, discoverable sibling of assign/status — body is just the target
// `stageId` (validate it against GET /v1/stages). Delegates to the same update
// path as PATCH /contacts/:id, so it fires `contact.lifecycle_changed` (workflow
// "On Contact Lifecycle updated" trigger + the in-conversation stage pill +
// outbound webhook) exactly like the UI's stage picker. To CLEAR a stage, use
// PATCH /contacts/:id with `{ "stageId": null }`.
export const ExternalContactStageSchema = z.object({
  stageId: z.string().min(1),
});
export type ExternalContactStageInput = z.infer<typeof ExternalContactStageSchema>;

/**
 * Assign a conversation.
 *
 *   { assignedUserId: "usr_..." }          — a specific teammate
 *   { assignedUserId: null }               — unassign
 *   { autoAssign: true }                   — route with the team's assignment
 *                                            policy (routing rules → default)
 *   { autoAssign: true, policyId: "..." }  — route with a NAMED policy
 *
 * `autoAssign` is the API twin of the workflow `assign_to` auto-route mode and
 * the inbox's automatic routing: same strategies, weights, capacity and
 * eligibility, so a partner integration can't route in a way the admin's
 * settings forbid. It takes precedence over `assignedUserId` when both are
 * sent.
 *
 * `overwrite` (default TRUE here, unlike internal automation) — an explicit
 * API call is a deliberate instruction, so it reassigns by default. Pass false
 * to make it fill-an-empty-slot-only.
 */
export const ExternalAssignSchema = z
  .object({
    assignedUserId: z.string().min(1).nullable().optional(),
    autoAssign: z.boolean().optional(),
    policyId: z.string().min(1).nullable().optional(),
    overwrite: z.boolean().optional(),
    silent: SilentFlag,
  })
  .refine((v) => v.autoAssign === true || v.assignedUserId !== undefined, {
    message: "provide assignedUserId (or null), or autoAssign: true",
  });
export type ExternalAssignInput = z.infer<typeof ExternalAssignSchema>;

export const ExternalStatusSchema = z.object({
  status: z.enum(["open", "pending", "closed"]),
  silent: SilentFlag,
});
export type ExternalStatusInput = z.infer<typeof ExternalStatusSchema>;

/**
 * Toggle AI Autopilot from the partner side — the AI escalation branch calls
 * this with `{ aiEnabled: false }` to hand the conversation to a human (the
 * value then rides every subsequent message.received as `ai_enabled` so the
 * partner flow stops auto-replying). `silent` skips the outbound-webhook echo
 * so the AI doesn't get its own ai_changed delivery back.
 *
 * On `aiEnabled:false` the team's configured handoff action (unassign /
 * assign-fixed / round-robin) runs AFTER the pause BY DEFAULT — this route is
 * only ever hit by the AI flow's "human" branch, so a customer handoff is the
 * intent. Pass `applyHandoffPolicy:false` to opt a specific call out (e.g. an
 * automation that pauses the AI for a non-handoff reason). The agent inbox
 * toggle + auto-pause-on-reply use other code paths and never run the policy.
 */
export const ExternalSetAiSchema = z.object({
  aiEnabled: z.boolean(),
  silent: SilentFlag,
  applyHandoffPolicy: z.boolean().optional(),
});
export type ExternalSetAiInput = z.infer<typeof ExternalSetAiSchema>;

export const ExternalNoteSchema = z.object({
  body: z.string().trim().min(1).max(8000),
  authorUserId: z.string().min(1).optional(),
  // When true, partner integrations subscribed to `note.created` outbound
  // webhooks do NOT receive an echo for THIS write. Lets an n8n flow that
  // reacts to a customer message by adding a note break its own webhook
  // loop without depending on chain-depth alone.
  silent: SilentFlag,
});
export type ExternalNoteInput = z.infer<typeof ExternalNoteSchema>;

// ===========================================================================
// NEW — contacts list + find
// ===========================================================================

export const ListContactsQuerySchema = z.object({
  /** Exact-match filter on E.164 phone. Returns at most one row. */
  phone: z.string().min(1).optional(),
  /** Exact-match filter on email. Returns at most one row. Case-insensitive
   *  since emails compare case-insensitively per RFC. */
  email: z.string().trim().min(1).optional(),
  /** Exact-match filter on the integrator-owned id stamped at create time.
   *  Returns at most one row. Lets partners look up our contact by their
   *  own CRM id without storing our ids. */
  externalContactId: z.string().min(1).optional(),
  /** Free-text search across name / phone / email / customFields. */
  search: z.string().trim().min(1).optional(),
  stageId: z.string().min(1).optional(),
  /**
   * One channel ACCOUNT — a specific WhatsApp number, Facebook Page or
   * Instagram handle (`ChannelConnection.id`, from `GET /v1/channel-accounts`).
   *
   * Parity with the contacts browser's account filter, which is a locked rule
   * (§12): the UI can narrow to "people who message the Sales number", so a
   * partner must be able to as well. ANDed with the other filters rather than
   * replacing them. An unknown id simply matches nothing — validating it would
   * leak whether the id exists.
   */
  accountId: z.string().min(1).optional(),
  /** Comma-separated tag id list, ANY-match. */
  tagIds: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ListContactsQueryInput = z.infer<typeof ListContactsQuerySchema>;

// ---------------------------------------------------------------------------
// customFields shape — strings or null. null removes the key on patch; on
// create it's a no-op. Same caps as internal contacts.schemas.
// ---------------------------------------------------------------------------
const CustomFieldsSchema = z
  .record(
    z.string().min(1).max(80),
    z.union([z.string().max(MAX_TEXT), z.null()]),
  )
  .refine(
    (obj) => Object.keys(obj).length <= MAX_FIELDS,
    { message: `at most ${MAX_FIELDS} customFields entries` },
  );

// Shared validators for the new webhook-facing contact fields. Reused on
// both create + update + upsert paths so the schemas stay aligned.
//
// `language` is BCP-47-ish — we don't validate the full RFC because a strict
// regex rejects mixed-case tags that Meta sends ("ar_LB"). Loose cap + max
// length is enough for honest clients.
const LanguageSchema = z.string().trim().min(2).max(12);
// `countryCode` is ISO 3166-1 alpha-2 — exactly 2 letters, normalize to upper.
const CountryCodeSchema = z
  .string()
  .trim()
  .length(2)
  .regex(/^[A-Za-z]{2}$/)
  .transform((v) => v.toUpperCase());

export const ExternalCreateContactSchema = z.object({
  phoneNumber: z.string().min(1),
  name: z.string().trim().max(MAX_TEXT).optional(),
  firstName: z.string().trim().max(MAX_TEXT).optional(),
  lastName: z.string().trim().max(MAX_TEXT).optional(),
  language: LanguageSchema.optional(),
  countryCode: CountryCodeSchema.optional(),
  email: z.string().trim().max(MAX_TEXT).optional(),
  location: z.string().trim().max(MAX_TEXT).optional(),
  customFields: CustomFieldsSchema.optional(),
  stageId: z.string().min(1).optional(),
  /** Optional initial tag set (tag ids, must belong to the team). */
  tagIds: z.array(z.string().min(1)).max(50).optional(),
});
export type ExternalCreateContactInput = z.infer<typeof ExternalCreateContactSchema>;

// Default Zod `.strip()` — unknown keys silently dropped. The service layer
// also destructures to a known allowlist (external-v1.service.ts:556-566),
// so even if someone refactored to `data: input` directly, the schema would
// still strip `workspaceId`/FK columns at the door. Don't add `.passthrough()`.
export const ExternalUpdateContactSchema = z.object({
    name: z.string().trim().min(1).max(MAX_TEXT).optional(),
    firstName: z
      .union([z.string().trim().max(MAX_TEXT), z.null()])
      .transform((v) => (typeof v === "string" && v.length === 0 ? null : v))
      .optional(),
    lastName: z
      .union([z.string().trim().max(MAX_TEXT), z.null()])
      .transform((v) => (typeof v === "string" && v.length === 0 ? null : v))
      .optional(),
    language: z
      .union([LanguageSchema, z.null()])
      .optional(),
    countryCode: z
      .union([CountryCodeSchema, z.null()])
      .optional(),
    email: z
      .union([z.string().trim().max(MAX_TEXT), z.null()])
      .transform((v) => (typeof v === "string" && v.length === 0 ? null : v))
      .optional(),
    location: z
      .union([z.string().trim().max(MAX_TEXT), z.null()])
      .transform((v) => (typeof v === "string" && v.length === 0 ? null : v))
      .optional(),
    customFields: CustomFieldsSchema.optional(),
    stageId: z.union([z.string().min(1), z.null()]).optional(),
    silent: SilentFlag,
  });
export type ExternalUpdateContactInput = z.infer<typeof ExternalUpdateContactSchema>;

// Same body as create but always succeeds (find-or-create on phoneNumber).
// On the UPDATE branch (existing live contact) every field is forwarded to the
// update path; `tagIds` is applied ADDITIVELY (tags are added, never removed —
// upsert is a merge, not a replace). To unassign a tag use the dedicated
// DELETE /contacts/:id/tags/:tagId route.
export const ExternalUpsertContactSchema = ExternalCreateContactSchema;
export type ExternalUpsertContactInput = z.infer<typeof ExternalUpsertContactSchema>;

// ===========================================================================
// NEW — contact tag operations
// ===========================================================================

export const ExternalContactAddTagsSchema = z.object({
  tagIds: z.array(z.string().min(1)).min(1).max(50),
  silent: SilentFlag,
});
export type ExternalContactAddTagsInput = z.infer<typeof ExternalContactAddTagsSchema>;

/**
 * Bulk-remove tags from a SINGLE contact in one call. Mirrors the
 * `POST /v1/contacts/:id/tags` (add) ergonomics so an n8n flow that adds and
 * later removes N tags doesn't have to loop. Service-side fires a single
 * `contact.tag_changed` event with the full `removed` array.
 */
export const ExternalContactRemoveTagsSchema = z.object({
  tagIds: z.array(z.string().min(1)).min(1).max(50),
  silent: SilentFlag,
});
export type ExternalContactRemoveTagsInput = z.infer<typeof ExternalContactRemoveTagsSchema>;

export const ExternalBulkTagSchema = z.object({
  contactIds: z.array(z.string().min(1)).min(1).max(MAX_BULK_IDS),
  tagIds: z.array(z.string().min(1)).min(1).max(50),
  // When true, partner integrations subscribed to `contact.tag_changed` /
  // `contact.updated` outbound webhooks do NOT receive echoes for THIS
  // bulk write. Required for any partner that fans tag changes back to
  // /v1 — without this they'd loop until chain-depth caps catch up.
  silent: SilentFlag,
});
export type ExternalBulkTagInput = z.infer<typeof ExternalBulkTagSchema>;

// ===========================================================================
// NEW — custom field definitions
// ===========================================================================

export const ExternalCreateContactFieldSchema = z.object({
  label: z.string().trim().min(1).max(60),
});
export type ExternalCreateContactFieldInput = z.infer<
  typeof ExternalCreateContactFieldSchema
>;

// ===========================================================================
// NEW — tags catalog
// ===========================================================================

export const ExternalCreateTagSchema = z.object({
  name: z.string().trim().min(1).max(40),
  color: z.string().optional(),
});
export type ExternalCreateTagInput = z.infer<typeof ExternalCreateTagSchema>;

export const ExternalUpdateTagSchema = z
  .object({
    name: z.string().trim().min(1).max(40).optional(),
    color: z
      .string()
      .refine((v) => (TAG_COLORS as string[]).includes(v))
      .optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: "nothing to update" });
export type ExternalUpdateTagInput = z.infer<typeof ExternalUpdateTagSchema>;

// ===========================================================================
// NEW — interactive send (buttons / list / consent chips)
// ===========================================================================

/**
 * Body for `POST /v1/conversations/:id/interactive`. Mirrors the internal
 * `SendInteractiveSchema` (apps/api/src/messages/messages.schemas.ts) field for
 * field, minus `conversationId` (it's the path param) and `clientTempId` (`/v1`
 * dedupes on the mandatory `Idempotency-Key` header instead).
 *
 * This endpoint exists because §12 locks `/v1` to full parity with the UI, and
 * `contactShare` — Meta's one-tap "share your phone / email" consent chips — was
 * reachable only from the composer. Those chips are the ONLY way a Messenger /
 * Instagram contact's phone or email ever reaches us, and therefore the only
 * source of a self-asserted email that may auto-merge a unified Customer
 * (docs/identity.md). An automation that can't send them can't build a person.
 */
export const ExternalSendInteractiveSchema = z
  .object({
    body: z.string().trim().min(1).max(1024),
    // `location_request` renders WhatsApp's own "send location" button — no
    // authored options (refined below); `cta_url` is the single URL-opening
    // button configured via `ctaUrl`. Mirrors SendInteractiveSchema.
    kind: z.enum(["buttons", "list", "location_request", "cta_url", "carousel"]),
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
    // Buttons + list — optional text header/footer (≤60 each, text only).
    headerText: z.string().trim().min(1).max(60).optional(),
    footerText: z.string().trim().min(1).max(60).optional(),
    contactShare: z.array(z.enum(["phone", "email"])).max(2).optional(),
  })
  .refine((b) => new Set(b.contactShare ?? []).size === (b.contactShare ?? []).length, {
    message: "contactShare must not repeat a field",
    path: ["contactShare"],
  })
  // The three refines below MUST stay identical to `SendInteractiveSchema`
  // (apps/api/src/messages/messages.schemas.ts). §12 makes /v1 a mirror of the
  // UI; a partner sending the same body an agent can send must get the same
  // answer, not an opaque Meta error the composer would have caught.
  .refine((b) => b.kind !== "buttons" || b.options.length <= 3, {
    message: "buttons supports at most 3 options — use kind=list for more",
    path: ["options"],
  })
  .refine((b) => ["location_request", "cta_url", "carousel"].includes(b.kind) || b.options.length >= 1, {
    message: "at least one option is required",
    path: ["options"],
  })
  .refine((b) => !["location_request", "cta_url", "carousel"].includes(b.kind) || b.options.length === 0, {
    message: "this kind carries no options — WhatsApp renders the button",
    path: ["options"],
  })
  .refine(
    // LIST row ids cap at 200 (interactive-list-messages doc) vs 256 for
    // button reply ids. Authoring-time gate; the provider never truncates.
    (b) => b.kind !== "list" || b.options.every((o) => o.id.length <= 200),
    { message: "list row ids cap at 200 characters", path: ["options"] },
  )
  .refine((b) => b.kind !== "carousel" || b.carouselCards !== undefined, {
    message: "carousel requires carouselCards (2-10 cards)",
    path: ["carouselCards"],
  })
  .refine((b) => b.kind === "carousel" || b.carouselCards === undefined, {
    message: "carouselCards is only valid with kind carousel",
    path: ["carouselCards"],
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
    { message: "button type and count must match across all cards",
    path: ["carouselCards"], },
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
    { message: "quick-reply ids must be unique across all cards",
    path: ["carouselCards"], },
  )
  .refine((b) => b.kind !== "cta_url" || b.ctaUrl !== undefined, {
    message: "cta_url requires ctaUrl { displayText, url }",
    path: ["ctaUrl"],
  })
  .refine((b) => b.kind === "cta_url" || b.ctaUrl === undefined, {
    message: "ctaUrl is only valid with kind cta_url",
    path: ["ctaUrl"],
  })
  .refine((b) => new Set(b.options.map((o) => o.id)).size === b.options.length, {
    message: "option ids must be unique",
    path: ["options"],
  })
  .refine(
    // Meta rejects repeated button titles (error 131009 "Duplicate button
    // title"). Trimmed + case-insensitive, so "Yes" and "yes " can't both slip
    // through — an exact-string Set would let them, and Meta would reject.
    (b) => {
      const titles = b.options.map((o) => o.title.trim().toLowerCase());
      return new Set(titles).size === titles.length;
    },
    { message: "option titles must be unique", path: ["options"] },
  );
export type ExternalSendInteractiveInput = z.infer<typeof ExternalSendInteractiveSchema>;

/** Broadcast list — `status`/`since` let a BI client poll "what completed since
 *  my last sync" instead of re-pulling history. */
export const ListBroadcastsQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  /**
   * One channel ACCOUNT (`ChannelConnection.id`) — which number/Page the
   * campaign SENT FROM. The history already displays it; without this you can
   * read it but not narrow by it, so "what did the Sales line send last month?"
   * needs a client-side scan of every campaign.
   */
  accountId: z.string().min(1).optional(),
  status: z
    .enum([
      "scheduled",
      "materializing",
      "queued",
      "running",
      "completed",
      "failed",
      "canceled",
      "paused",
    ])
    .optional(),
  since: z.string().datetime().optional(),
});
export type ListBroadcastsQueryInput = z.infer<typeof ListBroadcastsQuerySchema>;

/**
 * Recipient-level results. `outcome` uses the same buckets the in-app report
 * deep-links with (including `never_received`, the union of rejected-at-send and
 * accepted-but-undeliverable). `updatedSince` drives incremental sync.
 */
export const ListBroadcastRecipientsQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  outcome: z
    .enum([
      "all",
      "never_received",
      "delivered",
      "read",
      "replied",
      "clicked",
      "failed",
      "undelivered",
      "pending",
    ])
    .optional(),
  errorCode: z.string().max(64).optional(),
  updatedSince: z.string().datetime().optional(),
});
export type ListBroadcastRecipientsQueryInput = z.infer<
  typeof ListBroadcastRecipientsQuerySchema
>;

/**
 * Start an import of a file previously staged through
 * `POST /v1/contacts/import/upload`. Mirrors the in-app options exactly —
 * /v1 parity with the UI is a locked rule (CLAUDE.md §12).
 */
export const ExternalStartImportSchema = z
  .object({
    uploadKey: z.string().min(1).max(400),
    filename: z.string().max(300).default("contacts.csv"),
    format: z.enum(["csv", "xlsx"]).default("csv"),
    mode: z.enum(["create_only", "create_and_update", "update_only"]).default("create_only"),
    tagMode: z.enum(["merge", "replace"]).default("merge"),
    /** Per-row events (workflows + outbound webhooks). Forced off above the
     *  server's fanout cap regardless of what's requested. */
    fireAutomations: z.boolean().default(true),
    mapping: z.record(z.string().max(200), z.string().max(120)).optional(),
  })
  .strict();
export type ExternalStartImportInput = z.infer<typeof ExternalStartImportSchema>;

/**
 * Call history listing. Keyset cursor on (ringingAt DESC, id DESC), same wire
 * form as the internal Calls page.
 */
export const ExternalListCallsQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().optional(),
    /** Restrict to one conversation's calls. */
    conversationId: z.string().min(1).optional(),
    /**
     * One channel ACCOUNT (`ChannelConnection.id`) — which of your numbers the
     * call happened on. Parity with the internal calls filter (§12). Matched
     * through the conversation, since `Call` deliberately has no account column
     * (the thread owns it, and every call action resolves credentials there).
     */
    accountId: z.string().min(1).optional(),
    /** ISO instants bounding `ringingAt`. */
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
  })
  .strict();
export type ExternalListCallsQueryInput = z.infer<
  typeof ExternalListCallsQuerySchema
>;

/**
 * A WhatsApp call button — a CTA that starts a call TO the business.
 *
 * `payload` is the attribution handle: it comes back on the call webhooks so
 * an inbound call can be traced to the campaign or record that produced the
 * button. Older WhatsApp clients drop it, so never depend on it arriving.
 */
export const ExternalCallButtonSchema = z
  .object({
    /** Context shown above the button. */
    bodyText: z.string().trim().min(1).max(1024),
    /** Button label. Provider default is "Call Now". */
    displayText: z.string().trim().min(1).max(20).optional(),
    /** How long the button stays tappable: 1 minute to 30 days. */
    ttlMinutes: z.coerce.number().int().min(1).max(43_200).optional(),
    payload: z.string().max(512).optional(),
  })
  .strict();
export type ExternalCallButtonInput = z.infer<typeof ExternalCallButtonSchema>;

// ---- Message flags ---------------------------------------------------------
//
// Per-message triage markers with an open/resolved lifecycle. The external twin
// of the in-app inbox surface — same domain functions, apiKey actor.

const ExternalFlagStatusSchema = z.enum(["open", "resolved", "dismissed"]);

/**
 * Raise a flag on a message. The definition may be given by id OR by name —
 * a partner integration is configured by a human who knows "Complaint", not a
 * cuid. Exactly one of the two is required.
 */
export const ExternalRaiseFlagSchema = z
  .object({
    definitionId: z.string().min(1).optional(),
    definitionName: z.string().trim().min(1).max(40).optional(),
    note: z.string().trim().max(1000).optional(),
    assignedToId: z.string().min(1).nullable().optional(),
  })
  .strict()
  .refine((b) => Boolean(b.definitionId) !== Boolean(b.definitionName), {
    message: "Provide exactly one of definitionId or definitionName",
  });
export type ExternalRaiseFlagInput = z.infer<typeof ExternalRaiseFlagSchema>;

export const ExternalUpdateFlagSchema = z
  .object({
    status: ExternalFlagStatusSchema.optional(),
    // Explicit null clears the owner; omitted leaves it unchanged.
    assignedToId: z.string().min(1).nullable().optional(),
    note: z.string().trim().max(1000).nullable().optional(),
    resolutionNote: z.string().trim().max(1000).nullable().optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: "nothing to update" });
export type ExternalUpdateFlagInput = z.infer<typeof ExternalUpdateFlagSchema>;

/** Repeatable `status` / `definitionId` params arrive as `string | string[]`
 *  from Express; the preprocess also accepts the comma-joined form. */
const ExternalFlagCsv = z.preprocess((v) => {
  if (v === undefined || v === null || v === "") return undefined;
  const parts = Array.isArray(v) ? v : String(v).split(",");
  const cleaned = parts.map((p) => String(p).trim()).filter(Boolean);
  return cleaned.length ? cleaned : undefined;
}, z.array(z.string()).optional());

export const ExternalListFlagsQuerySchema = z.object({
  status: z.preprocess(
    (v) =>
      v === undefined || v === ""
        ? undefined
        : Array.isArray(v)
          ? v
          : String(v).split(","),
    z.array(ExternalFlagStatusSchema).optional(),
  ),
  definitionId: ExternalFlagCsv,
  /** A user id, or the literal `"unassigned"`. (`"me"` has no meaning for a
   *  key — there is no user behind it.) */
  assignedTo: z.string().min(1).optional(),
  conversationId: z.string().min(1).optional(),
  cursor: z.string().min(1).optional(),
  take: z.coerce.number().int().min(1).max(50).optional(),
  /** Free-text over the message body/caption, the contact, and the flag notes. */
  q: z.string().trim().min(1).max(200).optional(),
});
export type ExternalListFlagsQueryInput = z.infer<typeof ExternalListFlagsQuerySchema>;

/**
 * Message-flag CATALOG writes. Mirrors the in-app settings surface — parity is
 * a locked rule (CLAUDE.md §12), and without these a partner provisioning a
 * workspace can create tags and contact fields but not the "Complaint"
 * definition it needs before it can flag anything.
 */
export const ExternalCreateFlagDefinitionSchema = z
  .object({
    name: z.string().trim().min(1).max(40),
    color: z.string().optional(),
    description: z.string().trim().max(200).optional(),
    sortOrder: z.number().int().min(0).max(9999).optional(),
  })
  .strict();
export type ExternalCreateFlagDefinitionInput = z.infer<
  typeof ExternalCreateFlagDefinitionSchema
>;

export const ExternalUpdateFlagDefinitionSchema = z
  .object({
    name: z.string().trim().min(1).max(40).optional(),
    color: z.string().optional(),
    description: z.string().trim().max(200).nullable().optional(),
    archived: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(9999).optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: "nothing to update" });
export type ExternalUpdateFlagDefinitionInput = z.infer<
  typeof ExternalUpdateFlagDefinitionSchema
>;

/**
 * Window for a template-analytics read. Both bounds optional — the default is
 * the last 30 days, which is the span anyone comparing "how did this template
 * do" actually wants, and is well inside Meta's 90-day lookback.
 */
/** Button-click tracking toggle — `enabled` is the operator's mental model,
 *  inverted to Meta's opt-OUT flag in the domain service (one place). */
export const ExternalSetLinkTrackingSchema = z.object({
  enabled: z.boolean(),
});
export type ExternalSetLinkTrackingInput = z.infer<typeof ExternalSetLinkTrackingSchema>;

export const ExternalTemplateAnalyticsQuerySchema = z
  .object({
    start: z.string().datetime().optional(),
    end: z.string().datetime().optional(),
  })
  .strict();
export type ExternalTemplateAnalyticsQueryInput = z.infer<
  typeof ExternalTemplateAnalyticsQuerySchema
>;

/**
 * Template list filters. Both are exact matches on our stored values, which are
 * Meta's own vocabulary lowercased — so `status=approved` is the one that
 * matters (an integration checking what it may send).
 */
export const ExternalTemplateListQuerySchema = z
  .object({
    status: z
      .enum(["approved", "pending", "rejected", "paused", "disabled", "archived"])
      .optional(),
    category: z.enum(["marketing", "utility", "authentication"]).optional(),
    /** Scope to ONE WhatsApp Business Account — the API-shaped counterpart of
     *  the UI's per-account catalogue scoping. Rows already return `wabaId`,
     *  so a partner reads the id off any row and filters by it. */
    wabaId: z.string().min(1).optional(),
    /** Keyset page size. Meta permits 6,000 templates per WABA and a carousel's
     *  `components` JSON runs to KBs, so an unbounded list could materialize
     *  tens of MB in a 2GB-capped heap — this was the only unpaged list route. */
    limit: z.coerce.number().int().min(1).max(100).default(50),
    /** Opaque cursor: the last template id from the previous page. */
    cursor: z.string().min(1).optional(),
  })
  // `.strict()` like every neighbouring query schema — without it a typo'd
  // `?status_=approved` silently returned the UNFILTERED catalog.
  .strict();
export type ExternalTemplateListQueryInput = z.infer<
  typeof ExternalTemplateListQuerySchema
>;
