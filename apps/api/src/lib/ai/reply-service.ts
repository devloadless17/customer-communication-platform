import type { ContactDetails } from "./contact-details";
import { replyTierFromConfig, resolveModel } from "./models";
import { chatJson } from "./openai-client";
import { retrieveContextChunks } from "./knowledge-retrieval";
import {
  buildSystemPrompt,
  buildUserPrompt,
  type MemoryItem,
  type RecentMessage,
} from "./prompt-builder";
import { REPLY_SCHEMA, type ReplyPayload } from "./reply-schema";
import type { AiConfigRow } from "./runtime-config";

/**
 * Generates one structured reply from the model. Pure generation: it does NOT
 * claim, re-check eligibility, or send — the orchestrator (automation module)
 * owns those so the "human replied mid-generation" cancel can run on fresh
 * state. Retrieval + prompt assembly + the OpenAI call live here.
 */

export interface GenerateReplyInput {
  config: AiConfigRow;
  latestText: string;
  isVoice: boolean;
  memory: MemoryItem[];
  recentMessages: RecentMessage[];
  details: ContactDetails;
  now?: Date;
}

export interface GeneratedReply {
  payload: ReplyPayload;
  model: string;
  usedChunkIds: string[];
  usedDocumentIds: string[];
  usage: { inputTokens?: number; outputTokens?: number; cachedTokens?: number };
  rawContent: string;
}

export async function generateReply(input: GenerateReplyInput): Promise<GeneratedReply> {
  const now = input.now ?? new Date();
  const chunks = await retrieveContextChunks(input.config.workspaceId, input.latestText, 6);

  const system = buildSystemPrompt(input.config);
  const user = buildUserPrompt({
    config: input.config,
    now,
    memory: input.memory,
    chunks,
    recentMessages: input.recentMessages,
    latestText: input.latestText,
    isVoice: input.isVoice,
    details: input.details,
  });

  // ONE engine. Both replyText and the spoken ttsText come from this single
  // structured call; Lebanese/Arabizi quality is carried by the corpus anchor in
  // the system prompt plus the spelling canonicaliser applied after generation
  // (lib/ai/lebanese), not by which vendor answers.
  const model = resolveModel(replyTierFromConfig(input.config.replyModelTier));
  const res = await chatJson<ReplyPayload>({
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    schemaName: "customer_reply",
    schema: REPLY_SCHEMA,
    maxTokens: 1200,
  });

  if (!res.data || !res.data.replyText?.trim()) {
    throw new Error("ai_empty_reply");
  }

  return {
    payload: normalize(res.data),
    model: res.model ?? model,
    usedChunkIds: chunks.map((c) => c.id),
    usedDocumentIds: [...new Set(chunks.map((c) => c.documentId))],
    usage: {
      inputTokens: res.usage?.prompt_tokens,
      outputTokens: res.usage?.completion_tokens,
      cachedTokens: res.usage?.prompt_tokens_details?.cached_tokens,
    },
    rawContent: res.rawContent,
  };
}

function normalize(p: ReplyPayload): ReplyPayload {
  const replyText = (p.replyText ?? "").trim();
  return {
    replyText,
    ttsText: (p.ttsText ?? "").trim() || replyText,
    replyLanguage: (p.replyLanguage ?? "").trim() || "ar",
    replyScript: p.replyScript === "latin" ? "latin" : "arabic",
    detectedCustomerLanguage: (p.detectedCustomerLanguage ?? "").trim(),
    intent: (p.intent ?? "").trim().slice(0, 120),
    confidence: clamp01(typeof p.confidence === "number" ? p.confidence : 0),
    shouldEscalate: p.shouldEscalate === true,
    escalationReason: (p.escalationReason ?? "").trim(),
    hallucinationRisk: clamp01(
      typeof p.hallucinationRisk === "number" ? p.hallucinationRisk : 0,
    ),
    hallucinationNotes: (p.hallucinationNotes ?? "").trim(),
    complaintConfidence: clamp01(
      typeof p.complaintConfidence === "number" ? p.complaintConfidence : 0,
    ),
    customerEmail: (p.customerEmail ?? "").trim().slice(0, 254),
    askedForEmail: p.askedForEmail === true,
  };
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}
