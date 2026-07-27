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
 * POST /api/workspace/whatsapp/register — register a connected number for
 * Cloud API use (Meta's two-step-verification PIN). The PIN passes straight
 * through to Meta and is never stored; a number saved before registration
 * fails every send, and this closes that gap without leaving the app.
 */
export const RegisterWhatsappNumberSchema = z.object({
  accountId: z.string().trim().min(1),
  pin: z
    .string()
    .trim()
    .regex(/^\d{6}$/, "PIN must be exactly 6 digits"),
});
export type RegisterWhatsappNumberInput = z.infer<typeof RegisterWhatsappNumberSchema>;

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

/**
 * Business-profile update. Every field is optional and only what is PRESENT is
 * sent to Meta — an absent field is left alone, an empty string clears it.
 * Sending `""` for an untouched field would wipe it, which is why the provider
 * spreads on `!== undefined` rather than on truthiness.
 *
 * `vertical` is deliberately absent: Meta's `WhatsAppVertical` members aren't
 * published in the profile reference, so we display what Meta returns and leave
 * changing it to WhatsApp Manager rather than guessing an enum.
 */
export const UpdateBusinessProfileSchema = z
  .object({
    // WhatsApp's own limits for `about` and `description` aren't stated in the
    // profile reference, so these bounds are ours: generous enough never to
    // refuse something Meta accepts, tight enough to reject an accident.
    about: z.string().max(139).optional(),
    // 256 IS documented ("maximum 256 characters"), and Meta does not validate
    // the address against any geographic database — it is freeform text.
    address: z.string().max(256).optional(),
    description: z.string().max(512).optional(),
    email: z.union([z.string().email().max(128), z.literal("")]).optional(),
    websites: z.array(z.string().url().max(256)).max(2).optional(),
    /** Handle from the resumable upload route, not a URL — Meta hosts the image. */
    profilePictureHandle: z.string().min(1).max(1024).optional(),
  })
  .refine((b) => Object.keys(b).length > 0, {
    message: "nothing to update",
  });
export type UpdateBusinessProfileInput = z.infer<typeof UpdateBusinessProfileSchema>;

/**
 * QR code / short link. `prefilledMessage` is Meta's documented 140-char cap —
 * a longer one is rejected, and the limit is the whole point of the feature
 * (a customer lands in the chat with this already typed).
 */
export const CreateQrCodeSchema = z.object({
  prefilledMessage: z.string().trim().min(1).max(140),
  /** SVG is the default because a QR code ends up on packaging and signage. */
  imageFormat: z.enum(["SVG", "PNG"]).default("SVG"),
});
export type CreateQrCodeInput = z.infer<typeof CreateQrCodeSchema>;

export const UpdateQrCodeSchema = z.object({
  prefilledMessage: z.string().trim().min(1).max(140),
});
export type UpdateQrCodeInput = z.infer<typeof UpdateQrCodeSchema>;
