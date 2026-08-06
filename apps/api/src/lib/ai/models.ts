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
 * every time and write everyday Beirut phrasing unprompted.
 *
 * 5.6-luna over 5.4 and 5.5 on measurement, not on being the newest. Same
 * prompt, same seven customer messages, business open and an email already on
 * file so neither the closed-notice nor the email ask skewed the lengths:
 *
 *                 $/1000 msgs   latency   facts quoted
 *   gpt-5.4          8.30        5141ms   punted on price, punted on booking
 *   gpt-5.6-luna     0.51        2633ms   quoted $900 + $2,000 + $1,500
 *
 * 16x cheaper, twice as fast, and BETTER on the two questions that sell: asked
 * the price, 5.4 gave the starter figure and handed off, while luna gave the
 * online-ordering figure too — both were sitting in the same config. Over 24
 * runs on six fact-bearing questions luna quoted 32/32 of the figures the
 * config could answer with.
 *
 * A grounding rule ("state every figure you were given") was written and
 * measured against this: 32/32 either way, 8 more output tokens. Not added —
 * the model does it unprompted, and an instruction that changes nothing is
 * still read on every request.
 *
 * WATCH, on a small model: `confidence` and `hallucinationRisk` are the model
 * scoring ITSELF, and `confidenceThreshold` is what stands between a wrong
 * answer and auto_send. Nothing in the bake-off looked shaky, but the cases
 * were ordinary ones. AI_MODEL_REPLY=gpt-5.5 buys the polish back for a
 * workspace that wants it; reply_hard is already there.
 *
 * `cheap`/`summary` stay on 4o-mini deliberately — they feed memory extraction
 * and session summaries, never customer-visible text, so there is nothing to
 * gain against the risk of moving them in the same change.
 */
const DEFAULT_MODELS: Record<ModelTier, string> = {
  reply: "gpt-5.6-luna",
  reply_hard: "gpt-5.5", // the slow, careful one, for a workspace that opts in
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
 * How hard a reasoning model should think before answering — or null when the
 * model has no such setting and would reject the parameter.
 *
 * This one IS model-specific, unlike `max_completion_tokens`: gpt-4o and
 * gpt-4o-mini answer "Unrecognized request argument supplied", so it can only
 * be sent to the reasoning families. Hence the name check, which is otherwise
 * the kind of thing this file exists to avoid.
 *
 * Default "low" because the thinking is not free and this is a chat reply, not
 * a proof. Measured on the reply prompt, warm, median of three:
 *
 *   gpt-5.5 default   10.8s     gpt-5.5 low   8.3s
 *   gpt-5.4 low        3.8s     gpt-4o        2.9s
 *
 * A voice turn pays this between STT and TTS, so it is a third of what the
 * customer waits. AI_REASONING_EFFORT=default omits the parameter and lets the
 * model choose; "medium"/"high" are there if a workspace wants the depth.
 */
export function reasoningEffort(model: string): string | null {
  if (!/^(gpt-5|o\d)/.test(model)) return null;
  const v = (process.env.AI_REASONING_EFFORT ?? "low").trim().toLowerCase();
  return !v || v === "default" ? null : v;
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
