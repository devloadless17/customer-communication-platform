/**
 * Env-driven model + credential resolution for the AI Assistant (correction
 * #11). No model id is hardcoded at a call site — everything routes through
 * here, so switching models is an env change. The whole subsystem runs on
 * OpenAI (reasoning + STT + TTS); a single OPENAI_API_KEY. There is no second
 * text vendor — an Anthropic reply path existed briefly and was removed.
 *
 * Tier keys come from AiAssistantConfig.replyModelTier; summaries/memory use
 * the `summary` tier.
 */

export type ModelTier = "reply" | "reply_hard" | "cheap" | "summary";

/**
 * `reply` decides how Lebanese the product sounds, so it was chosen by running
 * real customer messages through every model the account can reach, not by
 * reputation. On "Hii kifkon" and "kifak? bade es2al 3an el delivery":
 *
 *   gpt-4o    "مرحبا! نحن بخير شكرًا"      — Fusha, and it answered an ARABIZI
 *                                            customer in Arabic script
 *   gpt-5.5   "ahlin! n7na mni7, int kifak? kif fina nse3dak?"
 *
 * gpt-4o also mis-set `replyScript` on the greeting, which is what put Arabic
 * script in front of a customer who wrote Latin. The 5.x models set it right
 * every time and write everyday Beirut phrasing unprompted. gpt-5.5 was the
 * most consistent and the most concise; 5.6-luna/sol were close.
 *
 * `cheap`/`summary` stay on 4o-mini deliberately — they feed memory extraction
 * and session summaries, never customer-visible text, so there is nothing to
 * gain against the risk of moving them in the same change.
 */
const DEFAULT_MODELS: Record<ModelTier, string> = {
  reply: "gpt-5.5",
  reply_hard: "gpt-5.5",
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
 * STT for CALL RECORDINGS — deliberately its own setting, not `sttModel()`.
 *
 * `whisper-1`, decided on TWO real production calls after a wrong turn. A
 * single real call had suggested `gpt-4o-transcribe` (it kept code-switched
 * English in Latin script where whisper transliterated it). A second real call
 * refuted that decisively — on 24 seconds of Lebanese conversation:
 *
 *   gpt-4o, no prompt   → "صباح الخير."                    (11 chars)
 *   gpt-4o, WITH prompt → "ألو، كيفك؟ يالله، هلق بشوفلك ياها."
 *                          ↑ THE PROMPT ITSELF, echoed back as the transcript
 *   whisper-1 + prompt  → the whole conversation, 184 chars, covering
 *                          0.0s-23.0s, with "have a good day" and "bye bye"
 *                          correctly in Latin
 *
 * gpt-4o both truncated 24 seconds to a greeting AND regurgitated the prompt
 * as fabricated content, which is the worst possible failure: it reads as a
 * real transcript. whisper-1 handles the code-switching fine once prompted, so
 * there is nothing left to trade.
 *
 * It also returns `verbose_json` — segment timings plus `no_speech_prob` and
 * `avg_logprob` — which the quality gates and speaker turns depend on.
 */
export function callSttModel(): string {
  return process.env.AI_CALL_STT_MODEL || "whisper-1";
}

/** Only `whisper-1` returns `verbose_json` (segment timings + the
 *  `no_speech_prob` / `avg_logprob` quality signals). The gpt-4o transcribe
 *  models accept `json` alone and ignore the rest, so the caller must know
 *  which guards are actually available. */
export function sttSupportsSegments(model: string): boolean {
  return model === "whisper-1";
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

/**
 * Can the assistant generate reply text at all? One engine, one key — kept as
 * its own predicate (rather than inlining `openaiConfigured()`) because the
 * CALL SITES mean different things: this one gates "the assistant may reply",
 * while `openaiConfigured()` / `azureTtsConfigured()` gate the audio paths.
 *
 * Lebanese/Arabizi quality no longer depends on which vendor answers: the
 * dialect signal is the corpus in `lib/ai/lebanese` (prompt anchor + spelling
 * canonicalisation), which applies to whatever model this resolves to.
 */
export function aiTextEngineConfigured(): boolean {
  return aiGloballyEnabled() && !!openaiApiKey();
}
