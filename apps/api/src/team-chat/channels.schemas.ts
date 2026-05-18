import { z } from "zod";

const MAX_BODY_LENGTH = 4000;
const MAX_EMOJI_BYTES = 32;

export const CreateChannelSchema = z.object({
  name: z.string(),
  description: z.string().trim().max(280).optional(),
});
export type CreateChannelInput = z.infer<typeof CreateChannelSchema>;

export const UpdateChannelSchema = z.object({
  name: z.string().optional(),
  description: z.string().trim().max(280).optional(),
});
export type UpdateChannelInput = z.infer<typeof UpdateChannelSchema>;

export const PostChannelMessageSchema = z.object({
  body: z.string().trim().min(1).max(MAX_BODY_LENGTH),
  clientTempId: z.string().min(1).optional(),
});
export type PostChannelMessageInput = z.infer<typeof PostChannelMessageSchema>;

export const EditChannelMessageSchema = z.object({
  body: z.string().trim().min(1).max(MAX_BODY_LENGTH),
});
export type EditChannelMessageInput = z.infer<typeof EditChannelMessageSchema>;

export const ToggleReactionSchema = z.object({
  emoji: z
    .string()
    .trim()
    .min(1)
    .refine((s) => Buffer.byteLength(s, "utf8") <= MAX_EMOJI_BYTES, {
      message: `emoji must be at most ${MAX_EMOJI_BYTES} bytes`,
    }),
});
export type ToggleReactionInput = z.infer<typeof ToggleReactionSchema>;
