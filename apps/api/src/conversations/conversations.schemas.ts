import { z } from "zod";

// Shared coercer for `take` (and similar) query params. Express delivers
// query values as strings; the controller used to parseInt in-line which
// silently passed `NaN` through on bad input. coerce.number().int() reliably
// rejects "abc" / "" / "1.5" at the pipe layer.
const takeQuery = z.coerce.number().int().min(1).max(200).optional();

/**
 * Inbox preset filter ids. Mirrors the client-side `PresetFilterId` so the
 * server can shape the WHERE clause to match. `active` = open + pending
 * (everyday view); `all` = truly everything including closed; `mine` /
 * `unassigned` exclude closed; `closed` is the only preset that shows
 * exclusively closed threads.
 */
const PresetFilterIdSchema = z.enum([
  "active",
  "all",
  "mine",
  "unassigned",
  "closed",
  "flagged",
]);
export type PresetFilterId = z.infer<typeof PresetFilterIdSchema>;

export const ListConversationsQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  take: takeQuery,
  search: z.string().max(200).optional(),
  /**
   * Server-side filter. When set, the WHERE clause is narrowed before
   * keyset pagination so `Mine` / `Unassigned` / `Closed` / stage views
   * reflect the FULL team's matching threads, not just whatever happens
   * to be in the loaded slice. Counts come from `/conversations/counts`.
   */
  filter: PresetFilterIdSchema.optional(),
  stageId: z.string().min(1).optional(),
});
export type ListConversationsQuery = z.infer<typeof ListConversationsQuerySchema>;

export const ListMessagesQuerySchema = z.object({
  before: z.string().min(1).optional(),
  after: z.string().min(1).optional(),
  take: takeQuery,
});
export type ListMessagesQuery = z.infer<typeof ListMessagesQuerySchema>;

export const SearchMessagesQuerySchema = z.object({
  q: z.string().max(200).optional(),
  cursor: z.string().min(1).optional(),
  take: takeQuery,
});
export type SearchMessagesQuery = z.infer<typeof SearchMessagesQuerySchema>;

// Global (team-wide) inbox search — the tabbed search bar. `scope` selects
// which entity to search; the response shape differs per scope (the client
// knows the shape from the tab it requested).
export const GlobalSearchQuerySchema = z.object({
  scope: z.enum(["contacts", "messages", "notes"]),
  q: z.string().max(200).optional(),
  cursor: z.string().min(1).optional(),
  take: takeQuery,
});
export type GlobalSearchQuery = z.infer<typeof GlobalSearchQuerySchema>;

// `messageId` is required so it stays at the type level — the controller
// can read query.messageId without re-narrowing.
export const MessageContextQuerySchema = z.object({
  messageId: z.string().min(1),
  before: z.coerce.number().int().min(0).max(100).optional(),
  after: z.coerce.number().int().min(0).max(100).optional(),
});
export type MessageContextQuery = z.infer<typeof MessageContextQuerySchema>;

export const AssignConversationSchema = z.object({
  // Explicit null is meaningful (unassign).
  assignedUserId: z.string().min(1).nullable(),
});
export type AssignConversationInput = z.infer<typeof AssignConversationSchema>;

export const SetConversationStatusSchema = z.object({
  status: z.enum(["open", "pending", "closed"]),
});
export type SetConversationStatusInput = z.infer<typeof SetConversationStatusSchema>;

export const SetConversationAiEnabledSchema = z.object({
  aiEnabled: z.boolean(),
});
export type SetConversationAiEnabledInput = z.infer<typeof SetConversationAiEnabledSchema>;

export const BulkDeleteConversationsSchema = z.object({
  conversationIds: z.array(z.string().min(1)).min(1).max(500),
});
export type BulkDeleteConversationsInput = z.infer<typeof BulkDeleteConversationsSchema>;

// Typing indicator: `active:false` sends `typing_off` (Messenger/Instagram) to
// clear the customer's bubble immediately; default/omitted = `typing_on`.
export const TypingSchema = z.object({
  active: z.boolean().optional(),
});
export type TypingInput = z.infer<typeof TypingSchema>;

export const StartConversationSchema = z
  .object({
    contactId: z.string().min(1).optional(),
    /**
     * Alternative to `contactId`: start (or reopen) a conversation with a phone
     * number, find-or-creating the WhatsApp contact server-side. Powers the
     * shared-contact card's "Message" action, which has a number, not an id.
     */
    phone: z.string().min(1).optional(),
    /** Display name to seed a newly-created contact (ignored if it exists). */
    name: z.string().trim().max(200).optional(),
  })
  .refine((v) => !!v.contactId || !!v.phone, {
    message: "contactId or phone is required",
  });
export type StartConversationInput = z.infer<typeof StartConversationSchema>;

/**
 * Attachments tab in the contact panel. Keyset-paginated (newest first) by
 * the message's compound `(timestamp DESC, id DESC)` order so cursor
 * semantics match the thread itself. `kind` narrows by media category — the
 * gallery's chip filter passes it through. Without `kind`, every media
 * message on the thread is included.
 */
export const ListAttachmentsQuerySchema = z.object({
  // Last `id` from the previous page — fetch attachments strictly OLDER
  // than this row. Absent on the first page.
  cursor: z.string().min(1).optional(),
  take: takeQuery,
  // Maps to the shared `MediaKind` union. The gallery UI groups stickers
  // under "image" (both render as a thumbnail tile).
  kind: z.enum(["image", "video", "audio", "document"]).optional(),
});
export type ListAttachmentsQuery = z.infer<typeof ListAttachmentsQuerySchema>;
