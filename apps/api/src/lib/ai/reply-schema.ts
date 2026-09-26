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
  /**
   * Model self-reported risk 0..1 that replyText states something NOT
   * grounded in the company info / retrieved knowledge chunks (a fabricated
   * price, policy, order detail, etc). Distinct from `confidence` (which
   * covers correctness + policy fit broadly) — this is specifically about
   * unverifiable claims, so an agent can spot-check just the risky ones.
   */
  hallucinationRisk: number;
  /** The specific unverified claim(s), or empty string when risk is low/zero. */
  hallucinationNotes: string;
  /**
   * Model self-reported confidence 0..1 that the CUSTOMER's latest message
   * (not the reply) is a complaint — dissatisfaction, a problem report, or a
   * grievance about the product/service/order. 0 for an ordinary question,
   * greeting, or request. Drives the auto-raised "Complaint" message flag.
   */
  complaintConfidence: number;
  /**
   * Contact details the customer stated in their LATEST message, as
   * `{ key, value }` pairs keyed by the detail ids listed in the prompt.
   * Empty when they gave none.
   *
   * Only ever written to the matching `Contact` column / custom field, never
   * used as an identity key — see `captureContactDetails`, which re-validates
   * every value and ignores any key the admin did not configure, because a
   * model asked for a field will happily invent a plausible one.
   */
  collectedDetails: Array<{ key: string; value: string }>;
  /**
   * The detail id `replyText` actually ASKS for, or "". Drives the ask-once
   * bookkeeping (`AiConversationState.requestedDetails`) — the model is the
   * only thing that knows whether it really asked, since it is told to ask
   * only when the moment fits.
   */
  askedForDetail: string;
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
    "hallucinationRisk",
    "hallucinationNotes",
    "complaintConfidence",
    "collectedDetails",
    "askedForDetail",
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
    hallucinationRisk: {
      type: "number",
      description:
        "Risk between 0 and 1 that replyText states a fact (price, policy, order detail, availability) not actually grounded in the company info or retrieved knowledge snippets. 0 when every claim is grounded or the reply makes no factual claims.",
    },
    hallucinationNotes: {
      type: "string",
      description:
        "The specific claim(s) in replyText that aren't grounded in the provided company info/knowledge, or an empty string when hallucinationRisk is 0.",
    },
    complaintConfidence: {
      type: "number",
      description:
        "Confidence between 0 and 1 that the CUSTOMER's latest message is a complaint (unhappy about the product/service/order, reporting a problem). 0 for a normal question, greeting, or neutral request.",
    },
    collectedDetails: {
      type: "array",
      description:
        "Contact details the customer gave in their LATEST message, copied exactly as they wrote them. Use only the detail ids listed under 'This customer's contact details'; omit anything they did not state. Empty array if they gave none. Never guess, complete, or invent a value.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "value"],
        properties: {
          key: { type: "string", description: "The detail id, exactly as listed in the prompt." },
          value: { type: "string", description: "What the customer wrote, verbatim." },
        },
      },
    },
    askedForDetail: {
      type: "string",
      description:
        "The detail id your replyText actually asks the customer for, exactly as listed in the prompt. Empty string if your reply asks for nothing.",
    },
  },
};
