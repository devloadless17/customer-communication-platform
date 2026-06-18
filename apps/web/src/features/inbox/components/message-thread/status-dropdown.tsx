"use client";

import { useState } from "react";
import { Check, ChevronDown } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@ccp/shared/utils";
import { dispatchLocalSocketEvent, dispatchLocalSocketEvents } from "@/lib/socket-client";
import { apiFetch } from "@/lib/api/client-fetch";
import {
  buildOptimisticAssignment,
  buildOptimisticStatusChange,
  rollbackOptimisticActivity,
} from "@/features/inbox/lib/optimistic-activity";
import { STATUS_META } from "@/features/inbox/lib/status-meta";
import type { ConversationStatus, User } from "@ccp/shared/types";

import { readError } from "./utils";

/**
 * Solid-fill dot colour per status, mirroring the icon's `STATUS_META.cls`
 * hue. Shown on the compact (icon-only) trigger below @2xl so the status is
 * still readable at a glance without the text label. Kept here (not in
 * status-meta) because the menu items use the coloured icon, not a dot.
 */
const STATUS_DOT_CLS: Record<ConversationStatus, string> = {
  open: "bg-emerald-500",
  pending: "bg-amber-500",
  closed: "bg-muted-foreground/50",
};

export function StatusDropdown({
  teamId,
  conversationId,
  current,
  assignedUserId,
  teamMembers,
  currentUserName,
  onAlert,
}: {
  teamId: string;
  conversationId: string;
  current: ConversationStatus;
  /** Current assignee — needed to optimistically clear it when closing, since
   *  the server unassigns on close (mirror of conversations.service setStatus). */
  assignedUserId: string | null;
  /** Roster, to reconstruct the prior assignee for rollback on a failed close. */
  teamMembers: User[];
  /** Actor name for the optimistic activity pill (the agent making the change). */
  currentUserName: string;
  onAlert: (title: string, description?: string) => Promise<void>;
}) {
  const [pending, setPending] = useState(false);

  const Icon = STATUS_META[current].icon;

  const setStatus = async (status: ConversationStatus) => {
    if (status === current || pending) return;
    // Closing a conversation also UNASSIGNS it and drops it out of the Active
    // view (server side-effects), but it's fully reversible (it reopens when the
    // customer messages again) so it's a one-click action like open/pending —
    // no confirm, by design, so agents under heavy load aren't slowed down.
    setPending(true);
    // Closing UNASSIGNS server-side (conversations.service setStatus). Mirror
    // that optimistically so the assignee chip clears in the SAME frame as the
    // status pill — without this the chip lags until the server's
    // `conversation:assigned` round-trips back, which is the visible "takes
    // time to become unassigned" delay. Only when there's actually an assignee.
    const willUnassign = status === "closed" && assignedUserId !== null;
    const prevUser = willUnassign
      ? teamMembers.find((u) => u.id === assignedUserId) ?? null
      : null;
    // Optimistic: fan the same socket frames the server will broadcast so
    // sidebar status badges, the row, the right-rail mirror, the assignee
    // chip, AND the matching activity pill flip in ONE paint cycle. Each
    // individual `dispatchLocalSocketEvent` wraps its own `flushSync`, so
    // calling them in sequence produced N paints in a row — the gap between
    // the status-frame paint and the activity-frame paint is what surfaced as
    // "the activity log is slower than everything else". Bundling into one
    // `dispatchLocalSocketEvents` collapses all frames into a single commit.
    //
    // `optimistic: true` tells the inbox-list resync + counts refetch to skip
    // their GETs during the in-flight PATCH window — otherwise both fire and
    // either (a) return pre-change state that flickers the row back, or (b)
    // overwrite the optimistic count badge with stale numbers. The
    // authoritative server frame (optimistic absent) drives convergence.
    const statusActivity = buildOptimisticStatusChange({
      teamId,
      conversationId,
      actorName: currentUserName,
      status,
    });
    const statusActivityId = statusActivity.id;
    let unassignActivityId: string | null = null;
    const frames: Parameters<typeof dispatchLocalSocketEvents>[0] = [
      [
        "conversation:status",
        { teamId, conversationId, status, optimistic: true },
      ],
      statusActivity.frame,
    ];
    if (willUnassign) {
      const unassignActivity = buildOptimisticAssignment({
        teamId,
        conversationId,
        actorName: currentUserName,
        assignedToName: null,
      });
      unassignActivityId = unassignActivity.id;
      frames.push([
        "conversation:assigned",
        { teamId, conversationId, assignedUser: null, optimistic: true },
      ]);
      frames.push(unassignActivity.frame);
    }
    dispatchLocalSocketEvents(frames);
    const rollbackActivity = () => {
      rollbackOptimisticActivity(teamId, conversationId, statusActivityId);
      if (unassignActivityId) {
        rollbackOptimisticActivity(teamId, conversationId, unassignActivityId);
      }
    };
    try {
      const res = await apiFetch(`/api/conversations/${conversationId}/status`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) {
        // Roll back BOTH frames so the pill + chip reflect truth.
        dispatchLocalSocketEvent("conversation:status", {
          teamId,
          conversationId,
          status: current,
        });
        if (willUnassign) {
          dispatchLocalSocketEvent("conversation:assigned", {
            teamId,
            conversationId,
            assignedUser: prevUser,
          });
        }
        rollbackActivity();
        await onAlert("Couldn't change status", await readError(res));
      }
    } catch (err) {
      dispatchLocalSocketEvent("conversation:status", {
        teamId,
        conversationId,
        status: current,
      });
      if (willUnassign) {
        dispatchLocalSocketEvent("conversation:assigned", {
          teamId,
          conversationId,
          assignedUser: prevUser,
        });
      }
      rollbackActivity();
      await onAlert(
        "Couldn't change status",
        err instanceof Error ? err.message : "Network error",
      );
    } finally {
      setPending(false);
    }
  };

  const items: ConversationStatus[] = ["open", "pending", "closed"];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-8 gap-1.5"
          disabled={pending}
          aria-label={`Status: ${STATUS_META[current].label} — change conversation status`}
          title={`Status: ${STATUS_META[current].label}`}
        >
          <span className="relative inline-flex shrink-0 items-center">
            <Icon className={cn("size-3.5", STATUS_META[current].cls)} />
            {/* Coloured status dot — keeps the status legible on the compact
                (label-hidden) trigger below @2xl. Hidden once the label is
                back, where it'd be redundant with the coloured icon + text. */}
            <span
              className={cn(
                "absolute -right-0.5 -top-0.5 size-1.5 rounded-full ring-1 ring-background @2xl:hidden",
                STATUS_DOT_CLS[current],
              )}
              aria-hidden
            />
          </span>
          <span className="hidden font-normal @2xl:inline">{STATUS_META[current].label}</span>
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        // Don't return focus to the trigger on close — Radix's programmatic
        // `.focus()` triggers `:focus-visible`, painting the persistent ring
        // that read as "the button stays selected after picking". The user
        // already used the mouse to pick; the focus return is keyboard-a11y
        // boilerplate that doesn't apply here.
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        {items.map((value) => {
          const { label, icon: ItemIcon, cls } = STATUS_META[value];
          return (
            <DropdownMenuItem key={value} onSelect={() => void setStatus(value)}>
              {value === current ? (
                <Check className="size-3.5" />
              ) : (
                <ItemIcon className={cn("size-3.5", cls)} />
              )}
              {label}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
