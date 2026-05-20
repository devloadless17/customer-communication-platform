import { z } from "zod";

export const SendTextSchema = z.object({
  conversationId: z.string().min(1),
  body: z.string().trim().min(1).max(8000),
  clientTempId: z.string().min(1).optional(),
  replyToMessageId: z.string().min(1).optional(),
});
export type SendTextInput = z.infer<typeof SendTextSchema>;

export const SendTemplateSchema = z.object({
  conversationId: z.string().min(1),
  templateId: z.string().min(1),
  variables: z
    .object({
      body: z.array(z.string()).default([]),
      header: z.string().optional(),
    })
    .default({ body: [] }),
  clientTempId: z.string().min(1).optional(),
});
export type SendTemplateInput = z.infer<typeof SendTemplateSchema>;

/**
 * Agent-side interactive send. Buttons + list share the same shape; the
 * `kind` discriminator decides whether Meta gets `interactive.type=button`
 * (max 3 options) or `interactive.type=list` (max 10).
 *
 * Limits enforced at the Zod boundary to fail fast — the provider also caps
 * but its error message is cryptic. The composer UI mirrors these caps so
 * the user never hits this validator under normal use.
 */
export const SendInteractiveSchema = z
  .object({
    conversationId: z.string().min(1),
    body: z.string().trim().min(1).max(1024),
    kind: z.enum(["buttons", "list"]),
    options: z
      .array(
        z.object({
          id: z.string().min(1).max(256),
          title: z.string().min(1).max(24),
          description: z.string().max(72).optional(),
        }),
      )
      .min(1)
      .max(10),
    listCtaLabel: z.string().min(1).max(20).optional(),
  })
  .refine((b) => b.kind !== "buttons" || b.options.length <= 3, {
    message: "buttons supports at most 3 options — use kind=list for more",
  })
  .refine(
    (b) => new Set(b.options.map((o) => o.id)).size === b.options.length,
    { message: "option ids must be unique" },
  );
export type SendInteractiveInput = z.infer<typeof SendInteractiveSchema>;

/**
 * Multipart form fields for POST /api/messages/media. The actual file ships
 * separately via @UploadedFile (multer). Everything below is a string because
 * multipart form fields are always strings; `caption` trims to empty for
 * cleaner "no caption" comparisons downstream.
 */
export const SendMediaFormSchema = z.object({
  conversationId: z.string().min(1),
  caption: z
    .string()
    .max(2000)
    .optional()
    .transform((v) => (v ?? "").trim()),
  clientTempId: z.string().min(1).optional(),
  replyToMessageId: z.string().min(1).optional(),
});
export type SendMediaFormInput = z.infer<typeof SendMediaFormSchema>;

// POST /api/messages/forward
//
// Caps chosen to keep worst-case under the reverse-proxy idle timeout
// (~30s). Each Meta send is ~300ms; messages*contacts is the multiplier.
// Past these numbers users should use the broadcast feature instead.
const MAX_FORWARD_MESSAGES = 10;
const MAX_FORWARD_CONTACTS = 5;
const MAX_FORWARD_TOTAL = 40;

export const ForwardMessagesSchema = z
  .object({
    messageIds: z.array(z.string().min(1)).min(1).max(MAX_FORWARD_MESSAGES),
    contactIds: z.array(z.string().min(1)).min(1).max(MAX_FORWARD_CONTACTS),
  })
  .refine(
    (b) => b.messageIds.length * b.contactIds.length <= MAX_FORWARD_TOTAL,
    {
      message: `too many sends — max ${MAX_FORWARD_TOTAL} messages × recipients per forward (use a broadcast for larger fan-outs)`,
    },
  );
export type ForwardMessagesInput = z.infer<typeof ForwardMessagesSchema>;
