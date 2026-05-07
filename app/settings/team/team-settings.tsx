"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, UserPlus, UserX, UserCheck, ShieldAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { initials } from "@/lib/utils";
import {
  assignableRoles,
  canManageUsers,
  canModifyUser,
  roleLabel,
} from "@/lib/permissions";
import type { Role } from "@/lib/types";

export interface TeamUserRow {
  id: string;
  name: string;
  email: string;
  role: Role;
  deactivated: boolean;
  createdAt: string;
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

  const refresh = () => router.refresh();
  const canManage = canManageUsers(currentUserRole);
  const inviteRoles = useMemo(() => assignableRoles(currentUserRole), [currentUserRole]);

  async function inviteUser(form: FormData) {
    setError(null);
    const body = {
      name: form.get("name"),
      email: form.get("email"),
      role: form.get("role") || "agent",
      password: form.get("password"),
    };
    const res = await fetch("/api/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      setError(data.error ?? "Failed to invite user");
      return false;
    }
    return true;
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
            ? "Invite users, change roles, and disable accounts. New users sign in with the password you set here — they can change it from their account page."
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
              const ok = await inviteUser(form);
              if (ok) refresh();
            })
          }
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
  // Can the actor mutate this row at all?
  const editable = canManageUsers(actorRole) && canModifyUser(actorRole, user.role);
  // Roles available in the per-row select. We always include the user's
  // CURRENT role so the dropdown shows what they are even if the actor
  // can't normally assign it (e.g. an admin viewing a superAdmin).
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
        <div className="text-sm font-medium">Invite a new user</div>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1fr_160px]">
        <Input name="name" placeholder="Full name" required />
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
      </div>
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-[1fr_140px]">
        <Input
          name="password"
          type="text"
          placeholder="Temporary password (8+ chars)"
          minLength={8}
          required
        />
        <Button type="submit" disabled={pending}>
          {pending ? <Loader2 className="size-4 animate-spin" /> : <UserPlus className="size-4" />}
          Invite
        </Button>
      </div>
      <p className="mt-2 text-[11px] text-muted-foreground">
        Share the password securely. The user can change it from their account page after sign-in.
      </p>
    </form>
  );
}
