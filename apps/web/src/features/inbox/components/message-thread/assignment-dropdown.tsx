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
import type { ConversationStatus, User } from "@ccp/shared/types";

import { readError } from "./utils";

/**
 * Mirror of `conversations.service.ts:assign`'s status side-effect rule.
 * Keep these in sync — divergence would show as a one-frame UI flash
 * (client predicts X, server returns Y, client snaps to Y).
 *
 *   - Assign to user + status≠open   → status becomes open (claim from
 *     pending = move out of triage; claim from closed = reopen)
 *   - Unassign       + status=open    → status becomes pending
 *   - everything else                 → status unchanged
 */
function predictNextStatus(
  current: ConversationStatus,
  nextAssignedUserId: string | null,
): ConversationStatus {
  if (nextAssignedUserId !== null && current !== "open") return "open";
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
  onAlert: (title: string, description?: string) => Promise<void>;
}) {
  const [pending, setPending] = useState(false);

  const assign = async (assignedUserId: string | null) => {
    if (assignedUserId === currentId || pending) return;
    setPending(true);
    const prevUser = currentId
      ? teamMembers.find((u) => u.id === currentId) ?? null
      : null;
    const nextUser = assignedUserId
      ? teamMembers.find((u) => u.id === assignedUserId) ?? null
      : null;
    const nextStatus = predictNextStatus(currentStatus, assignedUserId);
    const statusWillChange = nextStatus !== currentStatus;
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
    if (statusWillChange) {
      dispatchLocalSocketEvent("conversation:status", {
        teamId,
        conversationId,
        status: nextStatus,
      });
    }
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
                <AvatarFallback className="text-[8px]">
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
                <AvatarFallback className="text-[10px]">{initials(u.name)}</AvatarFallback>
              </Avatar>
            )}
            <span>{u.name}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
