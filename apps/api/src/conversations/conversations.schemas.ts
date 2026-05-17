import { z } from "zod";

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
