/**
 * Structured-output contract for a single AI reply. Sent to OpenAI as a strict
 * json_schema so the model returns validated JSON. `replyText` is the CANONICAL
 * reply (what gets sent as text / stored as the suggestion); `ttsText` is an
 * Arabic-script rendering used only for voice synthesis (correction #12) — the
 * canonical text is never mutated for voice.
 */

export interface ReplyPayload {
  /** The reply to send to the customer, in the resolved language/script. */
  replyText: string;
  /**
   * Arabic-script rendering of the reply for TTS. Equal to replyText when the
   * reply is already Arabic script or when the reply is non-Arabic. Voice
   * synthesis reads this; text sending never does.
   */
  ttsText: string;
  /** BCP-ish tag of the reply language, e.g. "ar", "fr", "en". */
  replyLanguage: string;
  /** "arabic" or "latin" (the script the reply is written in). */
  replyScript: string;
  /** Detected language of the customer's latest message. */
  detectedCustomerLanguage: string;
  /** Short intent label for the customer's message (for audit/memory). */
  intent: string;
  /** Model self-reported confidence 0..1 that the reply is correct + on-policy. */
  confidence: number;
  /** True when a human should take over instead of auto-sending. */
  shouldEscalate: boolean;
  /** Why escalation is needed (empty string when shouldEscalate is false). */
  escalationReason: string;
}

// OpenAI strict structured outputs: every property listed in `required`,
// additionalProperties:false, and no unsupported validation keywords
// (min/max/pattern are expressed in descriptions instead).
export const REPLY_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: [
    "replyText",
    "ttsText",
    "replyLanguage",
    "replyScript",
    "detectedCustomerLanguage",
    "intent",
    "confidence",
    "shouldEscalate",
    "escalationReason",
  ],
  properties: {
    replyText: { type: "string", description: "The reply to send to the customer." },
    ttsText: {
      type: "string",
      description:
        "Arabic-script rendering of the reply for text-to-speech. If the reply is already Arabic script, or is not Arabic at all, repeat replyText verbatim.",
    },
    replyLanguage: { type: "string", description: "Reply language tag, e.g. ar, fr, en." },
    replyScript: {
      type: "string",
      enum: ["arabic", "latin"],
      description:
        "Set 'latin' when the customer wrote in Arabizi — you STILL write replyText in Arabic script; the system transliterates it to Arabizi. Set 'arabic' otherwise.",
    },
    detectedCustomerLanguage: {
      type: "string",
      description: "Detected language of the customer's latest message.",
    },
    intent: { type: "string", description: "Short intent label for the customer's message." },
    confidence: {
      type: "number",
      description:
        "Confidence between 0 and 1 that the reply is correct and within company policy.",
    },
    shouldEscalate: {
      type: "boolean",
      description: "True if a human agent should handle this instead of auto-replying.",
    },
    escalationReason: {
      type: "string",
      description: "Reason for escalation, or an empty string when not escalating.",
    },
  },
};
