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
  overallBrief: string | null;
  updatedAt: string;
}
interface HallucinationSummary {
  ratePercent: number | null;
  scoredCount: number;
  flagged: Array<{ messageId: string; risk: number; notes: string | null }>;
}
interface Overview {
  memory: MemoryItem[];
  summary: SessionSummary | null;
  hallucination: HallucinationSummary | null;
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

// Multi-valued, accumulating memory kinds shown as tag chips (the rest are
// single-value attributes shown as labeled rows). Interests etc. are durable +
// person-level, so they seed future chats' prompts.
const TAG_KINDS = new Set(["interest", "recurring_need", "preference"]);

export function AiConversationPanel({ conversationId }: { conversationId: string }) {
  const [data, setData] = useState<Overview | null>(null);
  // Date-range summary: separate, on-demand, spans the WHOLE conversation —
  // not part of /overview. `from`/`to` are the (initially empty)
  // <input type="date"> values; `range` is the last FETCHED result, kept
  // distinct from the inputs so editing the dates doesn't blank out the
  // previous result until the agent explicitly re-fetches.
  const [rangeFrom, setRangeFrom] = useState("");
  const [rangeTo, setRangeTo] = useState("");
  const [rangeLoading, setRangeLoading] = useState(false);
  const [rangeError, setRangeError] = useState<string | null>(null);
  const [range, setRange] = useState<SessionSummary | null | undefined>(undefined); // undefined = never fetched

  const load = useCallback(async () => {
    const res = await apiFetch(`/api/ai-assistant/conversations/${conversationId}/overview`);
    if (!res.ok) return;
    setData((await res.json()) as Overview);
  }, [conversationId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Realtime: refetch when the system updates this conversation's summary, the
  // customer's memory, or flags a newly-sent AI reply as a hallucination risk
  // (ai.summary_changed / ai.memory_changed / ai.message_flagged).
  useEffect(() => {
    const socket = getClientSocket();
    const onSummary = (p: { workspaceId: string; conversationId: string }) => {
      if (p.conversationId === conversationId) void load();
    };
    const onMemory = (p: { workspaceId: string; conversationId: string; customerId: string }) => {
      if (p.conversationId === conversationId) void load();
    };
    const onFlag = (p: { workspaceId: string; conversationId: string }) => {
      if (p.conversationId === conversationId) void load();
    };
    socket.on("ai:summary", onSummary);
    socket.on("ai:memory", onMemory);
    socket.on("ai:flag", onFlag);
    return () => {
      socket.off("ai:summary", onSummary);
      socket.off("ai:memory", onMemory);
      socket.off("ai:flag", onFlag);
    };
  }, [conversationId, load]);

  const memory = (data?.memory ?? []).filter((m) => m.status !== "rejected");
  const attributes = memory.filter((m) => !TAG_KINDS.has(m.kind));
  // Only the most recent, SURE (confirmed) interests — capped so the panel stays
  // scannable. The overview returns memory most-recently-updated first.
  const tagItems = memory
    .filter((m) => TAG_KINDS.has(m.kind) && m.status === "confirmed")
    .slice(0, 6);
  const summary = data?.summary ?? null;
  const hallucination = data?.hallucination ?? null;

  async function fetchRangeSummary() {
    if (!rangeFrom || !rangeTo) return;
    setRangeLoading(true);
    setRangeError(null);
    try {
      // <input type="date"> gives a bare "YYYY-MM-DD"; widen to a full-day
      // window in the agent's local time so "to" includes that whole day.
      const from = new Date(`${rangeFrom}T00:00:00`).toISOString();
      const to = new Date(`${rangeTo}T23:59:59.999`).toISOString();
      const qs = new URLSearchParams({ from, to }).toString();
      const res = await apiFetch(`/api/ai-assistant/conversations/${conversationId}/summary?${qs}`);
      if (!res.ok) {
        setRangeError("Couldn't load a summary for that range.");
        return;
      }
      const json = (await res.json()) as { summary: Partial<SessionSummary> | null };
      setRange(
        json.summary
          ? {
              customerGoal: json.summary.customerGoal ?? null,
              importantContext: json.summary.importantContext ?? null,
              questions: json.summary.questions ?? [],
              answers: json.summary.answers ?? [],
              commitments: json.summary.commitments ?? [],
              openQuestions: json.summary.openQuestions ?? [],
              requiredFollowUp: json.summary.requiredFollowUp ?? null,
              sentiment: json.summary.sentiment ?? null,
              language: json.summary.language ?? null,
              tone: json.summary.tone ?? null,
              latestStatus: json.summary.latestStatus ?? null,
              overallBrief: json.summary.overallBrief ?? null,
              updatedAt: "",
            }
          : null,
      );
    } catch {
      setRangeError("Couldn't reach the summary service.");
    } finally {
      setRangeLoading(false);
    }
  }

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
          <div className="space-y-3">
            {attributes.length > 0 && (
              <ul className="space-y-1.5">
                {attributes.map((m) => (
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
            {tagItems.length > 0 && (
              <div>
                <p className="mb-1.5 text-xs font-medium text-muted-foreground">Interests</p>
                <div className="flex flex-wrap gap-1.5">
                  {tagItems.map((m) => (
                    <span
                      key={m.id}
                      title={m.status === "candidate" ? "AI-suggested — confirm to keep" : KIND_LABEL[m.kind] ?? m.kind}
                      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs ${
                        m.status === "candidate"
                          ? "border-dashed border-border text-muted-foreground"
                          : "border-primary/30 bg-primary/10 text-primary"
                      }`}
                    >
                      {m.value}
                      {m.status === "candidate" && (
                        <button className="hover:text-green-600" onClick={() => void confirm(m.id)} title="Confirm">
                          ✓
                        </button>
                      )}
                      <button className="hover:text-red-600" onClick={() => void remove(m.id)} title="Remove">
                        ✕
                      </button>
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </Section>

      <Section title="Latest Session Summary">
        {!summary ? (
          <p className="text-xs text-muted-foreground">No summary yet.</p>
        ) : (
          <div className="space-y-2 text-sm">
            {summary.overallBrief && (
              <p className="rounded-md bg-muted/50 px-2 py-1.5 text-xs">
                <span className="font-medium text-muted-foreground">Overall: </span>
                <span className="text-foreground">{summary.overallBrief}</span>
              </p>
            )}
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

      <Section title="Summary for a date range">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <input
              type="date"
              value={rangeFrom}
              onChange={(e) => setRangeFrom(e.target.value)}
              className="rounded border border-border bg-background px-1.5 py-1 text-xs"
              aria-label="From date"
            />
            <span className="text-xs text-muted-foreground">to</span>
            <input
              type="date"
              value={rangeTo}
              onChange={(e) => setRangeTo(e.target.value)}
              className="rounded border border-border bg-background px-1.5 py-1 text-xs"
              aria-label="To date"
            />
            <button
              onClick={() => void fetchRangeSummary()}
              disabled={!rangeFrom || !rangeTo || rangeLoading}
              className="rounded bg-primary px-2 py-1 text-xs font-medium text-primary-foreground disabled:opacity-50"
            >
              {rangeLoading ? "Loading…" : "View summary"}
            </button>
          </div>
          {rangeError && <p className="text-xs text-destructive">{rangeError}</p>}
          {range === null && !rangeError && (
            <p className="text-xs text-muted-foreground">No messages in that range.</p>
          )}
          {range && (
            <div className="space-y-2 text-sm">
              {range.overallBrief && (
                <p className="rounded-md bg-muted/50 px-2 py-1.5 text-xs">
                  <span className="font-medium text-muted-foreground">Overall: </span>
                  <span className="text-foreground">{range.overallBrief}</span>
                </p>
              )}
              <SummaryLine label="Goal" value={range.customerGoal} />
              <SummaryLine label="Context" value={range.importantContext} />
              <SummaryList label="Open questions" items={range.openQuestions} />
              <SummaryList label="Company commitments" items={range.commitments} />
              <SummaryLine label="Required follow-up" value={range.requiredFollowUp} />
              <SummaryLine label="Latest status" value={range.latestStatus} />
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                {range.sentiment && <span>Sentiment: {range.sentiment}</span>}
                {range.language && <span>Language: {range.language}</span>}
                {range.tone && <span>Tone: {range.tone}</span>}
              </div>
            </div>
          )}
        </div>
      </Section>

      {hallucination && hallucination.scoredCount > 0 && (
        <Section title="AI Reliability">
          <div className="space-y-1.5 text-sm">
            <p>
              <span className="font-medium">{hallucination.ratePercent}%</span>{" "}
              <span className="text-xs text-muted-foreground">
                average hallucination risk across {hallucination.scoredCount} AI-generated
                {hallucination.scoredCount === 1 ? " reply" : " replies"} in this chat.
              </span>
            </p>
            {hallucination.flagged.length > 0 && (
              <div>
                <p className="mb-1 text-xs font-medium text-muted-foreground">
                  Flagged for review ({hallucination.flagged.length}):
                </p>
                <ul className="space-y-1">
                  {hallucination.flagged.map((f) => (
                    <li key={f.messageId} className="text-xs text-muted-foreground">
                      <span className="font-medium text-foreground">{Math.round(f.risk * 100)}%</span>
                      {f.notes ? ` — ${f.notes}` : " — unverified claim, check the message"}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </Section>
      )}
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
