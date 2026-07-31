import { z } from "zod";

import {
  WHATSAPP_USERNAME_MAX,
  WHATSAPP_USERNAME_MIN,
} from "@ccp/shared/whatsapp/username";

/**
 * POST /api/workspace/whatsapp — connect / update the team's Meta credentials.
 *
 * `appId` uses optional-update semantics:
 *   - undefined → leave column unchanged
 *   - ""        → clear the column
 *   - non-empty → set to the new value
 *
 * It uses `.optional()` (not just defaulted to empty) so the "leave alone" vs
 * "clear" distinction survives serialization through partially-filled UI forms.
 *
 * `wabaId` is REQUIRED. It used to be optional, and a connection saved without it
 * had no WABA at all — which made the cross-account template guard a no-op (the
 * guard only refuses when both sides are known and differ), so that number could
 * send ANY template in the workspace. Templates are WABA-scoped in Meta, so a
 * number with no WABA has no catalog and cannot meaningfully send one.
 */
export const UpdateWhatsappConfigSchema = z.object({
  phoneNumberId: z.string().trim().min(1),
  // Optional — the access token (system-user), App secret, and verify token
  // default to the shared Meta App connection when omitted. A pasted value
  // still overrides.
  accessToken: z.string().trim().optional(),
  appSecret: z.string().trim().optional(),
  verifyToken: z.string().trim().optional(),
  wabaId: z.string().trim().min(1, "wabaId is required — templates are per-WABA"),
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
 * `vertical` IS supported, with Meta's published member list. It used to be
 * omitted on the grounds that the members "aren't published in the profile
 * reference" — they are, in full, in Business Profiles, so the reason no longer
 * holds and an operator had to leave our UI for WhatsApp Manager to set their own
 * business category. `""` clears it, which the doc allows explicitly ("This can be
 * either an empty string or one of the accepted values").
 */
/** Body-click tracking toggle: `enabled` is the operator's mental model
 *  ("track clicks?"), inverted to Meta's opt-OUT flag in the service. */
export const SetLinkTrackingSchema = z.object({
  enabled: z.boolean(),
});
export type SetLinkTrackingInput = z.infer<typeof SetLinkTrackingSchema>;

export const UpdateBusinessProfileSchema = z
  .object({
    // Meta's stated bound: "Strings must be between 1 and 139 characters."
    //
    // `.min(1)` matters, and is the one field where the "empty string clears it"
    // rule above does NOT apply: the doc says outright "String cannot be empty".
    // Accepting `""` here just forwarded a request Meta rejects, so an operator
    // trying to clear their About text got an opaque Meta error instead of either
    // working or being told why.
    about: z.string().min(1).max(139).optional(),
    // 256 IS documented ("maximum 256 characters"), and Meta does not validate
    // the address against any geographic database — it is freeform text.
    address: z.string().max(256).optional(),
    // Documented: "Character limit 512."
    description: z.string().max(512).optional(),
    email: z.union([z.string().email().max(128), z.literal("")]).optional(),
    websites: z.array(z.string().url().max(256)).max(2).optional(),
    /**
     * Business category. Meta's published `vertical` members, verbatim — an
     * unlisted value is rejected by Graph, so the enum is the validation.
     */
    vertical: z
      .enum([
        "ALCOHOL", "APPAREL", "AUTO", "BEAUTY", "EDU", "ENTERTAIN", "EVENT_PLAN",
        "FINANCE", "GOVT", "GROCERY", "HEALTH", "HOTEL", "NONPROFIT",
        "ONLINE_GAMBLING", "OTC_DRUGS", "OTHER", "PHYSICAL_GAMBLING",
        "PROF_SERVICES", "RESTAURANT", "RETAIL", "TRAVEL", "",
      ])
      .optional(),
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

/**
 * POST /api/workspace/whatsapp/username — adopt or change the number's
 * @username. Zod enforces only the length envelope; the full rule set
 * (charset, at-least-one-letter, period placement, `www`) lives in
 * `checkWhatsappUsername` (@ccp/shared/whatsapp/username), shared with the
 * UI's live validation so the two can never drift — and Meta stays the final
 * authority either way.
 *
 * `transferAction: "force_transfer"` resolves Meta's 147005 conflict (the
 * username is already on ANOTHER of the portfolio's numbers) by MOVING it
 * here. Without it the API answers 409 `username_transfer_required`, so a
 * caller must ask for the transfer deliberately — the other number silently
 * loses its handle.
 */
export const SetWhatsappUsernameSchema = z.object({
  username: z
    .string()
    .trim()
    .min(WHATSAPP_USERNAME_MIN)
    .max(WHATSAPP_USERNAME_MAX),
  transferAction: z.enum(["none", "force_transfer"]).optional(),
});
export type SetWhatsappUsernameInput = z.infer<typeof SetWhatsappUsernameSchema>;
