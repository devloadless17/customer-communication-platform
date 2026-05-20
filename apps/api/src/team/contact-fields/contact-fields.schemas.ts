import { z } from "zod";

const MAX_LABEL = 60;

/**
 * Built-in contact-panel fields that admins can show/hide. Phone is NOT in
 * this set — it's the WhatsApp identity and always renders. Other built-ins
 * (firstName / lastName / language / countryCode) aren't yet rendered, so
 * they're not on this list either. Adding them later is a non-breaking
 * extension — just append a key + extend the renderer.
 */
export const ContactPanelBuiltinSchema = z.object({
  email: z.boolean().optional(),
  location: z.boolean().optional(),
  firstContacted: z.boolean().optional(),
});
export type ContactPanelBuiltins = z.infer<typeof ContactPanelBuiltinSchema>;

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
    isVisible: z.boolean().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: "no fields to update" });
export type UpdateContactFieldInput = z.infer<typeof UpdateContactFieldSchema>;
