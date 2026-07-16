import type { ReplyPayload } from "./reply-schema";
import type { AiConfigRow } from "./runtime-config";

/**
 * Pure send/suggest/escalate decision (extracted so it's unit-testable without
 * the orchestrator's import graph). Type-only imports = no runtime deps.
 *
 *  - escalate           → model flagged human handoff.
 *  - suggest            → below the confidence threshold, or draft mode, or the
 *                         in-hours half of hybrid mode.
 *  - send               → auto_send, or the after-hours half of hybrid.
 */
export function decideMode(
  config: Pick<AiConfigRow, "autoReplyMode" | "confidenceThreshold">,
  payload: Pick<ReplyPayload, "shouldEscalate" | "confidence">,
  openNow: boolean,
  isVoice = false,
): "send" | "suggest" | "escalate" {
  if (payload.shouldEscalate) return "escalate";
  // Voice inbound auto-answers off the auto-transcript even below the confidence
  // threshold: the customer sent audio and expects an immediate spoken reply,
  // and transcribed speech naturally reads as lower-confidence — so we do NOT
  // hold voice replies for manual approval. Draft/hybrid modes still draft.
  if (!isVoice && payload.confidence < config.confidenceThreshold) return "suggest";
  if (config.autoReplyMode === "draft") return "suggest";
  if (config.autoReplyMode === "hybrid") return openNow ? "suggest" : "send";
  return "send";
}
