"use client";

import { useMemo, useState, useTransition } from "react";
import { Loader2, Plus, Search, SlidersHorizontal } from "lucide-react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/layouts/page-header";
import { apiFetch } from "@/lib/api/client-fetch";
import { useSoftRefresh } from "@/hooks/use-soft-refresh";
import { toast } from "@/lib/toast";
import type { OrganizationOverview } from "@/lib/api/queries";
import { initials } from "@ccp/shared/utils";

/** Roles a person can hold IN ONE WORKSPACE. `""` is "no access". */
const WORKSPACE_ROLES = [
  { value: "", label: "No access" },
  { value: "agent", label: "Agent" },
  { value: "manager", label: "Manager" },
  { value: "admin", label: "Admin" },
] as const;

export function OrgMembersClient({ overview }: { overview: OrganizationOverview }) {
  const refresh = useSoftRefresh();
  const [, startTransition] = useTransition();
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteWorkspaceId, setInviteWorkspaceId] = useState(
    overview.workspaces[0]?.id ?? "",
  );
  const [inviteRole, setInviteRole] = useState("agent");
  const [sending, setSending] = useState(false);

  const members = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q
      ? overview.members.filter(
          (m) => m.name.toLowerCase().includes(q) || m.email.toLowerCase().includes(q),
        )
      : overview.members;
  }, [overview.members, search]);

  const editingMember = overview.members.find((m) => m.id === editing) ?? null;

  async function setRole(workspaceId: string, userId: string, role: string) {
    setBusy(true);
    try {
      const res = await apiFetch(`/api/workspaces/${workspaceId}/members`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // "" is the "no access" option — the API takes an explicit null to mean
        // "remove", which is distinct from "leave unchanged".
        body: JSON.stringify({ userId, role: role || null }),
      });
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { detail?: string; error?: string };
        throw new Error(d.detail || d.error || "Couldn't change access");
      }
      startTransition(() => refresh());
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't change access");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Admin settings"
        description="Everyone in the organization. A person's role is set per workspace — they can be an admin in one and an agent in another."
      />

      <div className="flex flex-wrap items-center gap-2">
        {overview.canManage && (
          <Button size="sm" className="h-8 px-3 text-2xs" onClick={() => setInviting(true)}>
            <Plus aria-hidden className="mr-1 size-3.5" />
            Add user
          </Button>
        )}
        <p className="text-2xs text-muted-foreground">
          {/* A person always joins a WORKSPACE — there is no org-only member.
              The dialog therefore asks which one, and access to the rest is
              granted per-person below. */}
          New people join one workspace to start; give them the others here.
        </p>
        <div className="relative ml-auto">
          <Search
            aria-hidden
            className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search people"
            className="h-8 w-56 pl-7 text-xs"
          />
        </div>
      </div>

      <ul className="flex flex-col gap-1.5">
        {members.map((m) => (
          <li
            key={m.id}
            className="flex items-center gap-3 rounded-xl border bg-card px-4 py-3"
          >
            <Avatar className="size-9 shrink-0">
              {m.avatarUrl && <AvatarImage src={m.avatarUrl} alt="" />}
              <AvatarFallback className="text-2xs">{initials(m.name)}</AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="truncate text-sm font-medium">{m.name}</span>
                {m.orgRole !== "member" && (
                  <Badge variant="muted" className="px-1.5 py-0 text-3xs capitalize">
                    Org {m.orgRole}
                  </Badge>
                )}
                {!m.isActive && (
                  <Badge variant="muted" className="px-1.5 py-0 text-3xs">
                    Deactivated
                  </Badge>
                )}
              </div>
              <div className="truncate text-2xs text-muted-foreground">
                {m.email}
                {m.memberships.length > 0 && (
                  <>
                    {" · "}
                    {m.memberships.length} workspace
                    {m.memberships.length === 1 ? "" : "s"}
                  </>
                )}
              </div>
            </div>
            {overview.canManage && (
              <Button
                size="sm"
                variant="outline"
                className="h-8 shrink-0 px-2 text-2xs"
                onClick={() => setEditing(m.id)}
              >
                <SlidersHorizontal aria-hidden className="mr-1 size-3.5" />
                Workspace access
              </Button>
            )}
          </li>
        ))}
        {members.length === 0 && (
          <li className="rounded-xl border bg-card px-4 py-8 text-center text-2xs text-muted-foreground">
            Nobody matches “{search}”.
          </li>
        )}
      </ul>

      <Dialog open={inviting} onClose={() => setInviting(false)}>
        <DialogContent className="w-full max-w-md p-5" ariaLabel="Add user">
          <h2 className="text-base font-semibold">Add user</h2>
          <p className="mt-1 text-2xs text-muted-foreground">
            They get an email invite. Pick the workspace they start in and their role
            there — you can grant access to other workspaces once they accept.
          </p>
          <form
            className="mt-4 flex flex-col gap-3"
            onSubmit={async (e) => {
              e.preventDefault();
              const email = inviteEmail.trim();
              if (!email || !inviteWorkspaceId) return;
              setSending(true);
              try {
                const res = await apiFetch("/api/invites", {
                  method: "POST",
                  body: JSON.stringify({
                    email,
                    role: inviteRole,
                    workspaceId: inviteWorkspaceId,
                  }),
                });
                if (!res.ok) {
                  const d = (await res.json().catch(() => ({}))) as {
                    detail?: string;
                    error?: string;
                  };
                  throw new Error(d.detail || d.error || "Couldn't send the invite");
                }
                toast.success(`Invite sent to ${email}`);
                setInviteEmail("");
                setInviting(false);
                startTransition(() => refresh());
              } catch (err) {
                toast.error(err instanceof Error ? err.message : "Couldn't send the invite");
              } finally {
                setSending(false);
              }
            }}
          >
            <label className="flex flex-col gap-1">
              <span className="text-2xs font-medium">Email address</span>
              <Input
                autoFocus
                type="email"
                required
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                placeholder="teammate@company.com"
                className="h-9 text-sm"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-2xs font-medium">Workspace</span>
              <select
                value={inviteWorkspaceId}
                onChange={(e) => setInviteWorkspaceId(e.target.value)}
                className="h-9 rounded-md border bg-background px-2 text-sm"
              >
                {overview.workspaces.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-2xs font-medium">Role in that workspace</span>
              <select
                value={inviteRole}
                onChange={(e) => setInviteRole(e.target.value)}
                className="h-9 rounded-md border bg-background px-2 text-sm"
              >
                <option value="agent">Agent</option>
                <option value="manager">Manager</option>
                <option value="admin">Admin</option>
              </select>
            </label>
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-8 px-3 text-2xs"
                onClick={() => setInviting(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                size="sm"
                className="h-8 px-3 text-2xs"
                disabled={sending || !inviteEmail.trim()}
              >
                {sending ? <Loader2 aria-hidden className="size-3.5 animate-spin" /> : "Send invite"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={editingMember !== null} onClose={() => setEditing(null)}>
        <DialogContent className="w-full max-w-md p-5" ariaLabel="Workspace access">
          <h2 className="text-base font-semibold">Workspace access</h2>
          <p className="mt-1 text-2xs text-muted-foreground">
            {editingMember?.name} — one role per workspace.
          </p>
          <ul className="mt-4 flex flex-col gap-2">
            {overview.workspaces.map((w) => {
              const current =
                editingMember?.memberships.find((x) => x.workspaceId === w.id)?.role ?? "";
              return (
                <li key={w.id} className="flex items-center gap-2">
                  <span className="flex size-6 shrink-0 items-center justify-center rounded bg-muted text-3xs font-bold">
                    {w.name.charAt(0).toUpperCase()}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-xs">{w.name}</span>
                  <select
                    value={current}
                    disabled={busy || !editingMember}
                    onChange={(e) => {
                      if (editingMember) void setRole(w.id, editingMember.id, e.target.value);
                    }}
                    className="h-8 w-32 shrink-0 rounded-md border bg-background px-1.5 text-2xs"
                  >
                    {WORKSPACE_ROLES.map((r) => (
                      <option key={r.value} value={r.value}>
                        {r.label}
                      </option>
                    ))}
                  </select>
                </li>
              );
            })}
          </ul>
          <div className="mt-4 flex items-center justify-end gap-2">
            {busy && <Loader2 aria-hidden className="size-4 animate-spin text-muted-foreground" />}
            <Button
              size="sm"
              variant="ghost"
              className="h-8 px-3 text-2xs"
              onClick={() => setEditing(null)}
            >
              Done
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
