"use client";

import { useState } from "react";
import { Archive, Check, ChevronDown, CircleCheck, CircleDashed } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@ccp/shared/utils";
import { dispatchLocalSocketEvent } from "@/lib/socket-client";
import {
  optimisticAssignment,
  optimisticStatusChange,
  rollbackOptimisticActivity,
} from "@/features/inbox/lib/optimistic-activity";
import type { ConversationStatus, User } from "@ccp/shared/types";

import { readError } from "./utils";

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

  const map: Record<
    ConversationStatus,
    { label: string; icon: typeof CircleCheck; cls: string }
  > = {
    open: { label: "Open", icon: CircleDashed, cls: "text-emerald-600 dark:text-emerald-400" },
    pending: { label: "Pending", icon: CircleDashed, cls: "text-amber-600 dark:text-amber-400" },
    closed: { label: "Closed", icon: Archive, cls: "text-muted-foreground" },
  };
  const Icon = map[current].icon;

  const setStatus = async (status: ConversationStatus) => {
    if (status === current || pending) return;
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
    // sidebar status badges, the row, the right-rail mirror, and the assignee
    // chip flip instantly instead of waiting on PATCH → bus → socket round-trip.
    // `optimistic: true` tells the inbox-list resync + counts refetch to skip
    // their GETs for this frame — otherwise both fire during the in-flight
    // PATCH window and either (a) return pre-change state that flickers the
    // row back, or (b) overwrite the optimistic count badge with stale numbers.
    // The authoritative server frame (optimistic absent) drives convergence.
    dispatchLocalSocketEvent("conversation:status", {
      teamId,
      conversationId,
      status,
      optimistic: true,
    });
    // Synthesize the matching timeline pill so it lands in the same frame as
    // the status badge, not a GET behind it. Reconciled by the authoritative
    // events fetch; rolled back below on a failed write.
    const statusActivityId = optimisticStatusChange({
      teamId,
      conversationId,
      actorName: currentUserName,
      status,
    });
    let unassignActivityId: string | null = null;
    if (willUnassign) {
      dispatchLocalSocketEvent("conversation:assigned", {
        teamId,
        conversationId,
        assignedUser: null,
        optimistic: true,
      });
      unassignActivityId = optimisticAssignment({
        teamId,
        conversationId,
        actorName: currentUserName,
        assignedToName: null,
      });
    }
    const rollbackActivity = () => {
      rollbackOptimisticActivity(teamId, conversationId, statusActivityId);
      if (unassignActivityId) {
        rollbackOptimisticActivity(teamId, conversationId, unassignActivityId);
      }
    };
    try {
      const res = await fetch(`/api/conversations/${conversationId}/status`, {
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

  const items: { value: ConversationStatus; icon: typeof CircleCheck; cls: string }[] = [
    { value: "open", icon: CircleDashed, cls: "text-emerald-600" },
    { value: "pending", icon: CircleDashed, cls: "text-amber-600" },
    { value: "closed", icon: CircleCheck, cls: "text-muted-foreground" },
  ];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 gap-1.5" disabled={pending}>
          <Icon className={cn("size-3.5", map[current].cls)} />
          <span className="font-normal">{map[current].label}</span>
          <ChevronDown className="size-3.5 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {items.map(({ value, icon: ItemIcon, cls }) => (
          <DropdownMenuItem key={value} onSelect={() => void setStatus(value)}>
            {value === current ? (
              <Check className="size-3.5" />
            ) : (
              <ItemIcon className={cn("size-3.5", cls)} />
            )}
            {map[value].label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
