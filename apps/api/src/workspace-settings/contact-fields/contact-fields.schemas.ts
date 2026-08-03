import { z } from "zod";

import { TAG_COLORS } from "@ccp/shared/types";

const MAX_LABEL = 60;
const MAX_OPTION_NAME = 60;
/** Stage parity — a select field's catalog is capped like stages are. */
export const MAX_OPTIONS_PER_FIELD = 30;

const OptionColorSchema = z.enum(TAG_COLORS as [string, ...string[]]);

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

export const CreateContactFieldSchema = z
  .object({
    label: z.string().trim().min(1).max(MAX_LABEL),
    // Immutable after create — no update schema accepts it. Existing fields
    // (and omission) are `text`.
    type: z.enum(["text", "select"]).optional(),
    // Optional inline catalog so a select field is usable from one call
    // (settings UX + CRM sync over /v1). Names must be unique within the
    // field; colors default server-side by palette round-robin.
    options: z
      .array(
        z.object({
          name: z.string().trim().min(1).max(MAX_OPTION_NAME),
          color: OptionColorSchema.optional(),
        }),
      )
      .max(MAX_OPTIONS_PER_FIELD)
      .optional(),
  })
  .refine((b) => b.type === "select" || b.options === undefined, {
    message: "options are only valid on select fields",
  });
export type CreateContactFieldInput = z.infer<typeof CreateContactFieldSchema>;

export const CreateFieldOptionSchema = z.object({
  name: z.string().trim().min(1).max(MAX_OPTION_NAME),
  color: OptionColorSchema.optional(),
});
export type CreateFieldOptionInput = z.infer<typeof CreateFieldOptionSchema>;

export const UpdateFieldOptionSchema = z
  .object({
    name: z.string().trim().min(1).max(MAX_OPTION_NAME).optional(),
    color: OptionColorSchema.optional(),
  })
  // `position` is intentionally NOT writable here — only the transactional
  // /reorder endpoint renumbers, same rule as field `order` above.
  .refine((b) => Object.keys(b).length > 0, { message: "no fields to update" });
export type UpdateFieldOptionInput = z.infer<typeof UpdateFieldOptionSchema>;

export const ReorderFieldOptionsSchema = z.object({
  orderedIds: z
    .array(z.string().min(1))
    .max(MAX_OPTIONS_PER_FIELD)
    .refine((ids) => new Set(ids).size === ids.length, {
      message: "orderedIds has duplicates",
    }),
});
export type ReorderFieldOptionsInput = z.infer<typeof ReorderFieldOptionsSchema>;

/**
 * DELETE body. Omitted/undefined `moveToOptionId` → refuse while in use
 * (409 option_in_use + count); a sibling option id → re-point every contact
 * to it in the same transaction; explicit null → clear the value instead.
 */
export const DeleteFieldOptionSchema = z
  .object({
    moveToOptionId: z.string().min(1).nullable().optional(),
  })
  .optional();
export type DeleteFieldOptionInput = z.infer<typeof DeleteFieldOptionSchema>;

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
    // Bounded like every other list schema. The service comments already claim
    // "capped at 50 fields", but the cap lived only on CREATE — a reorder body
    // with 100k ids reached `findMany({ id: { in: ids } })` before anything
    // rejected it, held back only by the JSON body limit.
    .max(50)
    .refine((ids) => new Set(ids).size === ids.length, {
      message: "orderedIds has duplicates",
    }),
});
export type ReorderContactFieldsInput = z.infer<typeof ReorderContactFieldsSchema>;
