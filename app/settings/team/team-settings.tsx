"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Check,
  Copy,
  Loader2,
  ShieldAlert,
  UserCheck,
  UserPlus,
  UserX,
} from "lucide-react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  assignableRoles,
  canManageUsers,
  canModifyUser,
  roleLabel,
} from "@/lib/auth/permissions";
import type { Role } from "@/lib/types";
import { initials } from "@/lib/utils";

export interface TeamUserRow {
  id: string;
  name: string;
  email: string;
  role: Role;
  deactivated: boolean;
  createdAt: string;
}

interface InviteResult {
  url: string;
  expiresAt: string;
  email: string;
}

export function TeamSettings({
  currentUserId,
  currentUserRole,
  users,
}: {
  currentUserId: string;
  currentUserRole: Role;
  users: TeamUserRow[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [lastInvite, setLastInvite] = useState<InviteResult | null>(null);

  const refresh = () => router.refresh();
  const canManage = canManageUsers(currentUserRole);
  const inviteRoles = useMemo(() => assignableRoles(currentUserRole), [currentUserRole]);

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
            />
          ))}
        </ul>
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
}: {
  user: TeamUserRow;
  isSelf: boolean;
  actorRole: Role;
  pending: boolean;
  onPatch: (body: { role?: Role; deactivated?: boolean }) => void;
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
        <AvatarFallback className="text-[11px]">{initials(user.name)}</AvatarFallback>
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
            className="h-8 rounded-md border border-input bg-transparent px-2 text-xs shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
      </div>
    </li>
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
          className="h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(invite.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Older browsers / non-https — user can copy manually from the input.
    }
  }

  return (
    <div className="rounded-xl border border-primary/30 bg-primary/5 p-5">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-medium text-foreground">Invite ready</div>
          <div className="mt-0.5 text-[11px] text-muted-foreground">
            Share this link with <span className="font-medium">{invite.email}</span>. It expires{" "}
            {new Date(invite.expiresAt).toLocaleDateString()}.
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
          {copied ? (
            <>
              <Check className="size-3.5" />
              Copied
            </>
          ) : (
            <>
              <Copy className="size-3.5" />
              Copy
            </>
          )}
        </Button>
      </div>
    </div>
  );
}
