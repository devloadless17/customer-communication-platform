import { z } from "zod";

const MAX_BODY_LENGTH = 4000;
const MAX_EMOJI_BYTES = 32;

/**
 * A reaction has to actually be an emoji. A byte cap alone let ANY short
 * string become a permanent reaction chip: the endpoint happily stored
 * "PAY ME BITCOIN" and rendered it under the message for every member of the
 * channel, one row per distinct value.
 *
 * `\p{Extended_Pictographic}` covers the pictographic base characters; the
 * rest of the class admits the pieces a real emoji SEQUENCE is built from —
 * skin-tone modifiers, ZWJ, variation selectors, regional indicators (flags)
 * and keycap bases — so 👍🏽, 👨‍👩‍👧, 🇱🇧 and 1️⃣ all pass while plain text does not.
 */
/* eslint-disable-next-line no-misleading-character-class -- matching the individual pieces of an emoji sequence is exactly the intent here. */
const EMOJI_ONLY_RE = /^[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}\u200d\ufe0f\u20e3\u0023\u002a\u0030-\u0039]+$/u;

/**
 * The class above has to admit ASCII digits / # / * because those are the BASE
 * of a keycap sequence (1️⃣ is "1" + VS16 + U+20E3). Requiring at least one
 * non-ASCII code point keeps the real sequences and rejects a bare "1".
 */
const NON_ASCII_RE = /[^\u0020-\u007f]/;

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

/**
 * Cursor-paginated list/search query, shared by every team-chat GET that takes
 * `take` + a keyset cursor. Same reasoning as `BrowseChannelsQuerySchema`
 * above, which was fixed in isolation while five sibling routes kept doing
 * `take ? Number.parseInt(take, 10) : undefined`:
 *
 *   - `?take=abc` → NaN → `Math.min(NaN, 100)` is NaN → Prisma `take: NaN` →
 *     PrismaClientValidationError, which the exception filter does NOT map
 *     (it handles KnownRequestError codes) → unhandled 500.
 *   - `?take=-1`  → `Math.min(-1, 100)` is -1 → an empty page with a null
 *     cursor, silently truncating pagination.
 *
 * `q` is length-capped for the same reason browse caps it: it feeds a
 * `contains` ILIKE, and a multi-KB needle degrades the trigram index into a
 * scan that any authenticated agent could fire 300×/min.
 */
export const ChannelListQuerySchema = z.object({
  q: z.string().trim().max(64).optional(),
  after: z.string().max(256).optional(),
  before: z.string().max(256).optional(),
  messageId: z.string().max(256).optional(),
  take: z.coerce.number().int().min(1).max(100).optional(),
});
export type ChannelListQuery = z.infer<typeof ChannelListQuerySchema>;

/** Open (or re-open) a 1:1 DM with a teammate. */
export const CreateDmSchema = z.object({
  userId: z.string().min(1),
});
export type CreateDmInput = z.infer<typeof CreateDmSchema>;

export const PostChannelMessageSchema = z.object({
  body: z.string().trim().min(1).max(MAX_BODY_LENGTH),
  clientTempId: z.string().min(1).max(128).optional(),
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
    })
    // A byte cap alone let ANY short string become a permanent reaction chip:
    // the endpoint happily stored "PAY ME BITCOIN" and rendered it under the
    // message for every member of the channel, one row per distinct value,
    // with no cap and no bulk removal. Reactions must actually be emoji.
    // `\p{Extended_Pictographic}` covers the pictographic base characters;
    // the rest of the class admits the pieces a real emoji SEQUENCE is built
    // from — skin-tone modifiers, ZWJ, variation selectors, regional
    // indicators (flags) and keycap digits — so 👍🏽, 👨‍👩‍👧, 🇱🇧 and 1️⃣ all pass
    // while plain text does not.
    .refine((s) => EMOJI_ONLY_RE.test(s), {
      message: "emoji must be an emoji",
    })
    // The class above has to admit ASCII digits/#/* because those are the BASE
    // of a keycap sequence (1️⃣ is "1" + VS16 + U+20E3). Requiring at least one
    // non-ASCII code point keeps the real sequences and rejects a bare "1".
    .refine((s) => NON_ASCII_RE.test(s), {
      message: "emoji must be an emoji",
    }),
});
export type ToggleReactionInput = z.infer<typeof ToggleReactionSchema>;
