"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { useSocketReconnect } from "@/hooks/use-socket-reconnect";
import { apiFetch } from "@/lib/api/client-fetch";
import { getClientSocket } from "@/lib/socket-client";

/**
 * ONE `/overview` fetch per open conversation, shared by every AI surface in
 * the thread: the contact-panel sections and the per-bubble hallucination
 * badge (which is why this exists).
 *
 * The badge used to GET `/api/ai-assistant/messages/:id/hallucination` on
 * mount, once per OUTBOUND bubble — ~30 requests on thread open, hundreds
 * after paging, two DB queries each, straight into the 300/min rate limit.
 * The conversation-level rollup already carries every flagged message
 * (`lib/ai/hallucination.ts`), so the flags now ride the same response the
 * panel hydrates from and a bubble costs nothing. Bound, deliberately: the
 * rollup scans the last 300 outbound messages and lists at most 25 flags,
 * newest first — a badge on an older flagged bubble is traded for not
 * fanning out a request per bubble.
 *
 * `state === "disabled"` means the WORKSPACE never enabled the assistant. The
 * server emits it precisely so the web hides the AI chrome (see `overview()`
 * in `ai-inbox.service.ts`), so consumers render NOTHING rather than offering
 * controls that would drive LLM calls.
 */

export type AiConversationState = "ai_active" | "human_active" | "ai_paused" | "disabled";

export interface AiMemoryItem {
  id: string;
  kind: string;
  value: string;
  confidence: number;
  status: "candidate" | "confirmed" | "rejected";
}

export interface AiSessionSummary {
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

export interface AiFlaggedMessage {
  messageId: string;
  risk: number;
  notes: string | null;
}

export interface AiHallucinationSummary {
  ratePercent: number | null;
  scoredCount: number;
  flagged: AiFlaggedMessage[];
}

export interface AiOverview {
  state: AiConversationState;
  memory: AiMemoryItem[];
  summary: AiSessionSummary | null;
  hallucination: AiHallucinationSummary | null;
}

interface AiOverviewContextValue {
  /** Null until the first fetch resolves (and on a fetch that failed). */
  overview: AiOverview | null;
  /** Loaded AND the workspace has the assistant on — the gate for AI chrome. */
  enabled: boolean;
  /** Hallucination flag for one message, from the conversation rollup. */
  flagFor: (messageId: string) => AiFlaggedMessage | null;
  reload: () => void;
}

const AiOverviewContext = createContext<AiOverviewContextValue | null>(null);

export function AiOverviewProvider({
  conversationId,
  children,
}: {
  conversationId: string;
  children: ReactNode;
}) {
  const [overview, setOverview] = useState<AiOverview | null>(null);
  // Flags that arrived on `ai:flag` after the rollup was read (an AI reply the
  // assistant just sent). Merged OVER the rollup so the badge paints without
  // waiting for the refetch; never replaces it.
  const [liveFlags, setLiveFlags] = useState<AiFlaggedMessage[]>([]);

  const load = useCallback(async () => {
    const res = await apiFetch(`/api/ai-assistant/conversations/${conversationId}/overview`);
    if (!res.ok) return;
    setOverview((await res.json()) as AiOverview);
  }, [conversationId]);

  useEffect(() => {
    setOverview(null);
    setLiveFlags([]);
    void load();
  }, [load]);

  // §10 convergence: memory / summary / flag frames are sparse, so one missed
  // during a drop past the socket recovery window leaves a superseded brief on
  // screen for as long as the thread stays open. One refetch for the whole
  // thread — the per-bubble badge could never afford this.
  useSocketReconnect(load);

  // Realtime: the system updated this conversation's summary or the customer's
  // memory, or flagged a newly-sent AI reply
  // (ai.summary_changed / ai.memory_changed / ai.message_flagged).
  useEffect(() => {
    const socket = getClientSocket();
    const onChanged = (p: { conversationId: string }) => {
      if (p.conversationId === conversationId) void load();
    };
    const onFlag = (p: {
      conversationId: string;
      messageId: string;
      risk: number;
      notes: string | null;
    }) => {
      if (p.conversationId !== conversationId) return;
      setLiveFlags((prev) =>
        prev.some((f) => f.messageId === p.messageId)
          ? prev
          : [...prev, { messageId: p.messageId, risk: p.risk, notes: p.notes }],
      );
      void load();
    };
    socket.on("ai:summary", onChanged);
    socket.on("ai:memory", onChanged);
    socket.on("ai:flag", onFlag);
    return () => {
      socket.off("ai:summary", onChanged);
      socket.off("ai:memory", onChanged);
      socket.off("ai:flag", onFlag);
    };
  }, [conversationId, load]);

  const flags = useMemo(() => {
    const map = new Map<string, AiFlaggedMessage>();
    for (const f of overview?.hallucination?.flagged ?? []) map.set(f.messageId, f);
    for (const f of liveFlags) map.set(f.messageId, f);
    return map;
  }, [overview, liveFlags]);

  const flagFor = useCallback((messageId: string) => flags.get(messageId) ?? null, [flags]);
  const reload = useCallback(() => {
    void load();
  }, [load]);

  const value = useMemo<AiOverviewContextValue>(
    () => ({
      overview,
      enabled: !!overview && overview.state !== "disabled",
      flagFor,
      reload,
    }),
    [overview, flagFor, reload],
  );

  return <AiOverviewContext.Provider value={value}>{children}</AiOverviewContext.Provider>;
}

/**
 * Read the thread's AI overview. Returns null outside the provider so callers
 * render nothing rather than crash — the bubble is also used in surfaces that
 * don't mount the inbox providers (mirrors `useMessageFlags`).
 */
export function useAiOverview(): AiOverviewContextValue | null {
  return useContext(AiOverviewContext);
}
