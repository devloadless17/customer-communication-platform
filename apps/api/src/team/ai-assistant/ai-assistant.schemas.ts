import { z } from "zod";

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
    customInstructions: longText.nullish(),
    autoReplyMode: AutoReplyModeSchema.optional(),
    confidenceThreshold: z.number().min(0).max(1).optional(),
    maxAutoRepliesPerConv: z.number().int().min(0).max(1000).optional(),
    humanTakeoverBehavior: z.string().max(64).optional(),

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
