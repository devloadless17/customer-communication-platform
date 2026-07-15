import { db } from "@/lib/db";

import { resolveModel } from "./models";
import { chatJson } from "./openai-client";
import { loadConversationMeta, loadRecentMessages } from "./thread";

/**
 * Structured customer-memory extraction (correction #1 + #7). Produces
 * PERSON-level, durable memory candidates with confidence + provenance. Runs as
 * a separate idempotent job after the reply commits; never blocks it (#14).
 * Transient order/complaint specifics deliberately stay in the SESSION summary,
 * not here. Nothing is written to Customer/Message — only AiCustomerMemory.
 */

const KINDS = [
  "preferred_language",
  "dialect",
  "script",
  "tone",
  "communication_style",
  "interest",
  "recurring_need",
  "preference",
] as const;
type MemoryKind = (typeof KINDS)[number];
const KIND_SET = new Set<string>(KINDS);

const MIN_CONFIDENCE = 0.5;
const CONFIRM_CONFIDENCE = 0.8;
const MAX_MEMORY_PER_CUSTOMER = 120;

interface MemoryItemOut {
  kind: string;
  value: string;
  confidence: number;
}

const MEMORY_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "value", "confidence"],
        properties: {
          kind: { type: "string", enum: [...KINDS] },
          value: { type: "string" },
          confidence: { type: "number", description: "0..1 confidence this is a durable fact." },
        },
      },
    },
  },
};

export async function runMemoryExtraction(
  conversationId: string,
  latestMessageId?: string | null,
): Promise<void> {
  const meta = await loadConversationMeta(conversationId);
  if (!meta || !meta.customerId) return; // person-level memory requires a customer
  const customerId = meta.customerId;

  const messages = await loadRecentMessages(conversationId, 60);
  if (!messages.length) return;
  const transcript = messages
    .map((m) => `${m.direction === "in" ? "Customer" : m.aiGenerated ? "AI" : "Agent"}: ${m.body}`)
    .join("\n")
    .slice(0, 10000);

  const system =
    "Extract DURABLE, person-level facts about this customer that will help FUTURE conversations: preferred language, dialect, script, tone, communication style, interests, recurring needs, and stable preferences. Do NOT extract transient details (a specific current order, a one-time complaint, today's request). Only include facts you are reasonably confident are stable, each with a confidence 0..1. Return an empty items array if nothing durable is present.";
  const user = `Conversation:\n${transcript}\n\nExtract durable customer memory items.`;

  const res = await chatJson<{ items: MemoryItemOut[] }>({
    model: resolveModel("summary"),
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    schemaName: "customer_memory",
    schema: MEMORY_SCHEMA,
    maxTokens: 700,
  });

  const items = (res.data?.items ?? [])
    .filter((i) => i && i.value?.trim() && KIND_SET.has(i.kind) && i.confidence >= MIN_CONFIDENCE)
    .slice(0, 20);
  if (!items.length) return;

  const total = await db.aiCustomerMemory.count({ where: { teamId: meta.teamId, customerId } });
  let room = Math.max(0, MAX_MEMORY_PER_CUSTOMER - total);

  for (const it of items) {
    const kind = it.kind as MemoryKind;
    const value = it.value.trim().slice(0, 500);
    const status = it.confidence >= CONFIRM_CONFIDENCE ? "confirmed" : "candidate";

    // Dedup on (customer, kind, value). Never resurrect a human-rejected item.
    const existing = await db.aiCustomerMemory.findFirst({
      where: { teamId: meta.teamId, customerId, kind, value },
    });
    if (existing) {
      if (existing.status === "rejected") continue;
      await db.aiCustomerMemory.update({
        where: { id: existing.id },
        data: {
          confidence: Math.max(existing.confidence, it.confidence),
          status: existing.status === "confirmed" ? "confirmed" : status,
          sourceConversationId: conversationId,
          sourceMessageId: latestMessageId ?? existing.sourceMessageId,
        },
      });
      continue;
    }
    if (room <= 0) break;
    await db.aiCustomerMemory.create({
      data: {
        teamId: meta.teamId,
        customerId,
        kind,
        value,
        confidence: it.confidence,
        status,
        source: "system",
        sourceConversationId: conversationId,
        sourceMessageId: latestMessageId ?? null,
      },
    });
    room -= 1;
  }
}
