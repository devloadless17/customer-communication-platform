"use client";

import { useEffect, useState } from "react";

import { fetchWithSessionGuard } from "@/lib/auth/client-session-guard";
import { useCoalescedAsync } from "@/features/inbox/lib/coalesce";
import { getClientSocket } from "@/lib/socket-client";

/**
 * Team-wide preset + per-stage counts for the inbox sub-sidebar.
 *
 * Computed server-side over the entire team's conversations so the badges
 * stay accurate even when the agent has more matching threads than the
 * paginated inbox list currently holds. Refreshed on the socket events
 * that can change a bucket count:
 *
 *   - conversation:assigned   — flips mine ↔ unassigned (or vice versa)
 *   - conversation:status     — flips open/pending ↔ closed
 *   - conversation:deleted    — drops a row from every bucket
 *   - message:new (new conv)  — adds a row to all + unassigned
 *   - contact:updated         — stage edits change byStage; cheaper to
 *                                refetch than to inspect the payload
 *                                (the event fires for every field edit)
 *   - contacts:bulk_updated   — same, coalesced bulk version
 *
 * All triggers route through one coalesced refetch so a burst of events
 * fires a single GET. Initial value `null` lets the consumer fall back
 * to the loaded-slice count for first paint (visually correct, just
 * potentially short), and switches to truth as soon as the first
 * response lands.
 */
export interface ConversationCounts {
  all: number;
  mine: number;
  unassigned: number;
  closed: number;
  byStage: Record<string, number>;
}

export function useConversationCounts(): ConversationCounts | null {
  const [counts, setCounts] = useState<ConversationCounts | null>(null);

  const refresh = useCoalescedAsync(async () => {
    try {
      const res = await fetchWithSessionGuard(`/api/conversations/counts`);
      if (!res.ok) return;
      const body = (await res.json()) as ConversationCounts;
      setCounts(body);
    } catch {
      // Silent — next event re-triggers; a noisy retry loop here would
      // pile onto a real outage.
    }
  }, []);

  useEffect(() => {
    void refresh();
    const socket = getClientSocket();
    const trigger = () => {
      void refresh();
    };
    const onMessageNew: Parameters<typeof socket.on<"message:new">>[1] = (
      payload,
    ) => {
      // Only refetch when a brand-new conversation lands — otherwise the
      // bucket sizes don't change, and refetching on every inbound would
      // be wasteful on a busy team.
      if (payload.newConversation) void refresh();
    };

    // Optimistic stage-delta. Fired from `persistStageId` in
    // message-thread.tsx when a user changes a contact's stage. Without
    // this, the badge would lag behind the thread header by one server
    // round-trip (50-300ms) because the `contact:updated` listener only
    // triggers a refetch. Patching byStage in-place makes the badge flip
    // in the same frame as the rest of the UI; the refetch still fires
    // and reconciles when it lands.
    const onStageDelta = (e: Event) => {
      const detail = (e as CustomEvent<{
        contactId: string;
        prevStageId: string | null;
        nextStageId: string | null;
      }>).detail;
      if (!detail) return;
      setCounts((prev) => {
        if (!prev) return prev;
        const byStage = { ...prev.byStage };
        if (detail.prevStageId) {
          byStage[detail.prevStageId] = Math.max(
            0,
            (byStage[detail.prevStageId] ?? 0) - 1,
          );
        }
        if (detail.nextStageId) {
          byStage[detail.nextStageId] = (byStage[detail.nextStageId] ?? 0) + 1;
        }
        return { ...prev, byStage };
      });
    };

    socket.on("conversation:assigned", trigger);
    socket.on("conversation:status", trigger);
    socket.on("conversation:deleted", trigger);
    socket.on("contact:updated", trigger);
    socket.on("contacts:bulk_updated", trigger);
    socket.on("message:new", onMessageNew);
    if (typeof window !== "undefined") {
      window.addEventListener("ccp:contact-stage-delta", onStageDelta);
    }

    return () => {
      socket.off("conversation:assigned", trigger);
      socket.off("conversation:status", trigger);
      socket.off("conversation:deleted", trigger);
      socket.off("contact:updated", trigger);
      socket.off("contacts:bulk_updated", trigger);
      socket.off("message:new", onMessageNew);
      if (typeof window !== "undefined") {
        window.removeEventListener("ccp:contact-stage-delta", onStageDelta);
      }
    };
  }, [refresh]);

  return counts;
}
