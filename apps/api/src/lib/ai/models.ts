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

/**
 * STT for CALL RECORDINGS — deliberately NOT `sttModel()`.
 *
 * Call audio needs three things a voice note doesn't, and only `whisper-1`
 * returns them (`gpt-4o-transcribe` supports `response_format: json` alone):
 *
 *   - `no_speech_prob` per segment — the ONLY defence against transcribing
 *     silence. Measured 2026-07-29: `gpt-4o-transcribe` answered pure digital
 *     silence with "人間失格" and faint noise with "Horecaonderneming",
 *     confidently and with no signal to catch it. whisper-1 flagged the same
 *     clips at no_speech_prob 0.94 / 0.89 against 0.009 for real speech.
 *   - `avg_logprob` — confidence, which is what lets a channel whose language
 *     was mis-detected be RETRIED pinned to the other channel's language
 *     instead of being stored as gibberish.
 *   - segment TIMESTAMPS — required to interleave the two channels into one
 *     speaker-attributed conversation instead of two blocks.
 *
 * Arabic was the reason to prefer gpt-4o-transcribe; measured across three
 * Lebanese sentences the two are equivalent, so nothing is given up.
 */
export function callSttModel(): string {
  return process.env.AI_CALL_STT_MODEL || "whisper-1";
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

export function anthropicApiKey(): string | null {
  return process.env.ANTHROPIC_API_KEY?.trim() || null;
}

/**
 * Which engine generates the reply TEXT (replyText + spoken ttsText). Claude is
 * markedly better at Lebanese/Arabizi dialect than gpt-4o, so it's the target.
 * Explicit override via AI_TEXT_PROVIDER ("anthropic" | "openai"); otherwise
 * auto — use Anthropic whenever a key is present, else fall back to OpenAI. STT
 * and voice synthesis are unaffected (they stay on OpenAI / Azure).
 */
export function replyTextProvider(): "anthropic" | "openai" {
  const explicit = (process.env.AI_TEXT_PROVIDER || "").trim().toLowerCase();
  if (explicit === "anthropic") return "anthropic";
  if (explicit === "openai") return "openai";
  return anthropicApiKey() ? "anthropic" : "openai";
}

/** Claude model for the reply-text step. Tunable; defaults to the flagship. */
export function anthropicReplyModel(): string {
  return process.env.AI_ANTHROPIC_MODEL_REPLY || "claude-opus-4-8";
}

/**
 * Is there ANY engine available to generate reply text? `reply-service`
 * happily runs on Anthropic alone (falling back to OpenAI only on a live
 * Anthropic error) — so a deployment with only ANTHROPIC_API_KEY set is a
 * fully valid configuration. Gating the reply pipeline on `openaiConfigured()`
 * (OpenAI-only) would silently kill every reply on exactly that deployment.
 * Use this for "can the assistant reply at all"; keep using
 * `openaiConfigured()` / `azureTtsConfigured()` for paths that are genuinely
 * OpenAI/Azure-only (STT transcription, TTS voice synthesis).
 */
export function aiTextEngineConfigured(): boolean {
  return aiGloballyEnabled() && (!!openaiApiKey() || !!anthropicApiKey());
}
