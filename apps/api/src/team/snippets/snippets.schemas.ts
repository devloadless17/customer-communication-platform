import { z } from "zod";

/**
 * Snippet name follows the slash-command grammar in the reply-box popup:
 * lowercase, digits, underscores, ≤64 chars. Enforced server-side too so a
 * stale client can't smuggle a name the picker can't render.
 */
const nameField = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    /^[a-z0-9_]{1,64}$/,
    "use lowercase letters, digits and underscores only (max 64 chars)",
  );

export const CreateSnippetSchema = z.object({
  name: nameField,
  label: z.string().trim().min(1).max(80),
  body: z.string().trim().min(1).max(4000),
});
export type CreateSnippetInput = z.infer<typeof CreateSnippetSchema>;

export const UpdateSnippetSchema = z
  .object({
    name: nameField.optional(),
    label: z.string().trim().min(1).max(80).optional(),
    body: z.string().trim().min(1).max(4000).optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: "nothing to update" });
export type UpdateSnippetInput = z.infer<typeof UpdateSnippetSchema>;
