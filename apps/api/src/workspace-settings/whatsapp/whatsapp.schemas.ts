import { z } from "zod";

/**
 * POST /api/workspace/whatsapp — connect / update the team's Meta credentials.
 *
 * `wabaId` and `appId` use optional-update semantics:
 *   - undefined → leave column unchanged
 *   - ""        → clear the column
 *   - non-empty → set to the new value
 *
 * Both use `.optional()` (not just defaulted to empty) so the
 * "leave alone" vs "clear" distinction survives serialization through
 * partially-filled UI forms.
 */
export const UpdateWhatsappConfigSchema = z.object({
  phoneNumberId: z.string().trim().min(1),
  // Optional — the access token (system-user), App secret, and verify token
  // default to the shared Meta App connection when omitted. A pasted value
  // still overrides.
  accessToken: z.string().trim().optional(),
  appSecret: z.string().trim().optional(),
  verifyToken: z.string().trim().optional(),
  wabaId: z.string().trim().optional(),
  appId: z.string().trim().optional(),
});
export type UpdateWhatsappConfigInput = z.infer<typeof UpdateWhatsappConfigSchema>;

/**
 * PATCH /api/workspace/whatsapp/templates/:id — update variableBindings only.
 *
 * Generous on shape: the runner re-parses bindings on every read so a bad
 * write degrades to the legacy `manual` behavior, not a crash. We only
 * require an object (not array / primitive) so a non-object can't land in
 * the JSONB column.
 */
export const UpdateTemplateBindingsSchema = z.object({
  variableBindings: z
    .record(z.string(), z.unknown())
    .refine((v) => !Array.isArray(v), { message: "expected an object" }),
});
export type UpdateTemplateBindingsInput = z.infer<typeof UpdateTemplateBindingsSchema>;

// CreateTemplate body shape is rich (Meta component sub-shapes per
// HEADER/BODY/FOOTER/BUTTONS with per-language semantics + bindings) and
// would require ~150 lines of per-component refinement to express in Zod.
// The pre-migration handler used inline validators with explicit error
// messages; we preserve that approach in the service to avoid duplicating
// Meta's surface area in two type systems.
