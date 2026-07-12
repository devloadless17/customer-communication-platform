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
      caption: z.string().max(4096).optional(),
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
              link: z.string().url().max(2048),
              filename: z.string().max(255).optional(),
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
export const ExternalContactAssignSchema = z.object({
  assignedUserId: z.string().min(1).nullable(),
  silent: SilentFlag,
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

export const ExternalAssignSchema = z.object({
  assignedUserId: z.string().min(1).nullable(),
  silent: SilentFlag,
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
// still strip `teamId`/FK columns at the door. Don't add `.passthrough()`.
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
    kind: z.enum(["buttons", "list"]),
    options: z
      .array(
        z.object({
          id: z.string().min(1).max(256),
          title: z.string().min(1).max(24),
          description: z.string().max(72).optional(),
        }),
      )
      .min(1)
      .max(10),
    listCtaLabel: z.string().min(1).max(20).optional(),
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
