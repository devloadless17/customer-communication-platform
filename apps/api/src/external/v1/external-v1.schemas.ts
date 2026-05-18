import { z } from "zod";

import { TAG_COLORS } from "@ccp/shared/types";

// Shared limits — declared at the top so every schema below can reference
// them (was previously declared mid-file which broke after the top-level
// send-message schema started using MAX_TEXT).
const MAX_TEXT = 500;
const MAX_BULK_IDS = 500;
const MAX_FIELDS = 50;

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
});
export type ExternalContactAssignInput = z.infer<typeof ExternalContactAssignSchema>;

export const ExternalContactStatusSchema = z.object({
  status: z.enum(["open", "pending", "closed"]),
});
export type ExternalContactStatusInput = z.infer<typeof ExternalContactStatusSchema>;

export const ExternalAssignSchema = z.object({
  assignedUserId: z.string().min(1).nullable(),
});
export type ExternalAssignInput = z.infer<typeof ExternalAssignSchema>;

export const ExternalStatusSchema = z.object({
  status: z.enum(["open", "pending", "closed"]),
});
export type ExternalStatusInput = z.infer<typeof ExternalStatusSchema>;

export const ExternalNoteSchema = z.object({
  body: z.string().trim().min(1).max(8000),
  authorUserId: z.string().min(1).optional(),
});
export type ExternalNoteInput = z.infer<typeof ExternalNoteSchema>;

// ===========================================================================
// NEW — contacts list + find
// ===========================================================================

export const ListContactsQuerySchema = z.object({
  /** Exact-match filter on E.164 phone. Returns at most one row. */
  phone: z.string().min(1).optional(),
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
  /** Account-manager (cross-thread) — cuid of a User on the team. */
  assignedUserId: z.string().min(1).optional(),
  /** Optional initial tag set (tag ids, must belong to the team). */
  tagIds: z.array(z.string().min(1)).max(50).optional(),
});
export type ExternalCreateContactInput = z.infer<typeof ExternalCreateContactSchema>;

export const ExternalUpdateContactSchema = z
  .object({
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
    /** Set/clear the account-manager assignment. `null` clears, cuid sets. */
    assignedUserId: z.union([z.string().min(1), z.null()]).optional(),
  })
  .passthrough();
export type ExternalUpdateContactInput = z.infer<typeof ExternalUpdateContactSchema>;

// Same body as create but always succeeds (find-or-create on phoneNumber).
export const ExternalUpsertContactSchema = ExternalCreateContactSchema;
export type ExternalUpsertContactInput = z.infer<typeof ExternalUpsertContactSchema>;

// ===========================================================================
// NEW — contact tag operations
// ===========================================================================

export const ExternalContactAddTagsSchema = z.object({
  tagIds: z.array(z.string().min(1)).min(1).max(50),
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
});
export type ExternalContactRemoveTagsInput = z.infer<typeof ExternalContactRemoveTagsSchema>;

export const ExternalBulkTagSchema = z.object({
  contactIds: z.array(z.string().min(1)).min(1).max(MAX_BULK_IDS),
  tagIds: z.array(z.string().min(1)).min(1).max(50),
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
