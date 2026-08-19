"use client";

import { useCallback, useEffect, useState } from "react";
import { TriangleAlert } from "lucide-react";

import { apiFetch } from "@/lib/api/client-fetch";
import { getClientSocket } from "@/lib/socket-client";

/**
 * "Worth a second look" flag on an outbound bubble — mirrors AiTranscript's
 * pattern (fetch by messageId, render nothing until there's something to
 * show). Only ever non-null for an AI-authored reply scored at/above
 * HALLUCINATION_FLAG_THRESHOLD server-side (lib/ai/hallucination.ts); a
 * human-sent message always renders nothing.
 *
 * Deliberately NOT wired to `useSocketReconnect` (§10 convergence), unlike the
 * other AI panels: this mounts once per OUTBOUND bubble and the thread isn't
 * virtualized, so a reconnect would fire one GET per rendered outbound message
 * — hundreds in a scrolled-back thread, straight into the 300/min rate limit.
 * It converges without one: the flag is written synchronously at send time, so
 * any bubble mounting after the message exists reads the true value, and a
 * message that arrives during the gap mounts a fresh badge that fetches. The
 * per-conversation rollup (AiConversationPanel's "AI Reliability") does
 * refetch on reconnect and lists every flagged message in the chat.
 */
interface Flag {
  risk: number;
  notes: string | null;
}

export function AiHallucinationBadge({ messageId }: { messageId: string }) {
  const [flag, setFlag] = useState<Flag | null>(null);

  const load = useCallback(async () => {
    const res = await apiFetch(`/api/ai-assistant/messages/${messageId}/hallucination`);
    if (!res.ok) return;
    const data = (await res.json()) as { flag: Flag | null };
    setFlag(data.flag);
  }, [messageId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Realtime: the flag is written synchronously at send time, but the bubble
  // can mount before that write is visible (optimistic send → reconcile) —
  // ai:flag fills the gap without a poll.
  useEffect(() => {
    const socket = getClientSocket();
    const onFlag = (p: { messageId: string; risk: number; notes: string | null }) => {
      if (p.messageId === messageId) setFlag({ risk: p.risk, notes: p.notes });
    };
    socket.on("ai:flag", onFlag);
    return () => {
      socket.off("ai:flag", onFlag);
    };
  }, [messageId]);

  if (!flag) return null;

  return (
    <span
      title={
        flag.notes
          ? `Possibly unverified: ${flag.notes}`
          : "This AI reply may contain an unverified claim — worth a second look"
      }
      className="inline-flex shrink-0 items-center text-amber-600 dark:text-amber-400"
    >
      <TriangleAlert className="size-3" aria-label="AI reply flagged for review" />
    </span>
  );
}
