import { z } from "zod";

export const CreateNoteSchema = z.object({
  conversationId: z.string().min(1),
  body: z.string().trim().min(1).max(8000),
});
export type CreateNoteInput = z.infer<typeof CreateNoteSchema>;
