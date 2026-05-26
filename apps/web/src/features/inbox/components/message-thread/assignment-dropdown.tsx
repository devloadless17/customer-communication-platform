"use client";

import { useState } from "react";
import { Check, ChevronDown } from "lucide-react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn, initials } from "@ccp/shared/utils";
import { dispatchLocalSocketEvent } from "@/lib/socket-client";
import {
  optimisticAssignment,
  optimisticStatusChange,
  rollbackOptimisticActivity,
} from "@/features/inbox/lib/optimistic-activity";
import type { ConversationStatus, User } from "@ccp/shared/types";

import { readError } from "./utils";

/**
 * Mirror of `conversations.service.ts:assign`'s status side-effect rule.
 * Keep these in sync — divergence would show as a one-frame UI flash
 * (client predicts X, server returns Y, client snaps to Y).
 *
 * Assignment NEVER sets "open" — only the assignee chatting does (claim-on-
 * reply). So:
 *   - Assign to user + status=closed → pending (reopen into triage, assigned)
 *   - Assign to user + status=pending → unchanged (stays pending)
 *   - Unassign       + status=open    → pending (back to triage)
 *   - everything else                 → status unchanged
 */
function predictNextStatus(
  current: ConversationStatus,
  nextAssignedUserId: string | null,
): ConversationStatus {
  if (nextAssignedUserId !== null && current === "closed") return "pending";
  if (nextAssignedUserId === null && current === "open") return "pending";
  return current;
}

export function AssignmentDropdown({
  teamId,
  conversationId,
  currentId,
  currentName,
  currentAvatarUrl,
  currentStatus,
  teamMembers,
  currentUserName,
  onAlert,
}: {
  teamId: string;
  conversationId: string;
  currentId: string | null;
  currentName: string | null;
  currentAvatarUrl?: string | null;
  /** Needed to predict the status side-effect of the assign (see
   *  predictNextStatus above). Mirrors the server rule. */
  currentStatus: ConversationStatus;
  teamMembers: User[];
  /** Actor name for the optimistic activity pill (the agent making the change). */
  currentUserName: string;
  onAlert: (title: string, description?: string) => Promise<void>;
}) {
  const [pending, setPending] = useState(false);

  const assign = async (assignedUserId: string | null) => {
    if (pending) return;
    const nextStatus = predictNextStatus(currentStatus, assignedUserId);
    const statusWillChange = nextStatus !== currentStatus;
    // Re-picking the CURRENT assignee is a no-op UNLESS it would still flip
    // status — e.g. claiming an assigned-but-pending chat (bulk-assigned, or
    // manually set back to pending) should still move it to open.
    if (assignedUserId === currentId && !statusWillChange) return;
    setPending(true);
    const prevUser = currentId
      ? teamMembers.find((u) => u.id === currentId) ?? null
      : null;
    const nextUser = assignedUserId
      ? teamMembers.find((u) => u.id === assignedUserId) ?? null
      : null;
    // Optimistic: fan the same socket frames the server will broadcast so
    // the sidebar assignee chip, list row, status pill, and panel picker
    // all flip instantly. Order matters — assigned BEFORE status, matching
    // the server's publish order so audit / workflow / analytics
    // subscribers see cause-then-effect even on the local pre-confirm
    // pass.
    dispatchLocalSocketEvent("conversation:assigned", {
      teamId,
      conversationId,
      assignedUser: nextUser,
    });
    // Matching timeline pill in the same frame as the assignee chip.
    const assignActivityId = optimisticAssignment({
      teamId,
      conversationId,
      actorName: currentUserName,
      assignedToName: nextUser?.name ?? null,
    });
    let statusActivityId: string | null = null;
    if (statusWillChange) {
      dispatchLocalSocketEvent("conversation:status", {
        teamId,
        conversationId,
        status: nextStatus,
      });
      statusActivityId = optimisticStatusChange({
        teamId,
        conversationId,
        actorName: currentUserName,
        status: nextStatus,
      });
    }
    const rollbackActivity = () => {
      rollbackOptimisticActivity(teamId, conversationId, assignActivityId);
      if (statusActivityId) {
        rollbackOptimisticActivity(teamId, conversationId, statusActivityId);
      }
    };
    try {
      const res = await fetch(`/api/conversations/${conversationId}/assign`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ assignedUserId }),
      });
      if (!res.ok) {
        // Roll back BOTH frames so the chip + pill reflect truth.
        dispatchLocalSocketEvent("conversation:assigned", {
          teamId,
          conversationId,
          assignedUser: prevUser,
        });
        if (statusWillChange) {
          dispatchLocalSocketEvent("conversation:status", {
            teamId,
            conversationId,
            status: currentStatus,
          });
        }
        rollbackActivity();
        await onAlert("Couldn't update assignment", await readError(res));
      }
    } catch (err) {
      dispatchLocalSocketEvent("conversation:assigned", {
        teamId,
        conversationId,
        assignedUser: prevUser,
      });
      if (statusWillChange) {
        dispatchLocalSocketEvent("conversation:status", {
          teamId,
          conversationId,
          status: currentStatus,
        });
      }
      rollbackActivity();
      await onAlert(
        "Couldn't update assignment",
        err instanceof Error ? err.message : "Network error",
      );
    } finally {
      setPending(false);
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 gap-1.5" disabled={pending}>
          {currentName ? (
            <>
              <Avatar className="size-4">
                {currentAvatarUrl ? (
                  <AvatarImage src={currentAvatarUrl} alt={currentName} />
                ) : null}
                <AvatarFallback seed={currentId ?? currentName} className="text-[8px]">
                  {initials(currentName)}
                </AvatarFallback>
              </Avatar>
              <span className="font-normal">{currentName.split(" ")[0]}</span>
            </>
          ) : (
            <span className="text-muted-foreground">Unassigned</span>
          )}
          <ChevronDown className="size-3.5 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuLabel>Assign to…</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void assign(null)}>
          {currentId === null && <Check className="size-3.5" />}
          <span className={cn("text-muted-foreground", currentId === null && "ml-1")}>
            Unassigned
          </span>
        </DropdownMenuItem>
        {teamMembers.map((u) => (
          <DropdownMenuItem key={u.id} onSelect={() => void assign(u.id)}>
            {currentId === u.id ? (
              <Check className="size-3.5" />
            ) : (
              <Avatar className="size-5">
                {u.avatarUrl ? <AvatarImage src={u.avatarUrl} alt={u.name} /> : null}
                <AvatarFallback seed={u.id} className="text-[10px]">{initials(u.name)}</AvatarFallback>
              </Avatar>
            )}
            <span>{u.name}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
