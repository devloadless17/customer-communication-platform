import { db } from "@/lib/db";

/**
 * Runtime view of AiAssistantConfig for the engine. A structural interface
 * (rather than importing the generated Prisma type) keeps lib/ai decoupled from
 * the client-generation path and documents exactly which fields the engine
 * reads. The Prisma row is structurally assignable to this.
 */
export interface AiConfigRow {
  workspaceId: string;
  enabled: boolean;
  configVersion: number;

  companyName: string | null;
  shortDescription: string | null;
  fullDescription: string | null;
  industry: string | null;
  website: string | null;
  phone: string | null;
  locations: unknown;
  serviceAreas: unknown;

  products: string | null;
  services: string | null;
  pricingNotes: string | null;
  paymentMethods: string | null;
  deliveryPolicy: string | null;
  returnPolicy: string | null;
  bookingRules: string | null;
  faqs: unknown;
  restrictions: string | null;
  escalationInstructions: string | null;

  timezone: string;
  weeklySchedule: unknown;
  holidays: unknown;
  scheduleExceptions: unknown;
  afterHoursBehavior: string | null;

  supportedLanguages: unknown;
  defaultLanguage: string;
  languagePolicy: "match_customer" | "default_language" | "specific";
  specificLanguage: string | null;
  lebaneseDialect: boolean;
  lebaneseStyle: string | null;
  allowArabizi: boolean;
  scriptPolicy: string;
  codeSwitching: boolean;
  emojiPolicy: string;

  tone: string;
  matchCustomerTone: boolean;
  replyLength: string;
  autoReplyMode: "auto_send" | "draft" | "hybrid";
  confidenceThreshold: number;
  maxAutoRepliesPerConv: number;
  humanTakeoverBehavior: string;
  replyWaitSeconds: number;
  /** Ordered `CollectFieldSpec[]` — see @ccp/shared/ai/collect-details. */
  collectFields: unknown;
  collectTiming: string;

  incomingTranscription: boolean;
  saveTranscript: boolean;
  replyChannelMode: "text" | "voice" | "match_customer" | "text_and_voice";
  voiceId: string | null;
  voiceLanguage: string;
  voiceSpeed: number;
  maxVoiceDurationSec: number;
  voiceTextFallback: boolean;

  replyModelTier: string;
}

/** Load the team's config, or null when unconfigured. */
export async function loadAiConfig(workspaceId: string): Promise<AiConfigRow | null> {
  const row = await db.aiAssistantConfig.findUnique({ where: { workspaceId } });
  return (row as AiConfigRow | null) ?? null;
}

/** True only when the subsystem may run for this team. */
export function configEnabled(cfg: AiConfigRow | null): cfg is AiConfigRow {
  return !!cfg && cfg.enabled === true;
}
