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

const AppearanceSchema = z.object({
  theme: ThemeSchema.optional(),
  welcomeMessage: z.string().trim().max(1000).optional(),
  headerTitle: z.string().trim().max(80).optional(),
  suggestedQuestions: z.array(z.string().trim().min(1).max(200)).max(6).optional(),
  preChatFields: z.array(PreChatFieldSchema).max(6).optional(),
  showBranding: z.boolean().optional(),
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
