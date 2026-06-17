import { z } from "zod";

export const SendTextSchema = z.object({
  conversationId: z.string().min(1),
  body: z.string().trim().min(1).max(8000),
  clientTempId: z.string().min(1).optional(),
  replyToMessageId: z.string().min(1).optional(),
});
export type SendTextInput = z.infer<typeof SendTextSchema>;

/**
 * Composer translate. Stateless text transform (no conversation context).
 * `targetLang` is a language NAME (e.g. "Arabic", "French") — Claude reads a
 * name more reliably than a locale code. Constrained to letters/spaces/parens
 * so the UI's curated list is the only realistic input.
 */
export const TranslateSchema = z.object({
  text: z.string().trim().min(1).max(8000),
  targetLang: z
    .string()
    .trim()
    .min(2)
    .max(40)
    .regex(/^[A-Za-z()'\- ]+$/, "Invalid language"),
});
export type TranslateInput = z.infer<typeof TranslateSchema>;

export const SendTemplateSchema = z.object({
  conversationId: z.string().min(1),
  templateId: z.string().min(1),
  variables: z
    .object({
      body: z.array(z.string()).default([]),
      header: z.string().optional(),
      // Media for an IMAGE/VIDEO/DOCUMENT template header. `link` is a public
      // URL (the UploadThing URL the composer already produces).
      headerMedia: z
        .object({
          kind: z.enum(["image", "video", "document"]),
          link: z.string().url().max(2048),
          filename: z.string().max(255).optional(),
        })
        .optional(),
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
    // Pre-Meta idempotency key (same as text/media/template sends). A double-
    // click or network-retry that re-POSTs the same clientTempId within the
    // window short-circuits to the first result instead of producing a second
    // interactive message + Meta send. Optional — legacy clients run through
    // un-deduped exactly as before.
    clientTempId: z.string().min(1).optional(),
  })
  .refine((b) => b.kind !== "buttons" || b.options.length <= 3, {
    message: "buttons supports at most 3 options — use kind=list for more",
  })
  .refine(
    (b) => new Set(b.options.map((o) => o.id)).size === b.options.length,
    { message: "option ids must be unique" },
  )
  .refine(
    // Meta rejects interactive buttons/rows that reuse a title (error 131009
    // "Duplicate button title"). Catch it here so the API returns a clean 422
    // instead of bubbling up the raw Meta error. Trimmed + case-insensitive
    // so "Yes" / "yes " can't both slip through.
    (b) => {
      const titles = b.options.map((o) => o.title.trim().toLowerCase());
      return new Set(titles).size === titles.length;
    },
    { message: "button titles must be unique" },
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
  /**
   * Audio voice-note marker. Multipart form fields are strings — the recorder
   * sends `"true"` so we accept that one literal. Service-side, only audio
   * sends honor it; for anything else it's a no-op.
   */
  voice: z
    .union([z.literal("true"), z.literal("false"), z.boolean()])
    .optional()
    .transform((v) => v === true || v === "true"),
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
    // I-1: idempotency identity for the forward action. The client sends a
    // stable id per forward so a transport retry / re-confirmed picker dedupes
    // server-side instead of re-delivering up to 40 messages to customers.
    clientTempId: z.string().min(1).optional(),
  })
  .refine(
    (b) => b.messageIds.length * b.contactIds.length <= MAX_FORWARD_TOTAL,
    {
      message: `too many sends — max ${MAX_FORWARD_TOTAL} messages × recipients per forward (use a broadcast for larger fan-outs)`,
    },
  );
export type ForwardMessagesInput = z.infer<typeof ForwardMessagesSchema>;
