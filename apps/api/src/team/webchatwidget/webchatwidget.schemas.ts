import { z } from "zod";

/**
 * Admin CRUD for a team's website chat widgets. A team runs MANY named widgets
 * (one per website). `name` + `allowedOrigins` are columns; everything else is
 * the non-secret appearance/pre-chat `config` the widget fetches over its socket.
 */

const HexColor = z
  .string()
  .trim()
  .regex(/^#[0-9a-fA-F]{6}$/, "expected a #RRGGBB hex color");

const ThemeSchema = z
  .object({
    primaryColor: HexColor.optional(),
    launcherColor: HexColor.optional(),
    userBubbleColor: HexColor.optional(),
  })
  .strict();

const PreChatFieldSchema = z
  .object({
    // Optional on input — the server mints one when absent. Kept stable on edit.
    id: z.string().trim().min(1).optional(),
    label: z.string().trim().min(1).max(60),
    type: z.enum(["text", "name", "email", "phone"]),
    required: z.boolean().default(false),
  })
  .strict();

/** Origin host: "example.com" or "*.example.com" (scheme/port stripped). */
const OriginSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .transform((s) => s.replace(/^https?:\/\//, "").replace(/\/.*$/, "").toLowerCase());

/** A small inline image (data: URI) or empty string to clear it. Capped so the
 *  config JSON (delivered on every widget connect) stays lean. */
const ImageDataUrl = (maxLen: number) =>
  z
    .string()
    .trim()
    .max(maxLen)
    .refine((v) => v === "" || /^data:image\/(png|jpeg|jpg|gif|webp|svg\+xml);base64,/.test(v), {
      message: "must be an inline image (data:image/…)",
    })
    .optional();

const AppearanceSchema = z.object({
  theme: ThemeSchema.optional(),
  welcomeMessage: z.string().trim().max(1000).optional(),
  headerTitle: z.string().trim().max(80).optional(),
  headerSubtitle: z.string().trim().max(120).optional(),
  suggestedQuestions: z.array(z.string().trim().min(1).max(200)).max(6).optional(),
  preChatFields: z.array(PreChatFieldSchema).max(6).optional(),
  showBranding: z.boolean().optional(),
  // full theming
  logoDataUrl: ImageDataUrl(100_000),
  agentAvatarDataUrl: ImageDataUrl(60_000),
  fontFamily: z.enum(["system", "rounded", "serif"]).optional(),
  themeMode: z.enum(["light", "dark", "auto"]).optional(),
  // launcher / placement (settings-only — the widget reads these from data-* attrs)
  launcher: z.enum(["bubble", "off"]).optional(),
  position: z.enum(["right", "left"]).optional(),
  launcherLabel: z.string().trim().max(40).optional(),
});

export const CreateWidgetSchema = AppearanceSchema.extend({
  name: z.string().trim().min(1).max(80),
  allowedOrigins: z.array(OriginSchema).max(50).default([]),
});
export type CreateWidgetInput = z.infer<typeof CreateWidgetSchema>;

export const UpdateWidgetSchema = AppearanceSchema.extend({
  name: z.string().trim().min(1).max(80).optional(),
  allowedOrigins: z.array(OriginSchema).max(50).optional(),
  isActive: z.boolean().optional(),
});
export type UpdateWidgetInput = z.infer<typeof UpdateWidgetSchema>;
