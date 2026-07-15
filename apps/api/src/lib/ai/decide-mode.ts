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
): "send" | "suggest" | "escalate" {
  if (payload.shouldEscalate) return "escalate";
  if (payload.confidence < config.confidenceThreshold) return "suggest";
  if (config.autoReplyMode === "draft") return "suggest";
  if (config.autoReplyMode === "hybrid") return openNow ? "suggest" : "send";
  return "send";
}
