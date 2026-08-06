import { db } from "@/lib/db";
import { publish } from "@/lib/events/bus";

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

// Kinds that hold at most ONE active value per person (a newer value supersedes
// the prior one). The rest accumulate as independent items.
const SINGLETON_KINDS = new Set<MemoryKind>([
  "preferred_language",
  "dialect",
  "script",
  "tone",
  "communication_style",
]);

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
    usage: { op: "memory", workspaceId: meta.workspaceId },
  });

  const items = (res.data?.items ?? [])
    .filter((i) => i && i.value?.trim() && KIND_SET.has(i.kind) && i.confidence >= MIN_CONFIDENCE)
    .slice(0, 20);
  if (!items.length) return;

  const total = await db.aiCustomerMemory.count({ where: { workspaceId: meta.workspaceId, customerId } });
  let room = Math.max(0, MAX_MEMORY_PER_CUSTOMER - total);

  for (const it of items) {
    const kind = it.kind as MemoryKind;
    const value = it.value.trim().slice(0, 500);
    const status = it.confidence >= CONFIRM_CONFIDENCE ? "confirmed" : "candidate";

    // Dedup on (workspaceId, customerId, kind, value) — the DB unique. Never
    // resurrect a human-rejected item.
    const existing = await db.aiCustomerMemory.findUnique({
      where: { workspaceId_customerId_kind_value: { workspaceId: meta.workspaceId, customerId, kind, value } },
    });
    if (existing?.status === "rejected") continue;

    let saved: { id: string };
    if (existing) {
      saved = await db.aiCustomerMemory.update({
        where: { id: existing.id },
        data: {
          confidence: Math.max(existing.confidence, it.confidence),
          // Upgrade to confirmed when now confident; a superseded row that
          // recurs is reactivated to its current status.
          status: existing.status === "confirmed" ? "confirmed" : status,
          sourceConversationId: conversationId,
          sourceMessageId: latestMessageId ?? existing.sourceMessageId,
        },
        select: { id: true },
      });
    } else {
      if (room <= 0) continue;
      saved = await db.aiCustomerMemory.create({
        data: {
          workspaceId: meta.workspaceId,
          customerId,
          kind,
          value,
          confidence: it.confidence,
          status,
          source: "system",
          sourceConversationId: conversationId,
          sourceMessageId: latestMessageId ?? null,
        },
        select: { id: true },
      });
      room -= 1;
    }

    // Singleton kinds hold ONE active value per person: supersede the others
    // (e.g. preferred_language English -> French). Multi-valued kinds
    // (interest / recurring_need / preference) accumulate.
    if (SINGLETON_KINDS.has(kind)) {
      await db.aiCustomerMemory.updateMany({
        where: {
          workspaceId: meta.workspaceId,
          customerId,
          kind,
          id: { not: saved.id },
          status: { in: ["candidate", "confirmed"] },
        },
        data: { status: "superseded" },
      });
    }
  }

  void publish({
    type: "ai.memory_changed",
    workspaceId: meta.workspaceId,
    conversationId,
    customerId,
  }).catch(() => {});
}
