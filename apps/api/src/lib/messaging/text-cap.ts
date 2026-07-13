import type { ProviderCapabilities } from "@ccp/shared/providers/types";

/**
 * Per-channel outbound text-length cap (WhatsApp 4096, Messenger 2000,
 * Instagram 1000 — see `CHANNEL_CAPABILITIES`).
 *
 * Meta rejects an over-limit body with an opaque error deep inside the send
 * worker, so every send path checks the cap up front. This is the ONE place that
 * knows which capability to read and how to phrase the failure, because the four
 * paths (UI composer, `/v1` API, workflow `send_message`, workflow
 * `ask_question`) must reject identically — an over-cap body that 4xx's cleanly
 * in the composer used to die with a generic provider error in the worker.
 *
 * Returns `null` when the body fits, so callers raise whichever error type suits
 * their layer (an HTTP exception, a step validation error) without this module
 * knowing about either.
 */
export function checkTextCap(
  body: string,
  capabilities: ProviderCapabilities,
  channelLabel: string,
): { detail: string; max: number } | null {
  const max = capabilities.messageTextMaxChars;
  // Instagram counts its limit in UTF-8 bytes, not UTF-16 chars — measure the
  // right unit so an Arabic/emoji body that Meta would reject fails our gate too
  // (with an actionable message) instead of dying opaquely in the send worker.
  const byteMode = capabilities.textLimitIsBytes === true;
  const size = byteMode ? Buffer.byteLength(body, "utf8") : body.length;
  if (size <= max) return null;
  const unit = byteMode ? "bytes" : "characters";
  return {
    max,
    detail: `Message is ${size} ${unit} — ${channelLabel} allows at most ${max} ${unit}.`,
  };
}
