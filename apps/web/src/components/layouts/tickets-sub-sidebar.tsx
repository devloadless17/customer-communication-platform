"use client";

import { useEffect, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import {
  AlertTriangle,
  CircleDot,
  Inbox,
  MessagesSquare,
  PauseCircle,
  Filter,
  Settings2,
  User2,
  Users,
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

export function TicketsSubSidebar({
  isAdmin,
  viewerUserId,
}: {
  isAdmin: boolean;
  /** Whose "Replied to you" this is — a reply for anyone else must not
   *  re-run these counts on every open tab. */
  viewerUserId: string;
}) {
  const pathname = usePathname();
  const params = useSearchParams();
  const [counts, setCounts] = useState<TicketCounts | null>(null);
  const [views, setViews] = useState<Array<{ id: string; name: string }>>([]);

  // Only light a view on the board itself — a ticket detail page shouldn't
  // leave a filter looking selected.
  const onBoard = pathname === "/tickets";
  const viewIdParam = onBoard ? params.get("viewId") : null;
  // A saved view being active means no built-in is: they are alternative
  // scopings of the same board, and lighting both reads as "two filters".
  const isView = (v: string | null, s: string | null) =>
    onBoard &&
    !viewIdParam &&
    (params.get("view") ?? null) === v &&
    (params.get("status") ?? null) === s;

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
    // Saved views change when someone SAVES one, not per ticket — loaded once
    // and refreshed by navigation rather than on every `ticket:changed`.
    void (async () => {
      try {
        const res = await apiFetch("/api/tickets/views");
        if (!res.ok) return;
        const body = (await res.json()) as { views: Array<{ id: string; name: string }> };
        if (alive) setViews(body.views ?? []);
      } catch {
        // Best-effort chrome.
      }
    })();
    const socket = getClientSocket();
    const onChange = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void load();
      }, 400);
    };
    // A thread reply moves no ticket state, so it never fires `ticket:changed`
    // — without this the "Replied to you" count would only refresh on the next
    // unrelated write. Gated on `notifiedUserIds` because that count is MINE:
    // ungated, every open tab in both workspaces re-ran the counts query on the
    // highest-frequency write a ticket has.
    const onReply = (p: { notifiedUserIds?: string[] }) => {
      if (!p.notifiedUserIds?.includes(viewerUserId)) return;
      onChange();
    };
    socket.on("ticket:changed", onChange);
    socket.on("ticket:thread:message", onReply);
    // Already per-viewer — this user clearing their own marker.
    socket.on("ticket:thread:read", onChange);
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      socket.off("ticket:changed", onChange);
      socket.off("ticket:thread:message", onReply);
      socket.off("ticket:thread:read", onChange);
    };
  }, [viewerUserId]);

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
        {/* Someone answered YOU. Per-user (unlike every other count here), and
            rendered only when there is something waiting — an always-on zero is
            chrome nobody reads. */}
        {counts?.unreadReplies ? (
          <SubSidebarItem
            href="/tickets?view=unread"
            label="Replied to you"
            leading={<MessagesSquare className="size-4" />}
            active={isView("unread", null)}
            trailing={badge(counts.unreadReplies)}
          />
        ) : null}
        {/* Work another department asked us for. Rendered only when there IS
            any — an empty view is clutter for the majority of workspaces that
            never receive an escalation. */}
        {counts?.sharedWithUs ? (
          <SubSidebarItem
            href="/tickets?view=shared"
            label="Shared with us"
            leading={<Users className="size-4" />}
            active={isView("shared", null)}
            trailing={badge(counts.sharedWithUs)}
          />
        ) : null}
        {/* Saved views — the named queries a department lives in. Rendered
            after the built-ins because those are the universal ones. */}
        {views.length > 0 ? (
          <>
            <div className="mt-2 px-2 pb-1 text-3xs font-medium uppercase tracking-wider text-muted-foreground">
              Saved views
            </div>
            {views.map((v) => (
              <SubSidebarItem
                key={v.id}
                href={`/tickets?viewId=${v.id}`}
                label={v.name}
                leading={<Filter className="size-4" />}
                active={viewIdParam === v.id}
              />
            ))}
          </>
        ) : null}
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

      {/* Admin-gated on the ROLE, matching the settings sidebar and the API:
          every `/api/workspace/tickets` route is `@RequireRole("admin")`, so an
          agent who followed this link landed on the error boundary — the one
          place in the product that offered it to them. */}
      {isAdmin ? (
        <SubSidebarSection label="Configure">
          <SubSidebarItem
            href="/settings/tickets"
            label="Ticket settings"
            leading={<Settings2 className="size-4" />}
            active={false}
          />
        </SubSidebarSection>
      ) : null}
    </SubSidebar>
  );
}
