import { z } from "zod";

const MAX_LABEL = 60;

/**
 * Built-in contact-panel fields that admins can show/hide. Phone + name are
 * NOT in this set — phone is the WhatsApp identity, name is the heading;
 * both always render. Every other built-in column on Contact is toggleable
 * here, defaulting to visible on the server side.
 */
export const ContactPanelBuiltinSchema = z.object({
  firstName: z.boolean().optional(),
  lastName: z.boolean().optional(),
  email: z.boolean().optional(),
  location: z.boolean().optional(),
  language: z.boolean().optional(),
  country: z.boolean().optional(),
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
    isVisible: z.boolean().optional(),
  })
  // `order` is intentionally NOT writable here — it can ONLY change via the
  // transactional /reorder endpoint, which renumbers every field atomically.
  // Allowing a raw `order` write on this per-id PATCH would let a client create
  // duplicate `order` values (the exact failure /reorder exists to prevent).
  .refine((b) => Object.keys(b).length > 0, { message: "no fields to update" });
export type UpdateContactFieldInput = z.infer<typeof UpdateContactFieldSchema>;

export const ReorderContactFieldsSchema = z.object({
  orderedIds: z
    .array(z.string().min(1))
    .refine((ids) => new Set(ids).size === ids.length, {
      message: "orderedIds has duplicates",
    }),
});
export type ReorderContactFieldsInput = z.infer<typeof ReorderContactFieldsSchema>;
