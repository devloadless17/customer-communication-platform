"use client";

import { useEffect, useRef, useState } from "react";

import { fetchWithSessionGuard } from "@/lib/auth/client-session-guard";
import { useCoalescedAsync } from "@/features/inbox/lib/coalesce";
import { getClientSocket } from "@/lib/socket-client";

// How long after a stage change to suppress the GET /counts result so it
// can't roll back the optimistic byStage patch. Sized to comfortably cover
// the PATCH commit + server broadcast round-trip (~150-400ms typical in
// dev, faster in prod), plus headroom. After this window expires, a
// follow-up refresh fires once to pick up anything we deliberately dropped
// (e.g. a teammate's stage change for an unrelated contact that arrived
// while we were settling our own change).
const STAGE_SETTLING_MS = 1500;

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
 *   - contact:updated         — fired for EVERY field edit; we only
 *                                refetch when the contact's stageId
 *                                actually moved (tracked via lastStageRef).
 *                                A bulk field edit on 500 contacts now
 *                                fires zero GETs instead of 500.
 *   - contacts:bulk_updated   — only when changeKind is stage/mixed; tag &
 *                                field bulk ops don't move any bucket, so the
 *                                common 500-contact tag bulk fires no GET
 *
 * All triggers route through one coalesced refetch so a burst of events
 * fires a single GET. Initial value `null` lets the consumer fall back
 * to the loaded-slice count for first paint (visually correct, just
 * potentially short), and switches to truth as soon as the first
 * response lands.
 */
export interface ConversationCounts {
  active: number;
  all: number;
  mine: number;
  unassigned: number;
  closed: number;
  byStage: Record<string, number>;
}

export function useConversationCounts(): ConversationCounts | null {
  const [counts, setCounts] = useState<ConversationCounts | null>(null);

  // Stage-delta settling window. While `Date.now() < settlingUntil`, any
  // refresh that returns is DROPPED — the optimistic byStage patch from
  // `onStageDelta` is the source of truth during this window. Reason:
  // dispatchLocalSocketEvent("contact:updated") fires synchronously, which
  // schedules a refresh BEFORE the PATCH /api/contacts has even started.
  // The GET /counts that follows often beats the PATCH commit, returns
  // OLD counts, and would overwrite the optimistic patch → user sees the
  // badge briefly snap back to the pre-change value before flipping
  // forward again (= the flicker). Settling pins byStage to the optimistic
  // value until either the timer expires or the server's confirming
  // contact:updated arrives (whichever fires the trailing refresh first).
  const settlingUntilRef = useRef(0);
  // One trailing refresh, scheduled to fire WHEN settling expires, so any
  // updates we deliberately dropped during settling (teammate's unrelated
  // stage change that arrived mid-window) get reconciled. Cleared on
  // unmount so the timer doesn't leak.
  const settlingTimerRef = useRef<number | null>(null);
  // Last-seen stageId per contact. Lets us drop `contact:updated` frames
  // that don't actually move byStage (name edit, custom field edit, tag
  // change, …). Seeded on first sight; absent entry = unknown prior state
  // so we refresh defensively.
  const lastStageRef = useRef<Map<string, string | null>>(new Map());

  const refresh = useCoalescedAsync(async () => {
    try {
      const res = await fetchWithSessionGuard(`/api/conversations/counts`);
      if (!res.ok) return;
      const body = (await res.json()) as ConversationCounts;
      // Drop the result if we're still inside the settling window — the
      // server may not have committed the optimistic stage change yet, and
      // applying these stale counts would yank byStage back to the old
      // value just long enough for the user to see it. The trailing
      // refresh scheduled in `onStageDelta` will run after settling
      // expires and write the real numbers.
      if (Date.now() < settlingUntilRef.current) return;
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
    // Optimistic frames for status/assigned fire BEFORE their POST commits.
    // Refetching counts then can return PRE-change numbers, briefly snap the
    // badge back to the old value, and flicker. Skip the GET on those frames
    // — the authoritative server frame (optimistic absent) fires the same
    // listener moments later and drives convergence. Mirrors the gate
    // `useTeamEvents` uses for the inbox list resync.
    const triggerSkipOptimistic = (payload: { optimistic?: boolean }) => {
      if (payload?.optimistic) return;
      void refresh();
    };
    // `contact:updated` carries the full contact row. Only a stageId change
    // moves any byStage bucket — name / email / custom fields / tags don't.
    // We track the last-seen stageId per contact and skip the refresh when
    // it hasn't moved. The first sighting of a contact has no prior to
    // compare against, so we refresh defensively then.
    const onContactUpdated: Parameters<
      typeof socket.on<"contact:updated">
    >[1] = (payload) => {
      const contact = payload.contact;
      if (!contact?.id) return;
      const nextStage = contact.stageId ?? null;
      const map = lastStageRef.current;
      const known = map.has(contact.id);
      const prevStage = known ? map.get(contact.id) ?? null : null;
      // FIFO cap: this Map gains one entry per distinct contact touched for the
      // life of the tab. Bounded by the team's contact count, but on a busy,
      // long-lived inbox it's grow-only. Evict the oldest insertion once over
      // the cap — a re-seen contact just re-refreshes defensively (the absent
      // entry is treated as "unknown prior", which is correct).
      const MAX_TRACKED = 5_000;
      if (!known && map.size >= MAX_TRACKED) {
        const oldest = map.keys().next().value;
        if (oldest !== undefined) map.delete(oldest);
      }
      map.set(contact.id, nextStage);
      if (known && prevStage === nextStage) return;
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

    // Bulk contact mutation. Only stage (and the mixed bucket that may
    // include a stage move) changes byStage; tag-only and field-only bulk
    // ops touch no count bucket, so the common 500-contact tag bulk should
    // fire zero GETs instead of one coalesced no-op refetch.
    const onBulkUpdated: Parameters<typeof socket.on<"contacts:bulk_updated">>[1] = (
      payload,
    ) => {
      if (payload.changeKind === "stage" || payload.changeKind === "mixed") {
        void refresh();
      }
    };

    // Optimistic stage-delta. Fired from `persistStageId` in
    // message-thread.tsx when a user changes a contact's stage. Without
    // this, the badge would lag behind the thread header by one server
    // round-trip (50-300ms) because the `contact:updated` listener only
    // triggers a refetch. Patching byStage in-place makes the badge flip
    // in the same frame as the rest of the UI; the refetch is forced to
    // wait out the settling window (see refreshes above) so it can't
    // briefly overwrite the optimistic value with stale server counts.
    const onStageDelta = (e: Event) => {
      const detail = (e as CustomEvent<{
        contactId: string;
        prevStageId: string | null;
        nextStageId: string | null;
      }>).detail;
      if (!detail) return;
      settlingUntilRef.current = Date.now() + STAGE_SETTLING_MS;
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
      // Single trailing refresh after settling expires. Catches anything
      // we dropped during the window (most importantly: a teammate's
      // stage change for a DIFFERENT contact that arrived while we were
      // settling our own change — server contact:updated fired, refresh
      // ran, result was dropped, and without this catch-up the badge
      // would never see it until the next unrelated event came along).
      if (settlingTimerRef.current !== null) {
        window.clearTimeout(settlingTimerRef.current);
      }
      settlingTimerRef.current = window.setTimeout(() => {
        settlingTimerRef.current = null;
        void refresh();
      }, STAGE_SETTLING_MS + 50);
    };

    socket.on("conversation:assigned", triggerSkipOptimistic);
    socket.on("conversation:status", triggerSkipOptimistic);
    socket.on("conversation:deleted", trigger);
    socket.on("contact:updated", onContactUpdated);
    socket.on("contacts:bulk_updated", onBulkUpdated);
    socket.on("message:new", onMessageNew);
    if (typeof window !== "undefined") {
      window.addEventListener("ccp:contact-stage-delta", onStageDelta);
    }

    return () => {
      socket.off("conversation:assigned", triggerSkipOptimistic);
      socket.off("conversation:status", triggerSkipOptimistic);
      socket.off("conversation:deleted", trigger);
      socket.off("contact:updated", onContactUpdated);
      socket.off("contacts:bulk_updated", onBulkUpdated);
      socket.off("message:new", onMessageNew);
      if (typeof window !== "undefined") {
        window.removeEventListener("ccp:contact-stage-delta", onStageDelta);
      }
      if (settlingTimerRef.current !== null) {
        window.clearTimeout(settlingTimerRef.current);
        settlingTimerRef.current = null;
      }
    };
  }, [refresh]);

  return counts;
}
