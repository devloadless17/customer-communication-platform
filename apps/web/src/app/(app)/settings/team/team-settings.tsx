"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useLiveTeamName } from "@/hooks/use-live-team-name";
import { useSoftRefresh } from "@/hooks/use-soft-refresh";
import {
  CalendarClock,
  Check,
  Clock,
  Copy,
  KeyRound,
  MoreHorizontal,
  Loader2,
  Mail,
  Settings as SettingsIcon,
  ShieldAlert,
  Trash2,
  UserCheck,
  UserPlus,
  UserX,
  X,
} from "lucide-react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { PageHeader } from "@/components/layouts/page-header";
import { apiFetch } from "@/lib/api/client-fetch";
import { broadcastSignout } from "@/lib/auth/auth-broadcast";
import { closeClientSocket, dispatchLocalSocketEvent } from "@/lib/socket-client";
import { toast } from "@/lib/toast";
import {
  assignableRoles,
  canManageUsers,
  canModifyUser,
  roleLabel,
} from "@ccp/shared/auth/permissions";
import {
  ALL_AVAILABILITY_STATUSES,
  AVAILABILITY_DOT_CLASSES,
  AVAILABILITY_LABELS,
} from "@ccp/shared/presence";
import { PresenceDot } from "@/components/presence-dot";
import { usePresence } from "@/hooks/use-presence";
import type { Role, UserAvailabilityStatus } from "@ccp/shared/types";
import {
  asWorkHours,
  type AvailabilitySource,
  type WorkHours,
  type WorkHoursMode,
} from "@ccp/shared/work-hours";
import { cn, initials } from "@ccp/shared/utils";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import {
  WorkHoursEditor,
  defaultWorkHours,
} from "@/features/settings/components/work-hours-editor";
import { LocalTime } from "@/components/local-time";
import {
  ResetPasswordDialog,
  type ResetPasswordTarget,
} from "@/features/settings/reset-password-dialog";

export interface TeamUserRow {
  id: string;
  name: string;
  email: string;
  role: Role;
  // Platform operator flag — protects them from edits by a workspace admin.
  isSuperAdmin?: boolean;
  deactivated: boolean;
  createdAt: string;
  /** Serve-route path for the member's avatar, or null → initials fallback. */
  avatarUrl: string | null;
  /** EFFECTIVE availability — manual pick, or schedule-derived once hours apply. */
  availabilityStatus: UserAvailabilityStatus;
  availabilityMessage: string | null;
  availabilitySource: AvailabilitySource;
  /** ISO instant a manual/admin pick hands back to the schedule. */
  availabilityUntil: string | null;
  workHoursMode: WorkHoursMode;
}

/** A still-redeemable invite — un-accepted and un-expired. */
export interface PendingInviteRow {
  id: string;
  email: string;
  role: Role;
  expiresAt: string;
  createdAt: string;
  createdByName: string;
}

interface InviteResult {
  url: string;
  expiresAt: string;
  email: string;
}

export function TeamSettings({
  currentUserId,
  currentUserRole,
  currentUserIsSuperAdmin = false,
  workspaceId,
  teamName,
  users,
  pendingInvites,
  teamWorkHours,
  canManageOthersAvailability,
}: {
  currentUserId: string;
  currentUserRole: Role;
  currentUserIsSuperAdmin?: boolean;
  /** Needed for the live presence subscription behind the member status dots. */
  workspaceId: string;
  teamName: string;
  users: TeamUserRow[];
  /** Empty for non-admins (they can't see this panel). */
  pendingInvites: PendingInviteRow[];
  /** Org default schedule; null = none configured (availability stays manual). */
  teamWorkHours: WorkHours | null;
  /** Resolved `availability:manageOthers` capability. */
  canManageOthersAvailability: boolean;
}) {
  const softRefresh = useSoftRefresh();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [lastInvite, setLastInvite] = useState<InviteResult | null>(null);
  // Separate from `pending` (useTransition) — org-delete needs its own flag so
  // the cascade-delete spinner overlay isn't tangled up with the "Generate
  // link" / "Disable" / "Delete user" buttons all sharing the transition.
  // Sharing `pending` made clicking "Delete organization" look like nothing
  // happened while quietly disabling every other button on the page.
  const [deletingOrg, setDeletingOrg] = useState(false);
  // Admin-initiated password reset — the recovery path for a locked-out
  // teammate (no self-serve email reset exists). Non-null = dialog open.
  const [resetTarget, setResetTarget] = useState<ResetPasswordTarget | null>(null);
  // Live team name — listens to `team:renamed` so the input + delete dialog
  // + danger-zone copy stay in sync with what this tab just dispatched OR
  // with another admin's rename on a different tab/device.
  const liveTeamName = useLiveTeamName(teamName);
  // Live presence + availability, the SAME source the inbox sidebar and the
  // assignment dropdown read. Without it this page painted the STORED status
  // with no presence check, so a teammate who wasn't connected at all still
  // showed a green "Available" here while the sidebar correctly showed them
  // grey — the two surfaces disagreed about the same person.
  const { onlineUserIds, availabilityByUserId } = usePresence(workspaceId, currentUserId);
  const { confirm, confirmDialog } = useConfirm();

  const refresh = softRefresh;
  const canManage = canManageUsers(currentUserRole);
  const inviteRoles = useMemo(() => assignableRoles({ role: currentUserRole, isSuperAdmin: currentUserIsSuperAdmin }), [currentUserRole, currentUserIsSuperAdmin]);
  // Org-delete is admin/superAdmin only — same gate as user-management.
  const canDeleteOrg = canManage;

  async function createInvite(form: FormData) {
    setError(null);
    const body = {
      email: form.get("email"),
      role: form.get("role") || "agent",
    };
    const res = await apiFetch("/api/invites", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as {
      invite?: { url: string; expiresAt: string };
      error?: string;
    };
    if (!res.ok || !data.invite) {
      setError(data.error ?? "Failed to create invite");
      return null;
    }
    return {
      url: data.invite.url,
      expiresAt: data.invite.expiresAt,
      email: String(body.email),
    } satisfies InviteResult;
  }

  async function patchUser(id: string, body: { role?: Role; deactivated?: boolean }) {
    setError(null);
    const res = await apiFetch(`/api/users/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      setError(data.error ?? "Failed to update user");
    }
  }

  async function confirmDeleteUser(id: string, name: string) {
    setError(null);
    const ok = await confirm({
      title: `Delete ${name}?`,
      description:
        "This permanently removes the account. Messages and notes they wrote stay in the inbox, but the author becomes \"Removed user.\" This can't be undone.",
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!ok) return;
    // Only the mutation goes inside the transition — keeps the global
    // `pending` flag from lighting up every other button on the page while
    // the user is still reading the confirm dialog.
    startTransition(async () => {
      const res = await apiFetch(`/api/users/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? "Failed to delete user");
        return;
      }
      refresh();
    });
  }

  async function confirmRevokeInvite(id: string, email: string) {
    setError(null);
    const ok = await confirm({
      title: `Revoke invite for ${email}?`,
      description:
        "The link stops working immediately. You can always send a new invite to the same email later.",
      confirmLabel: "Revoke",
      destructive: true,
    });
    if (!ok) return;
    startTransition(async () => {
      const res = await apiFetch(`/api/invites/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? "Failed to revoke invite");
        return;
      }
      // The socket emit on the server will trigger router.refresh() everywhere
      // else; our own tab gets the same path here so the row disappears
      // without waiting on the round-trip.
      refresh();
    });
  }

  async function renameOrg(nextName: string): Promise<boolean> {
    setError(null);
    const trimmed = nextName.trim();
    if (trimmed.length === 0 || trimmed.length > 200) {
      setError("Organization name must be 1–200 characters.");
      return false;
    }
    if (trimmed === liveTeamName) return true; // no-op save — no toast, no churn

    // Optimistic local dispatch FIRST so this tab's sidebar / header patches
    // instantly. The server-side fanout drives every OTHER tab + agent. The
    // input itself updates from `liveTeamName` via the local-event listener
    // wired in team-name-live-sync.tsx, so we don't need to setLiveTeamName
    // separately — the dispatched frame routes through the same listener.
    dispatchLocalSocketEvent("team:renamed", {
      workspaceId: "", // listener doesn't filter by id (only one team per session)
      name: trimmed,
      renamedByUserId: currentUserId,
    });

    const res = await apiFetch("/api/workspace", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: trimmed }),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      setError(data.error ?? "Failed to rename organization");
      // Roll the optimistic patch back to the server-truth name.
      dispatchLocalSocketEvent("team:renamed", {
        workspaceId: "",
        name: liveTeamName,
        renamedByUserId: currentUserId,
      });
      return false;
    }
    toast.success("Organization renamed");
    // Soft-refresh so the RSC layout (sidebar shell) re-fetches and the prop
    // matches the live state next render — purely belt-and-suspenders since
    // the live listener already patched every consumer.
    refresh();
    return true;
  }

  async function deleteOrg() {
    if (deletingOrg) return;
    setError(null);
    const ok = await confirm({
      title: `Delete ${liveTeamName}?`,
      description:
        "This permanently removes the organization and EVERYTHING in it — contacts, conversations, messages, broadcasts, automations, every teammate's account. The WhatsApp connection is dropped. This cannot be undone. You will be signed out immediately.",
      confirmLabel: "Delete organization",
      destructive: true,
      // Highest blast-radius action in the product — require typing the exact
      // org name so it can't be wiped by a misclick + Enter.
      requireText: liveTeamName,
    });
    if (!ok) return;
    setDeletingOrg(true);
    // Drop the socket BEFORE the fetch so the connection banner never gets a
    // chance to flash "Reconnecting…" between the server-side socket kick
    // (api/workspace DELETE → disconnectUserSockets) and the /logout hard nav.
    // The flag inside closeClientSocket also suppresses the banner across
    // the rest of this teardown. Broadcast first so every other tab in this
    // browser tears down in parallel, not after their own next 401.
    broadcastSignout();
    closeClientSocket();
    try {
      const res = await apiFetch("/api/workspace", { method: "DELETE" });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? "Failed to delete organization");
        setDeletingOrg(false);
        return;
      }
      // Cascade nuked our Session row already; force a hard navigation to
      // /logout so the cookie is cleared and we land on /login cleanly. Keep
      // the overlay up — the navigation takes a beat and we don't want the
      // page to look interactive again in the meantime.
      window.location.assign("/logout");
    } catch {
      // A network-level rejection (api restart, WiFi blip) must NOT leave the
      // full-screen "Deleting organization…" overlay up forever — clear it and
      // surface the error so the admin can retry.
      setError("Network error — try again.");
      setDeletingOrg(false);
    }
  }

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Members"
        description={
          canManage
            ? "Generate an invite link for each teammate. They set their own password when they accept."
            : "Read-only view. Only admins can invite users or change roles."
        }
      />

      {error && (
        <div
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          {error}
        </div>
      )}

      {canManage && <OrgNameCard currentName={liveTeamName} onRename={renameOrg} />}

      {canManage && (
        <OrgWorkHoursCard
          initial={teamWorkHours}
          onSaved={refresh}
          onError={setError}
        />
      )}

      {canManage && (
        <InviteCard
          assignableRoles={inviteRoles}
          pending={pending}
          onSubmit={(form) =>
            startTransition(async () => {
              const result = await createInvite(form);
              if (result) {
                setLastInvite(result);
                refresh();
              }
            })
          }
        />
      )}

      {lastInvite && <InviteLinkCard invite={lastInvite} onClose={() => setLastInvite(null)} />}

      {canManage && pendingInvites.length > 0 && (
        <PendingInvitesCard
          invites={pendingInvites}
          pending={pending}
          onRevoke={(id, email) => {
            void confirmRevokeInvite(id, email);
          }}
        />
      )}

      <div className="rounded-xl border border-border">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div>
            <div className="text-sm font-medium">Members ({users.length})</div>
            <div className="text-2xs text-muted-foreground">
              {canManage ? "Last active admin can't be removed." : "Roles are managed by admins."}
            </div>
          </div>
        </div>
        <ul className="divide-y divide-border">
          {users.map((u) => (
            <UserRow
              key={u.id}
              user={u}
              isSelf={u.id === currentUserId}
              actorRole={currentUserRole}
              actorIsSuperAdmin={currentUserIsSuperAdmin}
              online={onlineUserIds.has(u.id)}
              liveAvailability={availabilityByUserId[u.id]?.status}
              liveNote={availabilityByUserId[u.id]?.message ?? undefined}
              canManageAvailability={canManageOthersAvailability}
              onAvailabilityChanged={refresh}
              onAvailabilityError={setError}
              pending={pending}
              onPatch={async (body) => {
                // Confirm a role change or a disable BEFORE mutating — both
                // change access immediately. Re-enable restores access, so it
                // needs no guard. Confirm runs OUTSIDE startTransition so the
                // page-wide `pending` flag doesn't light up while the dialog is
                // open (same pattern as confirmDeleteUser).
                if (body.role !== undefined && body.role !== u.role) {
                  const ok = await confirm({
                    title: `Change ${u.name || "this member"}'s role to ${roleLabel(body.role)}?`,
                    description: "This immediately changes what they can access.",
                    confirmLabel: "Change role",
                  });
                  if (!ok) return;
                }
                if (body.deactivated === true) {
                  const ok = await confirm({
                    title: `Disable ${u.name || "this member"}?`,
                    description:
                      "They'll be signed out and can't sign back in until you re-enable the account.",
                    confirmLabel: "Disable",
                    destructive: true,
                  });
                  if (!ok) return;
                }
                startTransition(async () => {
                  await patchUser(u.id, body);
                  refresh();
                });
              }}
              onDelete={() => {
                void confirmDeleteUser(u.id, u.name);
              }}
              onResetPassword={() =>
                setResetTarget({
                  name: u.name,
                  endpoint: `/api/users/${u.id}/reset-password`,
                })
              }
            />
          ))}
        </ul>
      </div>

      {canDeleteOrg && (
        <DangerZone
          teamName={liveTeamName}
          pending={deletingOrg}
          onDeleteOrg={() => {
            void deleteOrg();
          }}
        />
      )}

      {confirmDialog}
      <ResetPasswordDialog target={resetTarget} onClose={() => setResetTarget(null)} />
      {deletingOrg && <DeletingOrgOverlay teamName={liveTeamName} />}
    </div>
  );
}

function DeletingOrgOverlay({ teamName }: { teamName: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-0 z-70 flex items-center justify-center bg-background/70 backdrop-blur-xs"
    >
      <div className="flex w-full max-w-sm flex-col items-center gap-3 rounded-xl border border-border bg-card px-6 py-7 text-center shadow-xl">
        <Loader2 className="size-6 animate-spin text-primary" />
        <div className="space-y-1">
          <div className="text-sm font-medium">Deleting {teamName}…</div>
          <p className="text-xs text-muted-foreground">
            Removing every conversation, contact, broadcast, and teammate. You'll
            be signed out as soon as this finishes.
          </p>
        </div>
      </div>
    </div>
  );
}

function UserRow({
  user,
  isSelf,
  actorRole,
  actorIsSuperAdmin = false,
  online,
  liveAvailability,
  liveNote,
  canManageAvailability,
  onAvailabilityChanged,
  onAvailabilityError,
  pending,
  onPatch,
  onDelete,
  onResetPassword,
}: {
  user: TeamUserRow;
  isSelf: boolean;
  actorRole: Role;
  actorIsSuperAdmin?: boolean;
  /** Has a live socket. Offline wins over any availability — see PresenceDot. */
  online: boolean;
  /** Live status/note from the socket; falls back to the SSR snapshot. */
  liveAvailability?: UserAvailabilityStatus;
  liveNote?: string;
  canManageAvailability: boolean;
  onAvailabilityChanged: () => void;
  onAvailabilityError: (message: string | null) => void;
  pending: boolean;
  onPatch: (body: { role?: Role; deactivated?: boolean }) => void;
  onDelete: () => void;
  onResetPassword: () => void;
}) {
  const editable = canManageUsers(actorRole) && canModifyUser({ role: actorRole, isSuperAdmin: actorIsSuperAdmin }, { role: user.role, isSuperAdmin: user.isSuperAdmin ?? false });
  // Live socket value wins; the SSR snapshot is the fallback for the first
  // paint (and for a member the sparse presence map omits, i.e. the default
  // "available, no note").
  const status: UserAvailabilityStatus = liveAvailability ?? user.availabilityStatus;
  const note = liveNote ?? user.availabilityMessage ?? "";
  const options = useMemo(() => {
    const set = new Set<Role>(assignableRoles({ role: actorRole, isSuperAdmin: actorIsSuperAdmin }));
    set.add(user.role);
    return Array.from(set);
  }, [actorRole, actorIsSuperAdmin, user.role]);

  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <Avatar className="size-8">
        {user.avatarUrl ? <AvatarImage src={user.avatarUrl} alt={user.name} /> : null}
        <AvatarFallback seed={user.id} className="text-2xs">{initials(user.name)}</AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{user.name}</span>
          {isSelf && (
            <Badge variant="muted" className="px-1.5 py-0 text-3xs">
              you
            </Badge>
          )}
          {user.isSuperAdmin && (
            <Badge
              variant="muted"
              className="flex items-center gap-1 px-1.5 py-0 text-3xs text-primary"
            >
              <ShieldAlert className="size-3" />
              super
            </Badge>
          )}
          {user.deactivated && (
            <Badge variant="muted" className="px-1.5 py-0 text-3xs text-destructive">
              disabled
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2 truncate text-2xs text-muted-foreground">
          <span className="truncate">{user.email}</span>
          {!user.deactivated && (
            <>
              <span aria-hidden className="text-muted-foreground/40">
                ·
              </span>
              <span className="flex shrink-0 items-center gap-1.5">
                {/* The shared dot, so this page can't drift from the sidebar /
                    assignment dropdown: a teammate with no live socket reads as
                    Offline regardless of the status stored on their row. */}
                <PresenceDot online={online} availability={status} className="size-2" />
                <span className="truncate">
                  {online
                    ? note || AVAILABILITY_LABELS[status]
                    : AVAILABILITY_LABELS.offline}
                  {online && user.availabilitySource === "admin" && " · set by an admin"}
                </span>
              </span>
            </>
          )}
        </div>
      </div>
      {/* Actions: `shrink-0` so this cluster can never steal width from the
          identity column again. Five equal-weight buttons per row squeezed the
          name/email/status until the status truncated to "Appear o" and emails
          vanished entirely — the row was all chrome and no information.

          Kept inline: role (you read it at a glance down the column) and
          availability (one icon; admins use it to cover for someone who left
          without switching off). Everything else — disable, reset password,
          delete — is rare, per-person and destructive, so it belongs behind an
          overflow menu rather than repeated seven times down the page. */}
      <div className="flex shrink-0 items-center justify-end gap-1.5">
        {canManageAvailability && !user.deactivated && (
          <MemberAvailabilityMenu
            user={user}
            disabled={pending}
            onChanged={onAvailabilityChanged}
            onError={onAvailabilityError}
          />
        )}
        {editable && !isSelf ? (
          <Select
            value={user.role}
            disabled={pending}
            onChange={(e) => onPatch({ role: e.target.value as Role })}
            className="h-8 pl-2 pr-7 text-xs"
            wrapperClassName="w-28"
            aria-label={`Role for ${user.name || user.email}`}
          >
            {options.map((r) => (
              <option key={r} value={r}>
                {roleLabel(r)}
              </option>
            ))}
          </Select>
        ) : (
          <Badge variant="muted" className="px-2 py-0.5 text-3xs uppercase tracking-wider">
            {roleLabel(user.role)}
          </Badge>
        )}
        {editable && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="size-8 shrink-0"
                disabled={pending}
                aria-label={`More actions for ${user.name || user.email}`}
              >
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuItem
                disabled={pending || isSelf}
                onSelect={() => onPatch({ deactivated: !user.deactivated })}
              >
                {user.deactivated ? (
                  <>
                    <UserCheck className="size-3.5" />
                    Re-enable account
                  </>
                ) : (
                  <>
                    <UserX className="size-3.5" />
                    Disable sign-in
                  </>
                )}
              </DropdownMenuItem>
              {!isSelf && (
                <DropdownMenuItem disabled={pending} onSelect={onResetPassword}>
                  <KeyRound className="size-3.5" />
                  Reset password
                </DropdownMenuItem>
              )}
              {!isSelf && (
                <>
                  {/* Separated, per the menu guidance — an irreversible delete
                      should never sit flush against routine actions. */}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    disabled={pending}
                    className="text-destructive focus:text-destructive"
                    onSelect={onDelete}
                  >
                    <Trash2 className="size-3.5" />
                    Delete permanently
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </li>
  );
}

function DangerZone({
  teamName,
  pending,
  onDeleteOrg,
}: {
  teamName: string;
  pending: boolean;
  onDeleteOrg: () => void;
}) {
  return (
    <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-5">
      <div className="mb-1 text-sm font-medium text-destructive">Danger zone</div>
      <p className="text-xs text-muted-foreground">
        Deleting <span className="font-medium text-foreground">{teamName}</span>{" "}
        permanently removes the organization, every teammate account, every
        conversation, every contact, every broadcast, every automation, and
        every uploaded file. The WhatsApp connection is dropped. This action
        cannot be undone.
      </p>
      <div className="mt-3">
        <Button
          type="button"
          variant="outline"
          disabled={pending}
          className="border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
          onClick={onDeleteOrg}
        >
          <Trash2 className="size-3.5" />
          Delete organization
        </Button>
      </div>
    </div>
  );
}

function OrgNameCard({
  currentName,
  onRename,
}: {
  currentName: string;
  onRename: (next: string) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState(currentName);
  const [saving, setSaving] = useState(false);
  // Keep the draft in sync if the live name changes elsewhere (another tab
  // saved, another admin renamed). Only resets while the user isn't actively
  // editing — i.e. draft equals the previous live value.
  useEffect(() => {
    // The prev-vs-new comparison lives inside the updater, so the effect only
    // needs `currentName` as a dep — the user's typing (local `draft` state)
    // must not re-trigger this sync.
    setDraft((prev) => (prev === currentName ? prev : currentName));
  }, [currentName]);

  const trimmed = draft.trim();
  const isDirty = trimmed !== currentName && trimmed.length > 0;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!isDirty || saving) return;
    setSaving(true);
    const ok = await onRename(trimmed);
    setSaving(false);
    if (!ok) setDraft(currentName); // server rejected — snap back
  }

  return (
    <form onSubmit={submit} className="rounded-xl border border-border bg-card p-5">
      <div className="mb-4 flex items-center gap-2">
        <ShieldAlert className="size-4 text-primary" />
        <div className="text-sm font-medium">Organization name</div>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_140px]">
        <Input
          name="name"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          maxLength={200}
          placeholder="Organization name"
          aria-label="Organization name"
          required
        />
        <Button type="submit" disabled={!isDirty || saving}>
          {saving ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
          Save
        </Button>
      </div>
      <p className="mt-2 text-2xs text-muted-foreground">
        Shown in the sidebar and at the top of every page. Changes appear live for every teammate.
      </p>
    </form>
  );
}

function InviteCard({
  assignableRoles,
  pending,
  onSubmit,
}: {
  assignableRoles: Role[];
  pending: boolean;
  onSubmit: (form: FormData) => void;
}) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const form = new FormData(e.currentTarget);
        onSubmit(form);
        e.currentTarget.reset();
      }}
      className="rounded-xl border border-border bg-card p-5"
    >
      <div className="mb-4 flex items-center gap-2">
        <UserPlus className="size-4 text-primary" />
        <div className="text-sm font-medium">Invite a teammate</div>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_180px_140px]">
        <Input
          name="email"
          type="email"
          placeholder="email@company.com"
          aria-label="Teammate email"
          required
        />
        <Select name="role" defaultValue="agent" aria-label="Teammate role">
          {assignableRoles.map((r) => (
            <option key={r} value={r}>
              {roleLabel(r)}
            </option>
          ))}
        </Select>
        <Button type="submit" disabled={pending}>
          {pending ? <Loader2 className="size-4 animate-spin" /> : <UserPlus className="size-4" />}
          Generate link
        </Button>
      </div>
      <p className="mt-2 text-2xs text-muted-foreground">
        Re-inviting the same email replaces the previous link. Links expire after 7 days.
      </p>
    </form>
  );
}

function InviteLinkCard({
  invite,
  onClose,
}: {
  invite: InviteResult;
  onClose: () => void;
}) {
  async function copy() {
    try {
      await navigator.clipboard.writeText(invite.url);
      toast.success("Invite link copied");
    } catch {
      // Older browsers / non-https — user can copy manually from the input.
      toast.error("Couldn't copy", { description: "Use the input field above to copy manually." });
    }
  }

  return (
    <div className="rounded-xl border border-primary/30 bg-primary/5 p-5">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-medium text-foreground">Invite ready</div>
          <div className="mt-0.5 text-2xs text-muted-foreground">
            Share this link with <span className="font-medium">{invite.email}</span>. It expires{" "}
            <LocalTime iso={invite.expiresAt} format="localeDate" />.
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-2xs text-muted-foreground hover:text-foreground"
        >
          Dismiss
        </button>
      </div>
      <div className="flex gap-2">
        <Input readOnly value={invite.url} className="font-mono text-xs" />
        <Button type="button" variant="outline" onClick={copy}>
          <Copy className="size-3.5" />
          Copy
        </Button>
      </div>
    </div>
  );
}

/**
 * Pending invites panel. Only shown to admins (filtered by the caller) and
 * only when there's at least one invite to show. Each row carries the
 * invited email, role, who created it + when, when it expires, and a
 * Revoke button that DELETEs the invite.
 *
 * Empty-state collapsing is intentional: a panel saying "0 pending invites"
 * adds noise without information. When the list re-fills (admin sends a
 * new invite, or a teammate accepts and the list shrinks to 0), the
 * server-component refetch toggles visibility.
 */
function PendingInvitesCard({
  invites,
  pending,
  onRevoke,
}: {
  invites: PendingInviteRow[];
  pending: boolean;
  onRevoke: (id: string, email: string) => void;
}) {
  return (
    <div className="rounded-xl border border-border bg-card">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <Mail className="size-4 text-muted-foreground" />
          <div className="text-sm font-medium">
            Pending invites ({invites.length})
          </div>
        </div>
        <div className="text-2xs text-muted-foreground">
          Invite links expire after 7 days.
        </div>
      </div>
      <ul className="divide-y divide-border">
        {invites.map((inv) => (
          <li key={inv.id} className="flex items-center gap-3 px-4 py-2.5">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm">{inv.email}</span>
                <Badge variant="muted" className="px-1.5 py-0 text-3xs uppercase tracking-wider">
                  {roleLabel(inv.role)}
                </Badge>
              </div>
              <div className="text-2xs text-muted-foreground">
                Invited by {inv.createdByName} · expires{" "}
                <LocalTime iso={inv.expiresAt} format="localeDate" />
              </div>
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={pending}
              title="Revoke this invite link"
              className="text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={() => onRevoke(inv.id, inv.email)}
            >
              <X className="size-3.5" />
              Revoke
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Org-default working hours. Off by default: a team with no schedule keeps the
 * purely-manual availability it always had, so this card starts as an
 * explicit opt-in rather than a pre-filled grid nobody asked for.
 */
function OrgWorkHoursCard({
  initial,
  onSaved,
  onError,
}: {
  initial: WorkHours | null;
  onSaved: () => void;
  onError: (message: string | null) => void;
}) {
  const [enabled, setEnabled] = useState(initial !== null);
  const [value, setValue] = useState<WorkHours>(initial ?? defaultWorkHours());
  const [saving, setSaving] = useState(false);

  async function save(next: WorkHours | null) {
    setSaving(true);
    onError(null);
    try {
      const res = await apiFetch("/api/workspace/work-hours", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workHours: next }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        onError(data.error ?? "Failed to save working hours");
        return;
      }
      toast.success(next ? "Working hours saved" : "Working hours turned off");
      // The server re-resolves every member's availability on save, so the
      // roster rows (status dots) need re-reading.
      onSaved();
    } catch {
      onError("Network error — try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-xl border border-border">
      <div className="flex items-start justify-between gap-4 border-b border-border px-4 py-3">
        <div>
          <div className="text-sm font-medium">Working hours</div>
          <div className="text-2xs text-muted-foreground">
            Members show as away outside these hours and are skipped by round-robin —
            no one has to remember to switch off at the end of the day.
          </div>
        </div>
        <Switch
          checked={enabled}
          disabled={saving}
          aria-label="Enable org working hours"
          onCheckedChange={(next) => {
            setEnabled(next);
            // Turning OFF saves immediately (it's one unambiguous action).
            // Turning ON only reveals the grid — an admin should review the
            // default Mon–Fri 9–17 before it starts moving people around.
            if (!next) void save(null);
          }}
        />
      </div>
      {enabled && (
        <div className="space-y-4 px-4 py-4">
          <WorkHoursEditor value={value} onChange={setValue} disabled={saving} />
          <div className="flex justify-end">
            <Button type="button" size="sm" disabled={saving} onClick={() => void save(value)}>
              {saving && <Loader2 className="size-3.5 animate-spin" />}
              Save working hours
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Per-member availability controls for a supervisor: set their status now,
 * hand them back to their schedule, or edit which schedule they're on.
 *
 * The status actions are NOT optimistic — the resulting effective status
 * depends on the member's schedule (setting "available" while they're off shift
 * still resolves through the server rule), so the row re-reads instead of
 * guessing.
 */
function MemberAvailabilityMenu({
  user,
  disabled,
  onChanged,
  onError,
}: {
  user: TeamUserRow;
  disabled: boolean;
  onChanged: () => void;
  onError: (message: string | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [hoursOpen, setHoursOpen] = useState(false);

  async function patch(body: Record<string, unknown>) {
    setBusy(true);
    onError(null);
    try {
      const res = await apiFetch(`/api/users/${user.id}/availability`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        onError(data.error ?? "Failed to update availability");
        return;
      }
      onChanged();
    } catch {
      onError("Network error — try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-8 shrink-0"
            disabled={disabled || busy}
            title={`Set ${user.name || "this member"}'s availability`}
            // Icon-only: the label was the widest thing in the row and the
            // action is self-evident from the clock + tooltip. aria-label keeps
            // it announced for screen readers.
            aria-label={`Set ${user.name || "this member"}'s availability`}
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Clock className="size-4" />}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuLabel>Set status</DropdownMenuLabel>
          {ALL_AVAILABILITY_STATUSES.map((s) => (
            <DropdownMenuItem key={s} onSelect={() => void patch({ status: s })}>
              <span
                aria-hidden
                className={cn("size-2.5 rounded-full", AVAILABILITY_DOT_CLASSES[s])}
              />
              {AVAILABILITY_LABELS[s]}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            // Only meaningful while something is overriding the schedule;
            // shown always so its absence isn't mistaken for "no schedule".
            onSelect={() => void patch({ followSchedule: true })}
          >
            <CalendarClock className="size-3.5" />
            Follow their schedule
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setHoursOpen(true)}>
            <SettingsIcon className="size-3.5" />
            Working hours…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {hoursOpen && (
        <MemberWorkHoursDialog
          user={user}
          onClose={() => setHoursOpen(false)}
          onSaved={() => {
            setHoursOpen(false);
            onChanged();
          }}
          onError={onError}
        />
      )}
    </>
  );
}

/**
 * Per-member schedule editor. Loads the member's own config on open rather
 * than carrying every member's JSON grid in the roster payload (it would ride
 * along on every hot query that includes `assignedUser`).
 */
function MemberWorkHoursDialog({
  user,
  onClose,
  onSaved,
  onError,
}: {
  user: TeamUserRow;
  onClose: () => void;
  onSaved: () => void;
  onError: (message: string | null) => void;
}) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [mode, setMode] = useState<WorkHoursMode>(user.workHoursMode);
  const [value, setValue] = useState<WorkHours>(defaultWorkHours());
  const [teamHours, setTeamHours] = useState<WorkHours | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await apiFetch(`/api/users/${user.id}/work-hours`);
        if (!res.ok || !alive) return;
        const data = (await res.json()) as {
          mode?: string;
          workHours?: unknown;
          teamWorkHours?: unknown;
        };
        if (!alive) return;
        setMode((data.mode as WorkHoursMode) ?? "inherit");
        const own = asWorkHours(data.workHours);
        // Seed the grid from their own schedule, else the org one, else the
        // Mon–Fri default — so switching to "custom" starts from something
        // sensible instead of a blank week.
        setValue(own ?? asWorkHours(data.teamWorkHours) ?? defaultWorkHours());
        setTeamHours(asWorkHours(data.teamWorkHours));
      } catch {
        // Non-fatal: the dialog still works with the defaults above.
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [user.id]);

  async function save() {
    setSaving(true);
    onError(null);
    try {
      const res = await apiFetch(`/api/users/${user.id}/work-hours`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode,
          ...(mode === "custom" ? { workHours: value } : {}),
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        onError(data.error ?? "Failed to save working hours");
        return;
      }
      toast.success("Working hours saved");
      onSaved();
    } catch {
      onError("Network error — try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onClose={onClose}>
      <DialogContent className="max-w-2xl" ariaLabel={`Working hours for ${user.name}`}>
        <div className="border-b border-border px-5 py-4">
          <div className="text-sm font-medium">Working hours · {user.name}</div>
          <div className="text-2xs text-muted-foreground">
            Outside their hours they show as away and are skipped by round-robin.
          </div>
        </div>
        <div className="space-y-4 px-5 py-4">
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">Schedule</span>
            <Select
              value={mode}
              disabled={loading || saving}
              onChange={(e) => setMode(e.target.value as WorkHoursMode)}
              aria-label="Working hours mode"
            >
              <option value="inherit">
                Follow the org schedule{teamHours ? "" : " (none set)"}
              </option>
              <option value="custom">Custom schedule</option>
              <option value="off">No schedule — availability stays manual</option>
            </Select>
          </div>
          {mode === "custom" && !loading && (
            <WorkHoursEditor value={value} onChange={setValue} disabled={saving} />
          )}
          {mode === "inherit" && !teamHours && (
            <p className="text-xs text-muted-foreground">
              The org has no working hours set, so this member&apos;s availability stays
              manual until one is configured above.
            </p>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
          <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="button" size="sm" onClick={() => void save()} disabled={loading || saving}>
            {saving && <Loader2 className="size-3.5 animate-spin" />}
            Save
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
