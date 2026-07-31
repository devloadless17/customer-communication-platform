"use client";

import { useEffect, useMemo, useState } from "react";
import { Phone } from "lucide-react";

import { getClientSocket } from "@/lib/socket-client";
import { apiFetch } from "@/lib/api/client-fetch";
import { usePresence } from "@/hooks/use-presence";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { PresenceDot } from "@/components/presence-dot";
import { initials } from "@ccp/shared/utils";
import type { TeamLiveSnapshot } from "@ccp/shared/dtos";

/**
 * Live "right now" strip — who's online, how many open chats each agent
 * currently holds, and who is on a call. The successor of the old settings
 * CurrentActivityPanel, same convergence rule: seed from the server (RSC
 * prop), then debounce-refetch the authoritative snapshot on the socket
 * events that can change it. No client-side increment math — refetching is
 * simpler and can't drift. Optimistic frames (`payload.optimistic`) are
 * skipped: the server count hasn't committed yet, the non-optimistic echo
 * that follows triggers the real refetch.
 *
 * Presence/availability dots come from `usePresence` — the same source the
 * inbox sidebar reads, so the two surfaces can't disagree about a teammate.
 */
export interface NowStripMember {
  userId: string;
  name: string;
  avatarUrl: string | null;
  isActive: boolean;
}

export function TeamNowStrip({
  workspaceId,
  currentUserId,
  members,
  initial,
}: {
  workspaceId: string;
  currentUserId: string;
  members: NowStripMember[];
  initial: TeamLiveSnapshot;
}) {
  const [live, setLive] = useState<TeamLiveSnapshot>(initial);
  const { onlineUserIds, availabilityByUserId } = usePresence(workspaceId, currentUserId);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const refetch = async () => {
      try {
        const res = await apiFetch("/api/reports/team/live");
        if (!res.ok) return;
        const json = (await res.json()) as TeamLiveSnapshot;
        if (alive) setLive(json);
      } catch {
        // best-effort live strip — ignore transient failures
      }
    };

    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void refetch(), 400);
    };
    const onConversationChange = (payload?: { optimistic?: boolean }) => {
      if (payload?.optimistic) return; // pre-commit; wait for the server echo
      schedule();
    };
    // Call frames carry no optimistic variant — every one is a committed
    // server fact, so they schedule unconditionally.
    const onCallChange = () => schedule();

    const socket = getClientSocket();
    socket.on("conversation:assigned", onConversationChange);
    socket.on("conversation:status", onConversationChange);
    // Call attribution changes on answer (COALESCE flips to the answerer) and
    // on every ring/end — the snapshot is authoritative for all three.
    socket.on("call:ringing", onCallChange);
    socket.on("call:answered", onCallChange);
    socket.on("call:ended", onCallChange);
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      socket.off("conversation:assigned", onConversationChange);
      socket.off("conversation:status", onConversationChange);
      socket.off("call:ringing", onCallChange);
      socket.off("call:answered", onCallChange);
      socket.off("call:ended", onCallChange);
    };
  }, []);

  const liveByUser = useMemo(
    () => new Map(live.agents.map((a) => [a.userId, a])),
    [live],
  );

  // The strip is "who's working now" — deactivated members don't belong here
  // (they keep their rows in the ranged table below for history).
  const rows = members
    .filter((m) => m.isActive)
    .map((m) => ({
      ...m,
      online: onlineUserIds.has(m.userId),
      availability: availabilityByUserId[m.userId]?.status ?? null,
      openAssigned: liveByUser.get(m.userId)?.openAssigned ?? 0,
      activeCalls: liveByUser.get(m.userId)?.activeCalls ?? 0,
    }))
    .sort(
      (a, b) =>
        Number(b.online) - Number(a.online) ||
        b.openAssigned - a.openAssigned ||
        a.name.localeCompare(b.name),
    );

  const onlineCount = rows.filter((r) => r.online).length;
  const openTotal = rows.reduce((n, r) => n + r.openAssigned, 0);

  return (
    <section className="rounded-xl border border-border bg-card p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="relative flex size-2" aria-hidden>
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success-fg/60" />
          <span className="relative inline-flex size-2 rounded-full bg-success-fg" />
        </span>
        <h2 className="text-sm font-medium">Right now</h2>
        <span className="text-2xs text-muted-foreground">
          live · {onlineCount} online · {openTotal.toLocaleString()} open{" "}
          {openTotal === 1 ? "chat" : "chats"}
        </span>
      </div>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {rows.map((r) => (
          <div
            key={r.userId}
            className="flex items-center gap-2.5 rounded-lg border border-border/60 bg-muted/20 px-3 py-2"
          >
            <div className="relative shrink-0">
              <Avatar className="size-7">
                {r.avatarUrl ? <AvatarImage src={r.avatarUrl} alt={r.name} /> : null}
                <AvatarFallback seed={r.userId} className="text-3xs">
                  {initials(r.name)}
                </AvatarFallback>
              </Avatar>
              <PresenceDot
                online={r.online}
                availability={r.availability}
                className="absolute -bottom-0.5 -right-0.5"
              />
            </div>
            <span className="min-w-0 flex-1 truncate text-sm">{r.name}</span>
            {r.activeCalls > 0 && (
              <span
                className="inline-flex shrink-0 items-center gap-1 rounded-full bg-success-fg/10 px-1.5 py-0.5 text-2xs font-medium text-success-fg"
                title="On a call"
              >
                <Phone className="size-3" aria-hidden />
                <span className="sr-only">on a call</span>
              </span>
            )}
            <span
              className="shrink-0 tabular-nums text-sm font-semibold"
              aria-label={`${r.openAssigned} open ${r.openAssigned === 1 ? "chat" : "chats"}`}
            >
              {r.openAssigned}
            </span>
          </div>
        ))}
        {rows.length === 0 && (
          <div className="text-sm text-muted-foreground">No team members.</div>
        )}
      </div>
    </section>
  );
}
