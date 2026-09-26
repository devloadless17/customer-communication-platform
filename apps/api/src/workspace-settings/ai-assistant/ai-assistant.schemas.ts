import { z } from "zod";

import {
  COLLECT_BUILTIN_TARGETS,
  type CollectBuiltinTarget,
} from "@ccp/shared/ai/collect-details";

/**
 * Zod schemas for the AI Assistant configuration surface (the 7 settings tabs)
 * and knowledge-file management. Every field is optional so the PUT is a merge
 * (the settings UI can save one tab at a time). Enum values mirror the Prisma
 * enums exactly — keep them in sync.
 */

// --- Enums (mirror prisma/schema.prisma) ---
export const AutoReplyModeSchema = z.enum(["auto_send", "draft", "hybrid"]);
export const LanguagePolicySchema = z.enum([
  "match_customer",
  "default_language",
  "specific",
]);
export const ReplyChannelModeSchema = z.enum([
  "text",
  "voice",
  "match_customer",
  "text_and_voice",
]);

/**
 * One entry in the ordered "details to collect" list. The target vocabulary is
 * shared with the settings UI (@ccp/shared/ai/collect-details) so the picker
 * and this validator can never offer different things — and so PHONE stays out
 * of both: `Contact.phoneNumber` is an auto-merge strong key and a typed number
 * is not vendor-verified (see that file's header).
 *
 * `key` is required for a `custom` entry and rejected on a built-in one, so a
 * saved row is unambiguous about where an answer lands. The referenced
 * `ContactFieldDefinition` is NOT verified here: an admin can delete a field
 * afterwards either way, so the runtime already has to tolerate a dangling key
 * (loadContactDetails drops it) and a save-time check would only add a query
 * that guarantees nothing.
 */
// Annotated first, then asserted to the non-empty tuple `z.enum` wants — a
// spread of a mapped array is not itself assignable to that tuple shape.
const COLLECT_TARGETS: Array<CollectBuiltinTarget | "custom"> = [
  ...COLLECT_BUILTIN_TARGETS.map((t) => t.target),
  "custom",
];
const CollectTargetSchema = z.enum(
  COLLECT_TARGETS as [CollectBuiltinTarget | "custom", ...Array<CollectBuiltinTarget | "custom">],
);

export const CollectFieldSchema = z
  .object({
    target: CollectTargetSchema,
    key: z.string().min(1).max(64).optional(),
    purpose: z.string().max(200).optional(),
  })
  .strict()
  .superRefine((row, ctx) => {
    if (row.target === "custom" && !row.key) {
      ctx.addIssue({
        code: "custom",
        path: ["key"],
        message: "custom_field_key_required",
      });
    }
    if (row.target !== "custom" && row.key) {
      // A built-in target already names its column; a stray key would make the
      // saved row ambiguous about where an answer lands.
      ctx.addIssue({ code: "custom", path: ["key"], message: "key_not_allowed" });
    }
  })
  .array()
  .max(12)
  // Order is priority and duplicates would mean asking twice for one thing.
  .refine(
    (rows) =>
      new Set(rows.map((r) => (r.target === "custom" ? `custom:${r.key}` : r.target))).size ===
      rows.length,
    { message: "duplicate_collect_field" },
  );

// --- Structured JSON field shapes ---
const TimeRange = z.object({ open: z.string().max(8), close: z.string().max(8) });
const WeeklySchedule = z.record(z.string(), z.array(TimeRange).max(6));
const Holiday = z.object({ date: z.string().max(32), label: z.string().max(120).optional() });
const ScheduleException = z.object({
  date: z.string().max(32),
  open: z.string().max(8).optional(),
  close: z.string().max(8).optional(),
  closed: z.boolean().optional(),
});
const Location = z
  .object({ label: z.string().max(120).optional(), address: z.string().max(400).optional() })
  .passthrough();
const Faq = z.object({ q: z.string().max(1000), a: z.string().max(4000) });

const shortText = z.string().max(500);
const midText = z.string().max(5000);
const longText = z.string().max(20000);

export const UpdateAiConfigSchema = z
  .object({
    // Optimistic-concurrency token: the configVersion the client last read.
    // A mismatch means someone else saved in the meantime -> 409.
    expectedConfigVersion: z.number().int().nonnegative().optional(),

    enabled: z.boolean().optional(),

    // Company Identity
    companyName: shortText.nullish(),
    shortDescription: midText.nullish(),
    fullDescription: longText.nullish(),
    industry: shortText.nullish(),
    website: shortText.nullish(),
    phone: shortText.nullish(),
    locations: z.array(Location).max(50).optional(),
    serviceAreas: z.array(z.string().max(200)).max(100).optional(),

    // Business Details
    products: longText.nullish(),
    services: longText.nullish(),
    pricingNotes: midText.nullish(),
    paymentMethods: midText.nullish(),
    deliveryPolicy: midText.nullish(),
    returnPolicy: midText.nullish(),
    bookingRules: midText.nullish(),
    faqs: z.array(Faq).max(200).optional(),
    restrictions: midText.nullish(),
    escalationInstructions: midText.nullish(),

    // Opening Hours
    timezone: z.string().max(64).optional(),
    weeklySchedule: WeeklySchedule.optional(),
    holidays: z.array(Holiday).max(100).optional(),
    scheduleExceptions: z.array(ScheduleException).max(100).optional(),
    afterHoursBehavior: midText.nullish(),

    // Languages & Dialect
    supportedLanguages: z.array(z.string().max(16)).max(12).optional(),
    defaultLanguage: z.string().max(16).optional(),
    languagePolicy: LanguagePolicySchema.optional(),
    specificLanguage: z.string().max(16).nullish(),
    lebaneseDialect: z.boolean().optional(),
    lebaneseStyle: midText.nullish(),
    allowArabizi: z.boolean().optional(),
    scriptPolicy: z.enum(["arabic", "latin", "match_customer"]).optional(),
    codeSwitching: z.boolean().optional(),
    emojiPolicy: z.enum(["none", "sparing", "expressive"]).optional(),

    // Tone & Reply Behavior
    tone: z.string().max(60).optional(),
    matchCustomerTone: z.boolean().optional(),
    replyLength: z.enum(["short", "balanced", "detailed"]).optional(),
    autoReplyMode: AutoReplyModeSchema.optional(),
    confidenceThreshold: z.number().min(0).max(1).optional(),
    maxAutoRepliesPerConv: z.number().int().min(0).max(1000).optional(),
    humanTakeoverBehavior: z.string().max(64).optional(),
    replyWaitSeconds: z.number().int().min(0).max(120).optional(),
    collectFields: CollectFieldSchema.optional(),
    collectTiming: z.enum(["opening", "natural"]).optional(),

    // Voice
    incomingTranscription: z.boolean().optional(),
    saveTranscript: z.boolean().optional(),
    replyChannelMode: ReplyChannelModeSchema.optional(),
    voiceId: z.string().max(120).nullish(),
    voiceLanguage: z.string().max(16).optional(),
    voiceSpeed: z.number().min(0.25).max(4).optional(),
    maxVoiceDurationSec: z.number().int().min(1).max(600).optional(),
    voiceTextFallback: z.boolean().optional(),

    replyModelTier: z.enum(["reply", "reply_hard", "cheap"]).optional(),
  })
  .strict();

export type UpdateAiConfigInput = z.infer<typeof UpdateAiConfigSchema>;

export const PatchDocumentSchema = z
  .object({ enabled: z.boolean() })
  .strict();
export type PatchDocumentInput = z.infer<typeof PatchDocumentSchema>;

// Synthesize a short sample line so an admin can hear a voice before saving.
export const VoicePreviewSchema = z
  .object({
    voiceId: z.string().min(1).max(40),
    voiceLanguage: z.string().max(16).optional(),
    voiceSpeed: z.number().min(0.25).max(4).optional(),
  })
  .strict();
export type VoicePreviewInput = z.infer<typeof VoicePreviewSchema>;
