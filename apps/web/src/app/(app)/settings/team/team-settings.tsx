"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useLiveTeamName } from "@/hooks/use-live-team-name";
import { useSoftRefresh } from "@/hooks/use-soft-refresh";
import {
  Check,
  Copy,
  Loader2,
  Mail,
  ShieldAlert,
  Trash2,
  UserCheck,
  UserPlus,
  UserX,
  X,
} from "lucide-react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { broadcastSignout } from "@/lib/auth/auth-broadcast";
import { closeClientSocket, dispatchLocalSocketEvent } from "@/lib/socket-client";
import { toast } from "@/lib/toast";
import {
  assignableRoles,
  canManageUsers,
  canModifyUser,
  roleLabel,
} from "@ccp/shared/auth/permissions";
import type { Role } from "@ccp/shared/types";
import { initials } from "@ccp/shared/utils";
import { LocalTime } from "@/components/local-time";

export interface TeamUserRow {
  id: string;
  name: string;
  email: string;
  role: Role;
  deactivated: boolean;
  createdAt: string;
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
  teamName,
  users,
  pendingInvites,
}: {
  currentUserId: string;
  currentUserRole: Role;
  teamName: string;
  users: TeamUserRow[];
  /** Empty for non-admins (they can't see this panel). */
  pendingInvites: PendingInviteRow[];
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
  // Live team name — listens to `team:renamed` so the input + delete dialog
  // + danger-zone copy stay in sync with what this tab just dispatched OR
  // with another admin's rename on a different tab/device.
  const liveTeamName = useLiveTeamName(teamName);
  const { confirm, confirmDialog } = useConfirm();

  const refresh = softRefresh;
  const canManage = canManageUsers(currentUserRole);
  const inviteRoles = useMemo(() => assignableRoles(currentUserRole), [currentUserRole]);
  // Org-delete is admin/superAdmin only — same gate as user-management.
  const canDeleteOrg = canManage;

  async function createInvite(form: FormData) {
    setError(null);
    const body = {
      email: form.get("email"),
      role: form.get("role") || "agent",
    };
    const res = await fetch("/api/invites", {
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
    const res = await fetch(`/api/users/${id}`, {
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
      const res = await fetch(`/api/users/${id}`, { method: "DELETE" });
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
      const res = await fetch(`/api/invites/${id}`, { method: "DELETE" });
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
      teamId: "", // listener doesn't filter by id (only one team per session)
      name: trimmed,
      renamedByUserId: currentUserId,
    });

    const res = await fetch("/api/team", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: trimmed }),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      setError(data.error ?? "Failed to rename organization");
      // Roll the optimistic patch back to the server-truth name.
      dispatchLocalSocketEvent("team:renamed", {
        teamId: "",
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
    });
    if (!ok) return;
    setDeletingOrg(true);
    // Drop the socket BEFORE the fetch so the connection banner never gets a
    // chance to flash "Reconnecting…" between the server-side socket kick
    // (api/team DELETE → disconnectUserSockets) and the /logout hard nav.
    // The flag inside closeClientSocket also suppresses the banner across
    // the rest of this teardown. Broadcast first so every other tab in this
    // browser tears down in parallel, not after their own next 401.
    broadcastSignout();
    closeClientSocket();
    const res = await fetch("/api/team", { method: "DELETE" });
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
  }

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Team</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {canManage
            ? "Generate an invite link for each teammate. They set their own password when they accept."
            : "Read-only view. Only admins can invite users or change roles."}
        </p>
      </div>

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
            <div className="text-[11px] text-muted-foreground">
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
              pending={pending}
              onPatch={(body) =>
                startTransition(async () => {
                  await patchUser(u.id, body);
                  refresh();
                })
              }
              onDelete={() => {
                void confirmDeleteUser(u.id, u.name);
              }}
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
          <p className="text-[12px] text-muted-foreground">
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
  pending,
  onPatch,
  onDelete,
}: {
  user: TeamUserRow;
  isSelf: boolean;
  actorRole: Role;
  pending: boolean;
  onPatch: (body: { role?: Role; deactivated?: boolean }) => void;
  onDelete: () => void;
}) {
  const editable = canManageUsers(actorRole) && canModifyUser(actorRole, user.role);
  const options = useMemo(() => {
    const set = new Set<Role>(assignableRoles(actorRole));
    set.add(user.role);
    return Array.from(set);
  }, [actorRole, user.role]);

  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <Avatar className="size-8">
        <AvatarFallback seed={user.id} className="text-[11px]">{initials(user.name)}</AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{user.name}</span>
          {isSelf && (
            <Badge variant="muted" className="px-1.5 py-0 text-[10px]">
              you
            </Badge>
          )}
          {user.role === "superAdmin" && (
            <Badge
              variant="muted"
              className="flex items-center gap-1 px-1.5 py-0 text-[10px] text-primary"
            >
              <ShieldAlert className="size-3" />
              super
            </Badge>
          )}
          {user.deactivated && (
            <Badge variant="muted" className="px-1.5 py-0 text-[10px] text-destructive">
              disabled
            </Badge>
          )}
        </div>
        <div className="truncate text-[11px] text-muted-foreground">{user.email}</div>
      </div>
      <div className="flex items-center gap-2">
        {editable && !isSelf ? (
          <select
            value={user.role}
            disabled={pending}
            onChange={(e) => onPatch({ role: e.target.value as Role })}
            className="h-8 rounded-md border border-input bg-transparent px-2 text-xs shadow-xs focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
          >
            {options.map((r) => (
              <option key={r} value={r}>
                {roleLabel(r)}
              </option>
            ))}
          </select>
        ) : (
          <Badge variant="muted" className="px-2 py-0.5 text-[10px] uppercase tracking-wider">
            {roleLabel(user.role)}
          </Badge>
        )}
        {editable && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={pending || isSelf}
            title={
              isSelf
                ? "You can't deactivate yourself"
                : user.deactivated
                  ? "Re-enable this account"
                  : "Disable sign-in for this account"
            }
            onClick={() => onPatch({ deactivated: !user.deactivated })}
          >
            {user.deactivated ? (
              <>
                <UserCheck className="size-3.5" />
                Re-enable
              </>
            ) : (
              <>
                <UserX className="size-3.5" />
                Disable
              </>
            )}
          </Button>
        )}
        {editable && !isSelf && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={pending}
            title="Permanently remove this account"
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            onClick={onDelete}
          >
            <Trash2 className="size-3.5" />
            Delete
          </Button>
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
      <p className="text-[12px] text-muted-foreground">
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
    setDraft((prev) => (prev === currentName ? prev : currentName));
    // intentional: we want the prev-vs-new comparison driven by currentName
    // changes only, not by the user's typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      <p className="mt-2 text-[11px] text-muted-foreground">
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
        <Input name="email" type="email" placeholder="email@company.com" required />
        <select
          name="role"
          defaultValue="agent"
          className="h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
        >
          {assignableRoles.map((r) => (
            <option key={r} value={r}>
              {roleLabel(r)}
            </option>
          ))}
        </select>
        <Button type="submit" disabled={pending}>
          {pending ? <Loader2 className="size-4 animate-spin" /> : <UserPlus className="size-4" />}
          Generate link
        </Button>
      </div>
      <p className="mt-2 text-[11px] text-muted-foreground">
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
          <div className="mt-0.5 text-[11px] text-muted-foreground">
            Share this link with <span className="font-medium">{invite.email}</span>. It expires{" "}
            <LocalTime iso={invite.expiresAt} format="localeDate" />.
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-[11px] text-muted-foreground hover:text-foreground"
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
        <div className="text-[11px] text-muted-foreground">
          Invite links expire after 7 days.
        </div>
      </div>
      <ul className="divide-y divide-border">
        {invites.map((inv) => (
          <li key={inv.id} className="flex items-center gap-3 px-4 py-2.5">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm">{inv.email}</span>
                <Badge variant="muted" className="px-1.5 py-0 text-[10px] uppercase tracking-wider">
                  {roleLabel(inv.role)}
                </Badge>
              </div>
              <div className="text-[11px] text-muted-foreground">
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
