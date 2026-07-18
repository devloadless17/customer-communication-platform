import { z } from "zod";

const MAX_BODY_LENGTH = 4000;
const MAX_EMOJI_BYTES = 32;

const VisibilitySchema = z.enum(["public", "private"]);

export const CreateChannelSchema = z.object({
  name: z.string(),
  description: z.string().trim().max(280).optional(),
  /**
   * Defaults to `private` so an omitted field can never accidentally widen
   * access. The service gates private creation on role; public is open.
   */
  visibility: VisibilitySchema.optional(),
  /**
   * Optional initial member ids beyond the creator. The creator is always
   * added to their new channel, even when this list is empty. Pass an empty
   * array (or omit) for a "just me" channel; the admin can add people later
   * via the members dialog.
   */
  memberUserIds: z.array(z.string().min(1)).max(200).optional(),
});
export type CreateChannelInput = z.infer<typeof CreateChannelSchema>;

export const AddChannelMembersSchema = z.object({
  // Hard cap matches the team-size scaling cliff in CLAUDE.md (50–200 tenants);
  // beyond 200 ids per call the request goes through the bulk-add endpoint.
  userIds: z.array(z.string().min(1)).min(1).max(200),
});
export type AddChannelMembersInput = z.infer<typeof AddChannelMembersSchema>;

export const UpdateChannelSchema = z.object({
  name: z.string().optional(),
  description: z.string().trim().max(280).optional(),
  visibility: VisibilitySchema.optional(),
});
export type UpdateChannelInput = z.infer<typeof UpdateChannelSchema>;

/**
 * Query params for the public-channel browser. Without this, `?take=abc`
 * produced NaN → `Math.min(Math.max(NaN,1),100)` is NaN → Prisma got
 * `take: NaN` → unhandled 500. `q` is length-capped so it can't turn into an
 * unbounded `contains` scan.
 */
export const BrowseChannelsQuerySchema = z.object({
  q: z.string().trim().max(64).optional(),
  before: z.string().max(256).optional(),
  take: z.coerce.number().int().min(1).max(100).optional(),
});
export type BrowseChannelsQuery = z.infer<typeof BrowseChannelsQuerySchema>;

/** Open (or re-open) a 1:1 DM with a teammate. */
export const CreateDmSchema = z.object({
  userId: z.string().min(1),
});
export type CreateDmInput = z.infer<typeof CreateDmSchema>;

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
