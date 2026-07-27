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
): "send" | "suggest" | "escalate" | "escalate_draft" {
  if (payload.shouldEscalate) {
    // An escalation SENDS a hand-off line — and that line is unconstrained
    // model output, not a fixed template. Returning "escalate" unconditionally
    // meant a workspace on `draft` mode ("every outbound approved by a human")
    // still shipped model-authored text to the customer, decided by a boolean
    // the customer's own message steers. Escalation now sends only where the
    // configured mode would have sent anyway; otherwise it DRAFTS the line and
    // still performs the routing + hand-off, which is the part that matters
    // and is not customer-visible.
    const modeWouldSend =
      config.autoReplyMode === "hybrid" ? !openNow : config.autoReplyMode !== "draft";
    return modeWouldSend ? "escalate" : "escalate_draft";
  }
  // Voice inbound auto-answers off the auto-transcript even below the confidence
  // threshold: the customer sent audio and expects an immediate spoken reply,
  // and transcribed speech naturally reads as lower-confidence — so we do NOT
  // hold voice replies for manual approval. Draft/hybrid modes still draft.
  if (!isVoice && payload.confidence < config.confidenceThreshold) return "suggest";
  if (config.autoReplyMode === "draft") return "suggest";
  if (config.autoReplyMode === "hybrid") return openNow ? "suggest" : "send";
  return "send";
}
