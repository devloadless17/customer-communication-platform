/**
 * Env-driven model + credential resolution for the AI Assistant (correction
 * #11). No model id is hardcoded at a call site — everything routes through
 * here, so switching models is an env change. The whole subsystem runs on
 * OpenAI (reasoning + STT + TTS); a single OPENAI_API_KEY.
 *
 * Tier keys come from AiAssistantConfig.replyModelTier; summaries/memory use
 * the `summary` tier.
 */

export type ModelTier = "reply" | "reply_hard" | "cheap" | "summary";

const DEFAULT_MODELS: Record<ModelTier, string> = {
  reply: "gpt-4o",
  reply_hard: "gpt-4o",
  cheap: "gpt-4o-mini",
  summary: "gpt-4o-mini",
};

export function resolveModel(tier: ModelTier): string {
  switch (tier) {
    case "reply":
      return process.env.AI_MODEL_REPLY || DEFAULT_MODELS.reply;
    case "reply_hard":
      return process.env.AI_MODEL_REPLY_HARD || DEFAULT_MODELS.reply_hard;
    case "cheap":
      return process.env.AI_MODEL_CHEAP || DEFAULT_MODELS.cheap;
    case "summary":
      return process.env.AI_MODEL_SUMMARY || DEFAULT_MODELS.summary;
  }
}

/** Map a config replyModelTier value onto a ModelTier (defensive default). */
export function replyTierFromConfig(value: string | null | undefined): ModelTier {
  if (value === "reply_hard" || value === "cheap") return value;
  return "reply";
}

export function sttModel(): string {
  return process.env.AI_STT_MODEL || "gpt-4o-transcribe";
}

export function ttsModel(): string {
  return process.env.AI_TTS_MODEL || "gpt-4o-mini-tts";
}

/** Global kill switch — unset or "1" = on. */
export function aiGloballyEnabled(): boolean {
  return process.env.AI_ASSISTANT_ENABLED !== "0";
}

export function openaiApiKey(): string | null {
  return process.env.OPENAI_API_KEY || null;
}
