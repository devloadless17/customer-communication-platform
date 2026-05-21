import { z } from "zod";

export const CreateAudienceGroupSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z
    .union([z.string().trim().max(500), z.null()])
    .transform((v) => (typeof v === "string" && v.length === 0 ? null : v))
    .optional(),
  tagIds: z.array(z.string().min(1)).default([]),
  contactIds: z.array(z.string().min(1)).default([]),
});
export type CreateAudienceGroupInput = z.infer<typeof CreateAudienceGroupSchema>;

export const UpdateAudienceGroupSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    description: z
      .union([z.string().trim().max(500), z.null()])
      .transform((v) => (typeof v === "string" && v.length === 0 ? null : v))
      .optional(),
    tagIds: z.array(z.string().min(1)).optional(),
    contactIds: z.array(z.string().min(1)).optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: "nothing to update" });
export type UpdateAudienceGroupInput = z.infer<typeof UpdateAudienceGroupSchema>;
