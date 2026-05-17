import { z } from "zod";

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
