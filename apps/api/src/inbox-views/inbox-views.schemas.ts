import { z } from "zod";

import {
  INBOX_VIEW_ICONS,
  INBOX_VIEW_NAME_MAX,
  INBOX_VIEW_VISIBILITIES,
} from "@ccp/shared/inbox-views/types";
import { TAG_COLORS } from "@ccp/shared/types";

import { zLiveChannel } from "../common/channel-schema";

/**
 * Validation for saved inbox views.
 *
 * The filter document is user-authored JSON that becomes a WHERE clause, so it
 * is validated STRICTLY — `.strict()` rejects unknown keys rather than storing
 * them. A typo'd key silently stored would be silently ignored by the where
 * builder, and the view would quietly match more than the author intended.
 */

const idList = (max: number) => z.array(z.string().min(1)).max(max);

export const InboxViewAssigneeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("anyone") }).strict(),
  z.object({ kind: z.literal("me") }).strict(),
  z.object({ kind: z.literal("unassigned") }).strict(),
  z
    .object({
      kind: z.literal("users"),
      // Bounded: this becomes an `IN (…)` list. A view naming more than 50
      // people is a "shared inbox", which is what leaving it as `anyone` and
      // filtering on something else expresses.
      userIds: idList(50),
    })
    .strict(),
]);

export const InboxViewFiltersSchema = z
  .object({
    statuses: z.array(z.enum(["open", "pending", "closed"])).max(3).optional(),
    assignee: InboxViewAssigneeSchema.optional(),
    // Channel values are validated against the Prisma enum by the DB on read;
    // here we only bound the list. Kept as a plain string array so adding a
    // channel to the enum doesn't need a matching edit in this file.
    // Validated against the LIVE channel set — `zLiveChannel` exists for
    // exactly this and its docblock says "use it for every request-level
    // channel filter". As a bare string this stored anything, and one bogus
    // value permanently 500'd `GET /api/inbox-views/counts` for its owner —
    // or, saved SHARED by an admin or a write:catalog key, for EVERY member
    // of the workspace (counts runs Promise.all over all visible views, so
    // one rejection kills every sidebar badge). Recoverable only by deleting
    // the view. Adding a channel to LIVE_CHANNELS keeps working with zero
    // edits here, which was the reason the free-text shape was chosen.
    channels: z.array(zLiveChannel()).max(20).optional(),
    // Which ACCOUNT (WhatsApp number / Page / handle) — ChannelConnection ids.
    // Bounded generously: a workspace's account count is small, but the cap
    // exists for the same reason every other list here has one.
    channelAccountIds: idList(50).optional(),
    stageIds: idList(50).optional(),
    tagIds: idList(50).optional(),
    tagMatch: z.enum(["any", "all"]).optional(),
    hasOpenFlags: z.boolean().optional(),
    unreadOnly: z.boolean().optional(),
  })
  .strict();

export type InboxViewFiltersInput = z.infer<typeof InboxViewFiltersSchema>;

export const CreateInboxViewSchema = z
  .object({
    name: z.string().trim().min(1).max(INBOX_VIEW_NAME_MAX),
    color: z.enum(TAG_COLORS as unknown as [string, ...string[]]).optional(),
    icon: z.enum(INBOX_VIEW_ICONS as unknown as [string, ...string[]]).optional(),
    visibility: z.enum(INBOX_VIEW_VISIBILITIES as unknown as [string, ...string[]]).optional(),
    filters: InboxViewFiltersSchema,
  })
  .strict();
export type CreateInboxViewInput = z.infer<typeof CreateInboxViewSchema>;

/**
 * Every field optional — this is a PATCH. `visibility` is included on purpose:
 * promoting a personal view to shared is the natural "this turned out to be
 * useful for everyone" move, and it re-runs the manage-capability check.
 */
export const UpdateInboxViewSchema = z
  .object({
    name: z.string().trim().min(1).max(INBOX_VIEW_NAME_MAX).optional(),
    color: z.enum(TAG_COLORS as unknown as [string, ...string[]]).optional(),
    icon: z.enum(INBOX_VIEW_ICONS as unknown as [string, ...string[]]).optional(),
    visibility: z.enum(INBOX_VIEW_VISIBILITIES as unknown as [string, ...string[]]).optional(),
    filters: InboxViewFiltersSchema.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, {
    message: "at least one field is required",
  });
export type UpdateInboxViewInput = z.infer<typeof UpdateInboxViewSchema>;

/**
 * Manual reorder. Sends the full ordered id list for one visibility group so
 * the server assigns positions from the array index — an "insert at position
 * N" API would need the client and server to agree on tie-breaking, and any
 * disagreement shows up as rows that visibly jump after a drag.
 */
export const ReorderInboxViewsSchema = z
  .object({
    ids: z.array(z.string().min(1)).min(1).max(60),
  })
  .strict();
export type ReorderInboxViewsInput = z.infer<typeof ReorderInboxViewsSchema>;
