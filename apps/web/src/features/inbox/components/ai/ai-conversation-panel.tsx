"use client";

import { useCallback, useEffect, useState } from "react";

import { apiFetch } from "@/lib/api/client-fetch";
import { getClientSocket } from "@/lib/socket-client";

import { Section } from "../contact-panel/section";

/**
 * Two contact-panel sections, in this order (placement map):
 *   AI Customer Understanding  — PERSON-level memory (durable), curated by agents.
 *   Latest Session Summary     — SESSION-level rollup (current open session).
 * They are deliberately distinct surfaces (correction #7 — never merged).
 * Data comes from one /overview fetch; persisted server-side so it survives
 * refresh/reconnect.
 */

interface MemoryItem {
  id: string;
  kind: string;
  value: string;
  confidence: number;
  status: "candidate" | "confirmed" | "rejected";
}
interface SessionSummary {
  customerGoal: string | null;
  importantContext: string | null;
  questions: string[];
  answers: string[];
  commitments: string[];
  openQuestions: string[];
  requiredFollowUp: string | null;
  sentiment: string | null;
  language: string | null;
  tone: string | null;
  latestStatus: string | null;
  updatedAt: string;
}
interface Overview {
  memory: MemoryItem[];
  summary: SessionSummary | null;
}

const KIND_LABEL: Record<string, string> = {
  preferred_language: "Preferred language",
  dialect: "Dialect",
  script: "Script",
  tone: "Tone",
  communication_style: "Communication style",
  interest: "Interest",
  recurring_need: "Recurring need",
  preference: "Preference",
};

export function AiConversationPanel({ conversationId }: { conversationId: string }) {
  const [data, setData] = useState<Overview | null>(null);

  const load = useCallback(async () => {
    const res = await apiFetch(`/api/ai-assistant/conversations/${conversationId}/overview`);
    if (!res.ok) return;
    setData((await res.json()) as Overview);
  }, [conversationId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Realtime: refetch when the system updates this conversation's summary or the
  // customer's memory (ai.summary_changed / ai.memory_changed domain events).
  useEffect(() => {
    const socket = getClientSocket();
    const onSummary = (p: { teamId: string; conversationId: string }) => {
      if (p.conversationId === conversationId) void load();
    };
    const onMemory = (p: { teamId: string; conversationId: string; customerId: string }) => {
      if (p.conversationId === conversationId) void load();
    };
    socket.on("ai:summary", onSummary);
    socket.on("ai:memory", onMemory);
    return () => {
      socket.off("ai:summary", onSummary);
      socket.off("ai:memory", onMemory);
    };
  }, [conversationId, load]);

  const memory = (data?.memory ?? []).filter((m) => m.status !== "rejected");
  const summary = data?.summary ?? null;

  async function confirm(id: string) {
    await apiFetch(`/api/ai-assistant/memory/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "confirmed" }),
    });
    void load();
  }
  async function remove(id: string) {
    await apiFetch(`/api/ai-assistant/memory/${id}`, { method: "DELETE" });
    void load();
  }

  return (
    <>
      <Section title="AI Customer Understanding">
        {memory.length === 0 ? (
          <p className="text-xs text-muted-foreground">Nothing learned yet.</p>
        ) : (
          <ul className="space-y-1.5">
            {memory.map((m) => (
              <li key={m.id} className="flex items-start gap-2 text-sm">
                <span className="mt-0.5 min-w-28 text-xs text-muted-foreground">
                  {KIND_LABEL[m.kind] ?? m.kind}
                </span>
                <span className="flex-1">{m.value}</span>
                {m.status === "candidate" && (
                  <button
                    className="text-xs text-green-600 hover:underline"
                    onClick={() => void confirm(m.id)}
                    title="Confirm"
                  >
                    ✓
                  </button>
                )}
                <button
                  className="text-xs text-muted-foreground hover:text-red-600"
                  onClick={() => void remove(m.id)}
                  title="Remove"
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Latest Session Summary">
        {!summary ? (
          <p className="text-xs text-muted-foreground">No summary yet.</p>
        ) : (
          <div className="space-y-2 text-sm">
            <SummaryLine label="Goal" value={summary.customerGoal} />
            <SummaryLine label="Context" value={summary.importantContext} />
            <SummaryList label="Open questions" items={summary.openQuestions} />
            <SummaryList label="Company commitments" items={summary.commitments} />
            <SummaryLine label="Required follow-up" value={summary.requiredFollowUp} />
            <SummaryLine label="Latest status" value={summary.latestStatus} />
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
              {summary.sentiment && <span>Sentiment: {summary.sentiment}</span>}
              {summary.language && <span>Language: {summary.language}</span>}
              {summary.tone && <span>Tone: {summary.tone}</span>}
            </div>
          </div>
        )}
      </Section>
    </>
  );
}

function SummaryLine({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <div>
      <span className="text-xs font-medium text-muted-foreground">{label}: </span>
      <span>{value}</span>
    </div>
  );
}
function SummaryList({ label, items }: { label: string; items: string[] }) {
  if (!items || items.length === 0) return null;
  return (
    <div>
      <span className="text-xs font-medium text-muted-foreground">{label}:</span>
      <ul className="ml-4 list-disc">
        {items.map((it, i) => (
          <li key={i}>{it}</li>
        ))}
      </ul>
    </div>
  );
}
