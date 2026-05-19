import { z } from "zod";

// Shared coercer for `take` (and similar) query params. Express delivers
// query values as strings; the controller used to parseInt in-line which
// silently passed `NaN` through on bad input. coerce.number().int() reliably
// rejects "abc" / "" / "1.5" at the pipe layer.
const takeQuery = z.coerce.number().int().min(1).max(200).optional();

/**
 * Inbox preset filter ids. Mirrors the client-side `PresetFilterId` so the
 * server can shape the WHERE clause to match. `all` excludes closed; `closed`
 * is the only preset that shows closed threads.
 */
const PresetFilterIdSchema = z.enum(["all", "mine", "unassigned", "closed"]);
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

export const BulkDeleteConversationsSchema = z.object({
  conversationIds: z.array(z.string().min(1)).min(1).max(500),
});
export type BulkDeleteConversationsInput = z.infer<typeof BulkDeleteConversationsSchema>;
