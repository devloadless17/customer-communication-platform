import { z } from "zod";

import { TAG_COLORS } from "@ccp/shared/types";

const MAX_NAME = 60;

export const CreateStageSchema = z.object({
  name: z.string().trim().min(1).max(MAX_NAME),
  // Permissive — unrecognized colors fall back to slate in the service.
  color: z.string().optional(),
});
export type CreateStageInput = z.infer<typeof CreateStageSchema>;

export const UpdateStageSchema = z
  .object({
    name: z.string().trim().min(1).max(MAX_NAME).optional(),
    color: z
      .string()
      .refine((v) => (TAG_COLORS as readonly string[]).includes(v), {
        message: "unknown color",
      })
      .optional(),
    isDefault: z.boolean().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: "no fields to update" });
export type UpdateStageInput = z.infer<typeof UpdateStageSchema>;

export const ReorderStagesSchema = z.object({
  orderedIds: z
    .array(z.string().min(1))
    // Bounded like every other list schema. The service comments already claim
    // "capped at 30 stages", but the cap lived only on CREATE — a reorder body
    // with 100k ids reached `findMany({ id: { in: ids } })` before anything
    // rejected it, held back only by the JSON body limit.
    .max(30)
    .refine((ids) => new Set(ids).size === ids.length, {
      message: "orderedIds has duplicates",
    }),
});
export type ReorderStagesInput = z.infer<typeof ReorderStagesSchema>;
