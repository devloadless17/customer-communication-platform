"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, Loader2, Search, Trash2, UserPlus } from "lucide-react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { fetchWithSessionGuard } from "@/lib/auth/client-session-guard";
import { dispatchLocalSocketEvent } from "@/lib/socket-client";
import { toast } from "@/lib/toast";
import { canManageChannel } from "@ccp/shared/team-chat/permissions";
import type { ChannelMemberDto } from "@ccp/shared/dtos";
import type { TeamChannelDto } from "@ccp/shared/team-chat/types";
import { cn, initials } from "@ccp/shared/utils";
import type { Role, User } from "@ccp/shared/types";

/**
 * Channel-members dialog. Two stacked sections:
 *
 *   1. Current members — searchable list with Remove buttons. Self gets a
 *      "Leave" affordance (when not the default channel). Admin/manager can
 *      remove anyone else (except from the default channel, which is locked
 *      to all-team membership).
 *
 *   2. Add people — only for admin/manager. A team-member picker filtered to
 *      non-members. Multi-select then "Add N" submits one batched request.
 *
 * Local optimistic dispatch on both add and remove so this tab updates the
 * same frame instead of waiting for the server-fanned `team:channel:members:
 * changed` echo. The cache reducer is the same on both paths, so the echo
 * is a no-op when it lands.
 */
export function ChannelMembersDialog({
  channel,
  currentUser,
  currentRole,
  allTeamMembers,
  onClose,
  onChanged,
}: {
  channel: TeamChannelDto;
  currentUser: { id: string };
  currentRole: Role;
  allTeamMembers: User[];
  onClose: () => void;
  /** Called after any add/remove with the new member count so the parent's
   *  header pill stays in sync without waiting for a refetch. */
  onChanged: (memberCount: number) => void;
}) {
  const [members, setMembers] = useState<ChannelMemberDto[] | null>(null);
  const [memberFilter, setMemberFilter] = useState("");
  const [addPickerOpen, setAddPickerOpen] = useState(false);
  const [pickerFilter, setPickerFilter] = useState("");
  const [selectedToAdd, setSelectedToAdd] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canManage = canManageChannel(currentRole);

  // Initial fetch.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await fetchWithSessionGuard(
        `/api/team/channels/${channel.id}/members`,
      );
      if (cancelled) return;
      const json = (await res.json().catch(() => ({}))) as {
        members?: ChannelMemberDto[];
      };
      if (json.members) setMembers(json.members);
    })();
    return () => {
      cancelled = true;
    };
  }, [channel.id]);

  const memberIds = useMemo(
    () => new Set(members?.map((m) => m.userId) ?? []),
    [members],
  );

  const filteredMembers = useMemo(() => {
    if (!members) return [];
    const q = memberFilter.trim().toLowerCase();
    if (!q) return members;
    return members.filter(
      (m) =>
        m.name.toLowerCase().includes(q) || m.email.toLowerCase().includes(q),
    );
  }, [members, memberFilter]);

  const addableUsers = useMemo(() => {
    const q = pickerFilter.trim().toLowerCase();
    return allTeamMembers
      .filter((u) => u.isActive && !memberIds.has(u.id))
      .filter((u) =>
        q
          ? u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q)
          : true,
      );
  }, [allTeamMembers, memberIds, pickerFilter]);

  const removeMember = async (userId: string) => {
    if (busy || !members) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetchWithSessionGuard(
        `/api/team/channels/${channel.id}/members/${userId}`,
        { method: "DELETE" },
      );
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as {
          detail?: string;
          error?: string;
        };
        setError(json.detail ?? json.error ?? `HTTP ${res.status}`);
        return;
      }
      const next = members.filter((m) => m.userId !== userId);
      setMembers(next);
      onChanged(next.length);
      dispatchLocalSocketEvent("team:channel:members:changed", {
        teamId: channel.teamId,
        channelId: channel.id,
        action: "removed",
        userIds: [userId],
        changedById: currentUser.id,
      });
    } finally {
      setBusy(false);
    }
  };

  const addSelected = async () => {
    if (busy || selectedToAdd.size === 0) return;
    const ids = [...selectedToAdd];
    setBusy(true);
    setError(null);
    try {
      const res = await fetchWithSessionGuard(
        `/api/team/channels/${channel.id}/members`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ userIds: ids }),
        },
      );
      const json = (await res.json().catch(() => ({}))) as {
        added?: string[];
        detail?: string;
        error?: string;
      };
      if (!res.ok) {
        setError(json.detail ?? json.error ?? `HTTP ${res.status}`);
        return;
      }
      // Optimistically append the newly-added users using the team-roster
      // info we already have on hand. The next mount of the dialog
      // (or a forced refetch) will reconcile if anything drifted.
      const userMap = new Map(allTeamMembers.map((u) => [u.id, u] as const));
      const newRows: ChannelMemberDto[] = (json.added ?? ids).map((id) => {
        const u = userMap.get(id);
        return {
          channelId: channel.id,
          userId: id,
          name: u?.name ?? "Unknown",
          email: u?.email ?? "",
          role: (u?.role ?? "agent") as Role,
          avatarUrl: u?.avatarUrl ?? null,
          addedAt: new Date().toISOString(),
          addedById: currentUser.id,
          isSelf: id === currentUser.id,
        };
      });
      const next = [...newRows, ...(members ?? [])];
      setMembers(next);
      onChanged(next.length);
      setSelectedToAdd(new Set());
      setAddPickerOpen(false);
      setPickerFilter("");
      toast.success(
        json.added?.length === 1
          ? "Added 1 person to the channel"
          : `Added ${json.added?.length ?? ids.length} people to the channel`,
      );
      dispatchLocalSocketEvent("team:channel:members:changed", {
        teamId: channel.teamId,
        channelId: channel.id,
        action: "added",
        userIds: json.added ?? ids,
        changedById: currentUser.id,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex w-full max-w-lg flex-col rounded-xl border border-border bg-background shadow-2xl">
        <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
          <div>
            <div className="text-base font-semibold">#{channel.name} members</div>
            {channel.isDefault ? (
              <div className="text-[11px] text-muted-foreground">
                The default channel — everyone in the team is automatically a member.
              </div>
            ) : (
              <div className="text-[11px] text-muted-foreground">
                {members?.length ?? 0} {members?.length === 1 ? "person" : "people"} in this channel
              </div>
            )}
          </div>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>

        <div className="flex max-h-112 flex-col gap-3 overflow-hidden p-4">
          {canManage && !channel.isDefault ? (
            <div>
              {addPickerOpen ? (
                <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      Add people
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setAddPickerOpen(false);
                        setSelectedToAdd(new Set());
                        setPickerFilter("");
                      }}
                      className="text-[11px] text-muted-foreground hover:text-foreground"
                    >
                      Cancel
                    </button>
                  </div>
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      value={pickerFilter}
                      onChange={(e) => setPickerFilter(e.target.value)}
                      placeholder="Filter teammates…"
                      className="pl-7"
                      autoFocus
                    />
                  </div>
                  <ul className="max-h-44 overflow-y-auto rounded-md border border-border">
                    {addableUsers.length === 0 ? (
                      <li className="px-3 py-2 text-center text-xs text-muted-foreground">
                        Everyone matching is already in this channel.
                      </li>
                    ) : (
                      addableUsers.map((u) => {
                        const checked = selectedToAdd.has(u.id);
                        return (
                          <li key={u.id}>
                            <button
                              type="button"
                              onClick={() => {
                                setSelectedToAdd((prev) => {
                                  const next = new Set(prev);
                                  if (checked) next.delete(u.id);
                                  else next.add(u.id);
                                  return next;
                                });
                              }}
                              className={cn(
                                "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors hover:bg-accent/60",
                                checked && "bg-accent/40",
                              )}
                            >
                              <span
                                className={cn(
                                  "inline-flex size-4 items-center justify-center rounded border",
                                  checked
                                    ? "border-primary bg-primary text-primary-foreground"
                                    : "border-muted-foreground/40",
                                )}
                              >
                                {checked ? <Check className="size-3" /> : null}
                              </span>
                              <Avatar className="size-6">
                                {u.avatarUrl ? <AvatarImage src={u.avatarUrl} alt={u.name} /> : null}
                                <AvatarFallback seed={u.id} className="text-[10px]">
                                  {initials(u.name)}
                                </AvatarFallback>
                              </Avatar>
                              <span className="min-w-0 flex-1 truncate font-medium">{u.name}</span>
                              <span className="shrink-0 text-[10px] text-muted-foreground">
                                {u.role}
                              </span>
                            </button>
                          </li>
                        );
                      })
                    )}
                  </ul>
                  <div className="flex justify-end">
                    <Button
                      size="sm"
                      onClick={() => void addSelected()}
                      disabled={busy || selectedToAdd.size === 0}
                    >
                      {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
                      Add {selectedToAdd.size > 0 ? selectedToAdd.size : ""}
                    </Button>
                  </div>
                </div>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setAddPickerOpen(true)}
                  className="gap-1.5"
                >
                  <UserPlus className="size-3.5" />
                  Add people
                </Button>
              )}
            </div>
          ) : null}

          {error ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </div>
          ) : null}

          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={memberFilter}
              onChange={(e) => setMemberFilter(e.target.value)}
              placeholder="Filter members…"
              className="pl-7"
            />
          </div>

          <ul className="flex-1 overflow-y-auto rounded-lg border border-border">
            {members === null ? (
              <li className="flex items-center justify-center px-3 py-4 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" />
              </li>
            ) : filteredMembers.length === 0 ? (
              <li className="px-3 py-4 text-center text-xs text-muted-foreground">
                No members match that filter.
              </li>
            ) : (
              filteredMembers.map((m) => {
                const showRemove = !channel.isDefault && (canManage || m.isSelf);
                const isSelfLeave = m.isSelf;
                return (
                  <li
                    key={m.userId}
                    className="flex items-center gap-2.5 border-b border-border px-3 py-2 last:border-0"
                  >
                    <Avatar className="size-7">
                      {m.avatarUrl ? <AvatarImage src={m.avatarUrl} alt={m.name} /> : null}
                      <AvatarFallback seed={m.userId} className="text-[10px]">{initials(m.name)}</AvatarFallback>
                    </Avatar>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-sm font-medium">{m.name}</span>
                        {m.isSelf ? (
                          <span className="rounded-full bg-muted px-1.5 py-0 text-[9px] uppercase tracking-wider text-muted-foreground">
                            you
                          </span>
                        ) : null}
                      </div>
                      <div className="truncate text-[11px] text-muted-foreground">
                        {m.email}
                      </div>
                    </div>
                    <span className="shrink-0 text-[10px] capitalize text-muted-foreground">
                      {m.role}
                    </span>
                    {showRemove ? (
                      <button
                        type="button"
                        onClick={() => void removeMember(m.userId)}
                        disabled={busy}
                        aria-label={isSelfLeave ? "Leave channel" : `Remove ${m.name}`}
                        title={isSelfLeave ? "Leave channel" : `Remove ${m.name}`}
                        className="inline-flex size-7 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    ) : null}
                  </li>
                );
              })
            )}
          </ul>
        </div>
      </div>
    </div>
  );
}
