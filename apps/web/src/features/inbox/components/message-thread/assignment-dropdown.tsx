"use client";

import { useMemo, useState } from "react";
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
import {
  AVAILABILITY_DOT_CLASSES,
  AVAILABILITY_LABELS,
} from "@ccp/shared/presence";
import { dispatchLocalSocketEvent, dispatchLocalSocketEvents } from "@/lib/socket-client";
import { apiFetch } from "@/lib/api/client-fetch";
import {
  buildOptimisticAssignment,
  buildOptimisticStatusChange,
  rollbackOptimisticActivity,
} from "@/features/inbox/lib/optimistic-activity";
import { usePresence } from "@/hooks/use-presence";
import { predictAssignmentStatus } from "@/features/inbox/lib/predict-status";
import type { ConversationStatus, User } from "@ccp/shared/types";

import { readError } from "./utils";

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
  // Live online + availability for the team so the dropdown rows can show a
  // small "Away/Busy/Offline" cue. The hook is cheap (shared socket + one
  // listener per signal); subscribing it directly here avoids threading
  // availabilityByUserId through ThreadHeader → MessageThread for one menu.
  const { onlineUserIds, availabilityByUserId } = usePresence(teamId, "");

  const assign = async (assignedUserId: string | null) => {
    if (pending) return;
    const nextStatus = predictAssignmentStatus(currentStatus, assignedUserId);
    const statusWillChange = nextStatus !== currentStatus;
    // Re-picking the CURRENT assignee is a no-op UNLESS it would still flip
    // status — e.g. re-assigning a CLOSED chat to its prior assignee reopens it
    // to pending. (Assignment never sets "open" — see predictAssignmentStatus.)
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
    // Bundle every optimistic frame into ONE flushSync so the assignee chip,
    // the status badge (when assign auto-flips status), AND the matching
    // activity pills all commit in a single paint. Two separate dispatches
    // (state + activity) produced two back-to-back paints — the gap was the
    // perceptible "log lags the rest of the UI". `optimistic: true` skips
    // the inbox-list resync + counts refetch during the in-flight PATCH;
    // the authoritative server frame (optimistic absent) drives convergence.
    const assignActivity = buildOptimisticAssignment({
      teamId,
      conversationId,
      actorName: currentUserName,
      assignedToName: nextUser?.name ?? null,
    });
    const assignActivityId = assignActivity.id;
    let statusActivityId: string | null = null;
    const frames: Parameters<typeof dispatchLocalSocketEvents>[0] = [
      [
        "conversation:assigned",
        { teamId, conversationId, assignedUser: nextUser, optimistic: true },
      ],
      assignActivity.frame,
    ];
    if (statusWillChange) {
      const statusActivity = buildOptimisticStatusChange({
        teamId,
        conversationId,
        actorName: currentUserName,
        status: nextStatus,
      });
      statusActivityId = statusActivity.id;
      frames.push([
        "conversation:status",
        { teamId, conversationId, status: nextStatus, optimistic: true },
      ]);
      frames.push(statusActivity.frame);
    }
    dispatchLocalSocketEvents(frames);
    const rollbackActivity = () => {
      rollbackOptimisticActivity(teamId, conversationId, assignActivityId);
      if (statusActivityId) {
        rollbackOptimisticActivity(teamId, conversationId, statusActivityId);
      }
    };
    try {
      const res = await apiFetch(`/api/conversations/${conversationId}/assign`, {
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
        <Button
          variant="outline"
          size="sm"
          className="h-8 min-w-0 gap-1.5"
          disabled={pending}
          // Full name is the label even when the text collapses below @2xl,
          // so the avatar-only trigger stays self-describing for hover + SR.
          title={currentName ? `Assigned to ${currentName}` : "Unassigned — assign this conversation"}
          aria-label={currentName ? `Assigned to ${currentName}` : "Unassigned — assign this conversation"}
        >
          {currentName ? (
            <>
              <Avatar className="size-4 shrink-0">
                {currentAvatarUrl ? (
                  <AvatarImage src={currentAvatarUrl} alt={currentName} />
                ) : null}
                <AvatarFallback seed={currentId ?? currentName} className="text-[8px]">
                  {initials(currentName)}
                </AvatarFallback>
              </Avatar>
              {/* Name collapses below @2xl of HEADER width — same container-query
                  breakpoint the Stage pill uses — leaving avatar + chevron. */}
              <span className="hidden truncate max-w-32 font-normal @2xl:inline">
                {currentName.split(" ")[0]}
              </span>
            </>
          ) : (
            <span className="text-muted-foreground">Unassigned</span>
          )}
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-56"
        // Suppress Radix's focus-return so the trigger doesn't keep a
        // `:focus-visible` ring after a mouse pick. See status-dropdown.tsx
        // for the full rationale.
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        <DropdownMenuLabel>Assign to…</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void assign(null)}>
          {currentId === null && <Check className="size-3.5" />}
          <span className={cn("text-muted-foreground", currentId === null && "ml-1")}>
            Unassigned
          </span>
        </DropdownMenuItem>
        <AssignableMembers
          teamMembers={teamMembers}
          currentId={currentId}
          onlineUserIds={onlineUserIds}
          availabilityByUserId={availabilityByUserId}
          onPick={(id) => void assign(id)}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Two-section member list: Available first (online + status="available"),
 * then a labeled "Offline" group under a separator for everyone else
 * (offline, appear-offline, busy, away). The user can still assign to
 * anyone — the grouping is purely a sort/affordance.
 *
 * Live: derived from `usePresence`, so a teammate flipping to "Available"
 * jumps from the offline section to the available section in the same
 * frame the badge updates — no list rebuild needed.
 *
 * Within each group, sorted alphabetically by name so the order is stable
 * across status flips and renders.
 */
function AssignableMembers({
  teamMembers,
  currentId,
  onlineUserIds,
  availabilityByUserId,
  onPick,
}: {
  teamMembers: User[];
  currentId: string | null;
  onlineUserIds: Set<string>;
  availabilityByUserId: Record<string, { status: "available" | "busy" | "away" | "offline"; message?: string | null }>;
  onPick: (id: string) => void;
}) {
  const { available, offline } = useMemo(() => {
    const isAvailable = (u: User): boolean => {
      if (!onlineUserIds.has(u.id)) return false;
      const a = availabilityByUserId[u.id];
      // No entry = the sparse-snapshot default of "available, no note".
      if (!a) return true;
      return a.status === "available";
    };
    const byName = (a: User, b: User): number => a.name.localeCompare(b.name);
    const av: User[] = [];
    const off: User[] = [];
    for (const u of teamMembers) (isAvailable(u) ? av : off).push(u);
    av.sort(byName);
    off.sort(byName);
    return { available: av, offline: off };
  }, [teamMembers, onlineUserIds, availabilityByUserId]);

  return (
    <>
      {available.length > 0 && (
        <>
          <DropdownMenuLabel className="px-2 pb-1 pt-2 text-3xs font-semibold uppercase tracking-[0.08em] text-muted-foreground/60">
            Available
          </DropdownMenuLabel>
          {available.map((u) => (
            <MemberRow
              key={u.id}
              user={u}
              isCurrent={currentId === u.id}
              online={onlineUserIds.has(u.id)}
              availability={availabilityByUserId[u.id]}
              onPick={onPick}
            />
          ))}
        </>
      )}
      {offline.length > 0 && (
        <>
          {available.length > 0 && <DropdownMenuSeparator className="my-1" />}
          <DropdownMenuLabel className="px-2 pb-1 pt-2 text-3xs font-semibold uppercase tracking-[0.08em] text-muted-foreground/60">
            Offline
          </DropdownMenuLabel>
          {offline.map((u) => (
            <MemberRow
              key={u.id}
              user={u}
              isCurrent={currentId === u.id}
              online={onlineUserIds.has(u.id)}
              availability={availabilityByUserId[u.id]}
              onPick={onPick}
              dimmed
            />
          ))}
        </>
      )}
    </>
  );
}

function MemberRow({
  user,
  isCurrent,
  online,
  availability,
  onPick,
  dimmed,
}: {
  user: User;
  isCurrent: boolean;
  online: boolean;
  availability?: { status: "available" | "busy" | "away" | "offline"; message?: string | null };
  onPick: (id: string) => void;
  dimmed?: boolean;
}) {
  // Status dot rule mirrors the sidebar: offline color wins when the
  // user has no socket OR picked "Appear offline" (server filtered);
  // otherwise the availability badge color, defaulting to emerald.
  const dotClass = online
    ? (availability
        ? AVAILABILITY_DOT_CLASSES[availability.status]
        : AVAILABILITY_DOT_CLASSES.available)
    : AVAILABILITY_DOT_CLASSES.offline;
  // Cue text — only when the user is in the offline group, since the
  // available group's rows are uniformly "available" by definition.
  const cue = !online
    ? "Offline"
    : availability && availability.status !== "available"
      ? AVAILABILITY_LABELS[availability.status]
      : null;
  const note = availability?.message?.trim() || null;
  return (
    <DropdownMenuItem
      onSelect={() => onPick(user.id)}
      className={cn("items-start", dimmed && "text-muted-foreground")}
    >
      {isCurrent ? (
        <Check className="size-3.5" />
      ) : (
        <div className="relative">
          <Avatar className={cn("size-5", dimmed && "opacity-80")}>
            {user.avatarUrl ? <AvatarImage src={user.avatarUrl} alt={user.name} /> : null}
            <AvatarFallback seed={user.id} className="text-3xs">{initials(user.name)}</AvatarFallback>
          </Avatar>
          <span
            className={cn(
              "absolute -bottom-0.5 -right-0.5 size-1.5 rounded-full ring-1 ring-popover",
              dotClass,
            )}
            aria-hidden
          />
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate">{user.name}</span>
          {cue && (
            <span className="shrink-0 text-3xs text-muted-foreground">{cue}</span>
          )}
        </div>
        {/* Availability note — the teammate's own status message. Surfaced
            inline (was a hover-only `title` tooltip nobody could find). */}
        {note && (
          <span
            className="truncate text-3xs leading-tight text-muted-foreground/80"
            title={note}
          >
            {note}
          </span>
        )}
      </div>
    </DropdownMenuItem>
  );
}
