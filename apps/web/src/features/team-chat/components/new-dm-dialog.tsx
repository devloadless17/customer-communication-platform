"use client";

import { useMemo, useState } from "react";
import { Search } from "lucide-react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { PresenceDot } from "@/components/presence-dot";
import { fetchWithSessionGuard } from "@/lib/auth/client-session-guard";
import { toast } from "@/lib/toast";
import { cn, initials } from "@ccp/shared/utils";
import type { TeamChannelDto } from "@ccp/shared/team-chat/types";
import type { User } from "@ccp/shared/types";

/**
 * Roster picker for starting a 1:1 DM.
 *
 * The POST is idempotent server-side (unique on (workspaceId, dmKey)), so picking
 * someone you already have a DM with just navigates to the existing thread —
 * no duplicate, no error, no special-casing here.
 */
export function NewDmDialog({
  teamMembers,
  currentUserId,
  onlineUserIds,
  onClose,
  onOpened,
}: {
  teamMembers: User[];
  currentUserId: string;
  onlineUserIds: Set<string>;
  onClose: () => void;
  onOpened: (channel: TeamChannelDto) => void;
}) {
  const [query, setQuery] = useState("");
  const [busyUserId, setBusyUserId] = useState<string | null>(null);

  const candidates = useMemo(() => {
    const q = query.trim().toLowerCase();
    // Deactivated teammates are excluded: you can keep reading an existing DM
    // with someone who left, but you can't start a new one (the server
    // enforces the same rule).
    const active = teamMembers.filter((m) => m.isActive);
    const matched = q
      ? active.filter(
          (m) =>
            (m.name ?? "").toLowerCase().includes(q) ||
            (m.email ?? "").toLowerCase().includes(q),
        )
      : active;
    // Self sorts last as "notes to self" — it's a real, useful destination
    // (stashing links and files), but it isn't who you're usually looking for.
    return matched.slice().sort((a, b) => {
      if (a.id === currentUserId) return 1;
      if (b.id === currentUserId) return -1;
      return (a.name ?? "").localeCompare(b.name ?? "");
    });
  }, [teamMembers, query, currentUserId]);

  const start = async (userId: string) => {
    setBusyUserId(userId);
    try {
      const res = await fetchWithSessionGuard("/api/team/channels/dm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId }),
      });
      const json = (await res.json()) as {
        channel?: TeamChannelDto;
        error?: string;
        detail?: string;
      };
      if (!res.ok || !json.channel) {
        toast.error(json.detail ?? json.error ?? "Couldn't open that conversation.");
        return;
      }
      onOpened(json.channel);
    } catch {
      toast.error("Couldn't open that conversation.");
    } finally {
      setBusyUserId(null);
    }
  };

  return (
    <Dialog open onClose={onClose}>
      <DialogContent className="max-w-md p-5" ariaLabel="New direct message">
        <div className="mb-3 text-base font-semibold">New direct message</div>

        <div className="relative mb-3">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search teammates"
            aria-label="Search teammates"
            className="h-8 pl-7 text-sm"
          />
        </div>

        <div className="max-h-80 overflow-y-auto">
          {candidates.length === 0 ? (
            <div className="py-6 text-center text-xs text-muted-foreground">
              No teammates match that search.
            </div>
          ) : (
            candidates.map((m) => {
              const isSelf = m.id === currentUserId;
              return (
                <button
                  key={m.id}
                  type="button"
                  disabled={busyUserId !== null}
                  onClick={() => void start(m.id)}
                  className={cn(
                    "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                    "hover:bg-accent disabled:opacity-60",
                    busyUserId === m.id && "bg-accent",
                  )}
                >
                  <span className="relative shrink-0">
                    <Avatar className="size-7">
                      {m.avatarUrl ? <AvatarImage src={m.avatarUrl} alt="" /> : null}
                      <AvatarFallback className="text-2xs">
                        {initials(m.name ?? "")}
                      </AvatarFallback>
                    </Avatar>
                    {!isSelf && (
                      <PresenceDot
                        online={onlineUserIds.has(m.id)}
                        availability={m.availabilityStatus ?? null}
                        className="absolute -bottom-0.5 -right-0.5"
                      />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">
                      {m.name}
                      {isSelf ? " (you)" : ""}
                    </span>
                    <span className="block truncate text-2xs text-muted-foreground">
                      {isSelf ? "Notes to self" : m.email}
                    </span>
                  </span>
                </button>
              );
            })
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
