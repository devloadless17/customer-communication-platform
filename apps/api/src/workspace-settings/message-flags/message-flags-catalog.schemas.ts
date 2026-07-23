import { z } from "zod";

import { TAG_COLORS } from "@ccp/shared/types";

/**
 * Zod schemas for the message-flag CATALOG routes (which flag kinds exist).
 * Raising / resolving an individual flag is a different surface entirely — see
 * apps/api/src/message-flags/message-flags.schemas.ts.
 *
 * Schemas are the contract clients depend on — do not loosen.
 */

export const CreateFlagDefinitionSchema = z.object({
  name: z.string().trim().min(1).max(40),
  // Permissive on create — an unrecognized color falls back to slate in the
  // service so a stale client can't fail a creation over a swatch. Mirrors
  // CreateTagSchema deliberately: one color vocabulary, one policy.
  color: z.string().optional(),
  description: z.string().trim().max(200).optional(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
});
export type CreateFlagDefinitionInput = z.infer<typeof CreateFlagDefinitionSchema>;

export const UpdateFlagDefinitionSchema = z
  .object({
    name: z.string().trim().min(1).max(40).optional(),
    // Strict on PATCH — by update time the client is picking from a known
    // palette, so an unrecognized value is a bug worth surfacing rather than
    // silently swallowing.
    color: z
      .string()
      .refine((v) => (TAG_COLORS as string[]).includes(v))
      .optional(),
    // Explicit null clears the description; omitted leaves it alone.
    description: z.string().trim().max(200).nullable().optional(),
    archived: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(9999).optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: "nothing to update" });
export type UpdateFlagDefinitionInput = z.infer<typeof UpdateFlagDefinitionSchema>;
