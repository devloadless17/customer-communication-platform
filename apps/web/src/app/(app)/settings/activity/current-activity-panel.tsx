"use client";

import { useEffect, useState } from "react";

import { getClientSocket } from "@/lib/socket-client";
import { apiFetch } from "@/lib/api/client-fetch";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { initials } from "@ccp/shared/utils";

/**
 * Live "current activity" — open (non-closed) chats currently assigned to each
 * teammate, updating in real time.
 *
 * Same pattern as the rail's unread badge: seed from the server (passed in by
 * the page), then debounce-refetch the authoritative count on the socket events
 * that can change an assignment (`conversation:assigned` / `:status`). We don't
 * do client-side increment math — re-fetching is simpler and can't drift. We
 * skip the refetch on a client-only optimistic frame (`payload.optimistic`),
 * since the server count hasn't committed yet — the non-optimistic echo that
 * follows triggers the real refetch.
 */
export function CurrentActivityPanel({
  members,
  initial,
}: {
  members: { userId: string; name: string; avatarUrl?: string | null }[];
  initial: Record<string, number>;
}) {
  const [counts, setCounts] = useState<Record<string, number>>(initial);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const refetch = async () => {
      try {
        const res = await apiFetch("/api/users/active-assignments");
        if (!res.ok) return;
        const json = (await res.json()) as { counts?: Record<string, number> };
        if (alive && json.counts) setCounts(json.counts);
      } catch {
        // best-effort live panel — ignore transient failures
      }
    };

    const onChange = (payload?: { optimistic?: boolean }) => {
      if (payload?.optimistic) return; // pre-commit; wait for the server echo
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void refetch(), 400);
    };

    const socket = getClientSocket();
    socket.on("conversation:assigned", onChange);
    socket.on("conversation:status", onChange);
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      socket.off("conversation:assigned", onChange);
      socket.off("conversation:status", onChange);
    };
  }, []);

  const rows = members
    .map((m) => ({ ...m, count: counts[m.userId] ?? 0 }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  return (
    <section className="rounded-xl border border-border bg-card p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="relative flex size-2" aria-hidden>
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success-fg/60" />
          <span className="relative inline-flex size-2 rounded-full bg-success-fg" />
        </span>
        <h2 className="text-sm font-medium">Current activity</h2>
        <span className="text-2xs text-muted-foreground">
          live · open chats assigned right now
        </span>
      </div>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {rows.map((r) => (
          <div
            key={r.userId}
            className="flex items-center gap-2.5 rounded-lg border border-border/60 bg-muted/20 px-3 py-2"
          >
            <Avatar className="size-7 shrink-0">
              {r.avatarUrl ? <AvatarImage src={r.avatarUrl} alt={r.name} /> : null}
              <AvatarFallback seed={r.userId} className="text-3xs">
                {initials(r.name)}
              </AvatarFallback>
            </Avatar>
            <span className="min-w-0 flex-1 truncate text-sm">{r.name}</span>
            <span className="shrink-0 tabular-nums text-sm font-semibold">
              {r.count}
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
