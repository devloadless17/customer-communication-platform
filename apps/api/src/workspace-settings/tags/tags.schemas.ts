import { z } from "zod";

import { TAG_COLORS } from "@ccp/shared/types";

/**
 * Shared zod schemas for the tag catalog routes. Schemas are the contract
 * clients depend on — do not loosen.
 */

export const CreateTagSchema = z.object({
  name: z.string().trim().min(1).max(40),
  // Server is permissive on create — unrecognized colors fall back to slate
  // in the service so a stale client doesn't break creation.
  color: z.string().optional(),
});
export type CreateTagInput = z.infer<typeof CreateTagSchema>;

export const UpdateTagSchema = z
  .object({
    name: z.string().trim().min(1).max(40).optional(),
    // On PATCH the color is strict — clients are reading from a known color
    // palette by the time they post an update. Unrecognized values reject
    // so a buggy client doesn't silently drop the swatch they picked.
    color: z
      .string()
      .refine((v) => (TAG_COLORS as string[]).includes(v))
      .optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: "nothing to update" });
export type UpdateTagInput = z.infer<typeof UpdateTagSchema>;
