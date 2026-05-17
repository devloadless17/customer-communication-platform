import { z } from "zod";

export const UpdateUserSchema = z
  .object({
    role: z.string().optional(),
    deactivated: z.boolean().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: "no changes" });
export type UpdateUserInput = z.infer<typeof UpdateUserSchema>;
