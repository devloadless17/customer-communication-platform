"use client";

import { useEffect, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import {
  AlertTriangle,
  CircleDot,
  Inbox,
  PauseCircle,
  Settings2,
  User2,
  UserX,
} from "lucide-react";

import {
  SubSidebar,
  SubSidebarItem,
  SubSidebarSection,
} from "@/components/layouts/sub-sidebar";
import { apiFetch } from "@/lib/api/client-fetch";
import { getClientSocket } from "@/lib/socket-client";
import type { TicketCounts, TicketStatus } from "@ccp/shared/tickets/types";

/**
 * Ticket views.
 *
 * Views are URL state (`/tickets?view=mine`, `?status=pending`), not local
 * component state, so a view is linkable, survives a refresh, and the browser's
 * back button steps through them. That is also what lets this sidebar be plain
 * links instead of a second copy of the board's filter logic.
 *
 * Counts are live: `ticket:changed` is workspace-wide, so a teammate solving
 * something updates everyone's badges. Refetches are coalesced — one person
 * clearing a backlog fires a burst of frames and each would otherwise cost a
 * groupBy over every ticket in the workspace.
 */

const STATUS_VIEWS: Array<{ status: TicketStatus; label: string; icon: typeof CircleDot }> = [
  { status: "new", label: "New", icon: CircleDot },
  { status: "open", label: "Open", icon: Inbox },
  { status: "pending", label: "Waiting on customer", icon: PauseCircle },
  { status: "on_hold", label: "On hold", icon: PauseCircle },
  { status: "solved", label: "Solved", icon: CircleDot },
  { status: "closed", label: "Closed", icon: CircleDot },
];

export function TicketsSubSidebar() {
  const pathname = usePathname();
  const params = useSearchParams();
  const [counts, setCounts] = useState<TicketCounts | null>(null);

  // Only light a view on the board itself — a ticket detail page shouldn't
  // leave a filter looking selected.
  const onBoard = pathname === "/tickets";
  const isView = (v: string | null, s: string | null) =>
    onBoard && (params.get("view") ?? null) === v && (params.get("status") ?? null) === s;

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = async () => {
      try {
        const res = await apiFetch("/api/tickets/counts");
        if (!res.ok) return;
        const body = (await res.json()) as { counts: TicketCounts };
        if (alive) setCounts(body.counts);
      } catch {
        // Best-effort chrome — a failed fetch just leaves the last badges.
      }
    };
    void load();
    const socket = getClientSocket();
    const onChange = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void load();
      }, 400);
    };
    socket.on("ticket:changed", onChange);
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      socket.off("ticket:changed", onChange);
    };
  }, []);

  const badge = (n: number | undefined) =>
    n && n > 0 ? (
      <span className="ml-auto shrink-0 tabular-nums text-2xs text-muted-foreground">{n}</span>
    ) : undefined;

  return (
    <SubSidebar title="Tickets">
      <SubSidebarSection>
        <SubSidebarItem
          href="/tickets"
          label="All open"
          leading={<Inbox className="size-4" />}
          active={isView(null, null)}
          trailing={badge(counts?.totalActive)}
        />
        <SubSidebarItem
          href="/tickets?view=mine"
          label="Assigned to me"
          leading={<User2 className="size-4" />}
          active={isView("mine", null)}
          trailing={badge(counts?.mineActive)}
        />
        <SubSidebarItem
          href="/tickets?view=unassigned"
          label="Unassigned"
          leading={<UserX className="size-4" />}
          active={isView("unassigned", null)}
        />
        <SubSidebarItem
          href="/tickets?view=breached"
          label="Past due"
          leading={<AlertTriangle className="size-4" />}
          active={isView("breached", null)}
          trailing={
            counts?.breached ? (
              // Red, not muted: a missed promise is the one badge that should
              // pull the eye.
              <span className="ml-auto shrink-0 tabular-nums text-2xs font-medium text-destructive">
                {counts.breached}
              </span>
            ) : undefined
          }
        />
      </SubSidebarSection>

      <SubSidebarSection label="Status">
        {STATUS_VIEWS.map(({ status: s, label, icon: Icon }) => (
          <SubSidebarItem
            key={s}
            href={`/tickets?status=${s}`}
            label={label}
            leading={<Icon className="size-4" />}
            active={isView(null, s)}
            trailing={badge(counts?.byStatus?.[s])}
          />
        ))}
      </SubSidebarSection>

      <SubSidebarSection label="Configure">
        <SubSidebarItem
          href="/settings/tickets"
          label="Ticket settings"
          leading={<Settings2 className="size-4" />}
          active={false}
        />
      </SubSidebarSection>
    </SubSidebar>
  );
}
