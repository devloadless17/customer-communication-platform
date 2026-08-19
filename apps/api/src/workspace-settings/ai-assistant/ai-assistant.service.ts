import { ConflictException, ForbiddenException, Injectable } from "@nestjs/common";

import { DbService } from "../../db/db.service";
import type { UpdateAiConfigInput } from "./ai-assistant.schemas";

/**
 * AI Assistant configuration service. Owns the single per-team
 * `AiAssistantConfig` row behind the settings surface. Deliberately does NOT
 * touch any legacy autopilot field (Team.aiAutopilotEnabled / aiHandoff* /
 * Conversation.aiEnabled) — this is a separate subsystem.
 */

// Mirrors the column defaults in prisma/schema.prisma / the migration so the
// settings UI can render before the first save (no row exists yet). configVersion
// 0 + no id signals "unsaved defaults" to the client.
export const DEFAULT_AI_CONFIG = {
  id: null as string | null,
  enabled: false,
  configVersion: 0,
  companyName: null,
  shortDescription: null,
  fullDescription: null,
  industry: null,
  website: null,
  phone: null,
  locations: [] as unknown[],
  serviceAreas: [] as unknown[],
  products: null,
  services: null,
  pricingNotes: null,
  paymentMethods: null,
  deliveryPolicy: null,
  returnPolicy: null,
  bookingRules: null,
  faqs: [] as unknown[],
  restrictions: null,
  escalationInstructions: null,
  timezone: "Asia/Beirut",
  weeklySchedule: {} as Record<string, unknown>,
  holidays: [] as unknown[],
  scheduleExceptions: [] as unknown[],
  afterHoursBehavior: null,
  supportedLanguages: ["ar", "en"] as string[],
  defaultLanguage: "ar",
  languagePolicy: "match_customer",
  specificLanguage: null,
  lebaneseDialect: true,
  lebaneseStyle: null,
  allowArabizi: true,
  scriptPolicy: "match_customer",
  codeSwitching: true,
  emojiPolicy: "sparing",
  tone: "friendly",
  matchCustomerTone: true,
  replyLength: "balanced",
  customInstructions: null,
  autoReplyMode: "auto_send",
  confidenceThreshold: 0.55,
  maxAutoRepliesPerConv: 0,
  humanTakeoverBehavior: "cancel_and_yield",
  collectCustomerEmail: true,
  incomingTranscription: true,
  saveTranscript: true,
  replyChannelMode: "text",
  voiceId: null,
  voiceLanguage: "ar",
  voiceSpeed: 1.0,
  maxVoiceDurationSec: 60,
  voiceTextFallback: true,
  replyModelTier: "reply",
} as const;

@Injectable()
export class AiAssistantService {
  constructor(private readonly db: DbService) {}

  /** Read the team's config, or synthesized defaults when nothing is saved yet. */
  async getConfig(workspaceId: string) {
    const row = await this.db.aiAssistantConfig.findUnique({ where: { workspaceId } });
    return row ?? { ...DEFAULT_AI_CONFIG, workspaceId };
  }

  /**
   * Merge-update the config. Only keys present in `input` change (a
   * PATCH-per-tab). `expectedConfigVersion` is an optimistic-concurrency guard
   * — a mismatch means a concurrent save clobbered ours. Every successful save
   * bumps `configVersion` (stamped onto every AiAssistantInteraction for audit).
   */
  async updateConfig(workspaceId: string, canManage: boolean, input: UpdateAiConfigInput) {
    if (!canManage) {
      throw new ForbiddenException({ error: "forbidden" });
    }
    const { expectedConfigVersion, ...rest } = input;
    // Prisma ignores `undefined` fields; nullable text columns accept `null` to
    // clear. Our JSON columns are NOT NULL and the schema never allows null for
    // them, so no null ever reaches a JSON column.
    const data = rest as Record<string, unknown>;

    const existing = await this.db.aiAssistantConfig.findUnique({
      where: { workspaceId },
      select: { configVersion: true },
    });

    if (existing) {
      if (expectedConfigVersion === undefined) {
        // No guard asked for — last write wins, but the bump is still atomic so
        // two saves can't land on the same configVersion (it stamps every
        // AiAssistantInteraction).
        return this.db.aiAssistantConfig.update({
          where: { workspaceId },
          data: { ...data, configVersion: { increment: 1 } },
        });
      }
      // The version travels in the WHERE, not a JS compare after the read: a
      // read-then-write lets two concurrent saves both pass the check and the
      // second silently overwrite the first. `updateMany` is the shape that
      // takes a non-unique predicate (the CAS used elsewhere in this codebase).
      const res = await this.db.aiAssistantConfig.updateMany({
        where: { workspaceId, configVersion: expectedConfigVersion },
        data: { ...data, configVersion: expectedConfigVersion + 1 },
      });
      if (res.count === 0) {
        const current = await this.db.aiAssistantConfig.findUnique({
          where: { workspaceId },
          select: { configVersion: true },
        });
        throw new ConflictException({
          error: "config_version_conflict",
          currentVersion: current?.configVersion ?? existing.configVersion,
        });
      }
      return this.db.aiAssistantConfig.findUniqueOrThrow({ where: { workspaceId } });
    }

    try {
      return await this.db.aiAssistantConfig.create({
        data: { workspaceId, ...data, configVersion: 1 },
      });
    } catch (err) {
      // Lost a create race (unique workspaceId) — fall through to an update.
      // Increment rather than read-then-set, same reason as above.
      if ((err as { code?: string })?.code === "P2002") {
        return this.db.aiAssistantConfig.update({
          where: { workspaceId },
          data: { ...data, configVersion: { increment: 1 } },
        });
      }
      throw err;
    }
  }
}
