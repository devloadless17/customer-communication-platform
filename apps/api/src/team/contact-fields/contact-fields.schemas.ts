import { z } from "zod";

const MAX_LABEL = 60;

export const CreateContactFieldSchema = z.object({
  label: z.string().trim().min(1).max(MAX_LABEL),
});
export type CreateContactFieldInput = z.infer<typeof CreateContactFieldSchema>;

export const UpdateContactFieldSchema = z
  .object({
    label: z.string().trim().min(1).max(MAX_LABEL).optional(),
    order: z
      .number()
      .finite()
      .transform((n) => Math.floor(n))
      .optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: "no fields to update" });
export type UpdateContactFieldInput = z.infer<typeof UpdateContactFieldSchema>;
