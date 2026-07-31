"use client";

import { useMemo, useState, useTransition } from "react";
import { ArrowRightLeft, Loader2, MoreVertical, Pencil, Plus, Search, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { LocalTime } from "@/components/local-time";
import { PageHeader } from "@/components/layouts/page-header";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { apiFetch } from "@/lib/api/client-fetch";
import { useSoftRefresh } from "@/hooks/use-soft-refresh";
import { toast } from "@/lib/toast";
import type { OrganizationOverview } from "@/lib/api/queries";

/**
 * Workspaces table.
 *
 * "Open" does a FULL page navigation, not a client refresh: the active
 * workspace is the tenant scope for every RSC query AND the Socket.io room the
 * client is joined to. A soft refresh would leave the socket in the old `ws:`
 * room, so the new workspace's inbox would render while receiving another
 * workspace's realtime frames.
 */
export function WorkspacesClient({ overview }: { overview: OrganizationOverview }) {
  const refresh = useSoftRefresh();
  const { confirm, confirmDialog } = useConfirm();
  const [, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [search, setSearch] = useState("");

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q
      ? overview.workspaces.filter((w) => w.name.toLowerCase().includes(q))
      : overview.workspaces;
  }, [overview.workspaces, search]);

  const call = async (path: string, init: RequestInit): Promise<boolean> => {
    try {
      const res = await apiFetch(path, {
        headers: { "content-type": "application/json" },
        ...init,
      });
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { detail?: string; error?: string };
        throw new Error(d.detail || d.error || "Couldn't save");
      }
      startTransition(() => refresh());
      return true;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't save");
      return false;
    }
  };

  async function open(workspaceId: string) {
    setBusyId(workspaceId);
    const res = await apiFetch("/api/workspaces/active", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId }),
    });
    if (!res.ok) {
      setBusyId(null);
      toast.error("Couldn't switch to that workspace");
      return;
    }
    // Full reload — see the note above about the socket's `ws:` room.
    window.location.assign("/inbox");
  }

  return (
    <div className="flex flex-col gap-5">
      {confirmDialog}
      <PageHeader
        title="Workspaces"
        description="Each workspace is a separate inbox: its own channels, contacts and conversations. Nothing is shared except the people you put in both."
      />

      <div className="flex flex-wrap items-center gap-2">
        {overview.canManage && (
          <Button size="sm" className="h-8 px-3 text-2xs" onClick={() => setAdding(true)}>
            <Plus aria-hidden className="mr-1 size-3.5" />
            Add workspace
          </Button>
        )}
        <div className="relative ml-auto">
          <Search
            aria-hidden
            className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search workspaces"
            className="h-8 w-56 pl-7 text-xs"
          />
        </div>
      </div>

      <div className="overflow-x-auto rounded-xl border bg-card">
        <table className="w-full min-w-[42rem] text-sm">
          <thead>
            <tr className="border-b text-left text-2xs uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-2 font-medium">Name</th>
              <th className="px-4 py-2 font-medium">Members</th>
              <th className="px-4 py-2 font-medium">Conversations</th>
              <th className="px-4 py-2 font-medium">Channels</th>
              <th className="px-4 py-2 font-medium">Created</th>
              <th className="w-10 px-4 py-2" />
            </tr>
          </thead>
          <tbody>
            {rows.map((w) => (
              <tr key={w.id} className="border-b last:border-0">
                <td className="px-4 py-2.5">
                  <div className="flex items-center gap-2">
                    <span className="flex size-6 shrink-0 items-center justify-center rounded bg-muted text-3xs font-bold">
                      {w.name.charAt(0).toUpperCase()}
                    </span>
                    <button
                      type="button"
                      disabled={!w.joined || busyId === w.id}
                      onClick={() => void open(w.id)}
                      className="truncate font-medium enabled:hover:underline disabled:cursor-default"
                    >
                      {w.name}
                    </button>
                    {busyId === w.id && (
                      <Loader2 aria-hidden className="size-3.5 shrink-0 animate-spin" />
                    )}
                    {!w.joined && (
                      // Honest rather than hidden: an org member who isn't in a
                      // workspace should see it exists and know why it won't open.
                      <Badge variant="muted" className="shrink-0 px-1.5 py-0 text-3xs">
                        No access
                      </Badge>
                    )}
                  </div>
                </td>
                <td className="px-4 py-2.5 tabular-nums">{w.memberCount}</td>
                <td className="px-4 py-2.5 tabular-nums">{w.conversationCount}</td>
                <td className="px-4 py-2.5 tabular-nums">{w.channelAccountCount}</td>
                <td className="px-4 py-2.5 text-2xs text-muted-foreground">
                  <LocalTime iso={w.createdAt} format="shortDate" />
                </td>
                <td className="px-4 py-2.5">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button size="sm" variant="ghost" className="size-7 p-0">
                        <MoreVertical aria-hidden className="size-4" />
                        <span className="sr-only">Actions for {w.name}</span>
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-44">
                      {w.joined && (
                        <DropdownMenuItem onSelect={() => void open(w.id)}>
                          <ArrowRightLeft aria-hidden className="mr-2 size-3.5" />
                          Open workspace
                        </DropdownMenuItem>
                      )}
                      {overview.canManage && (
                        <DropdownMenuItem
                          onSelect={() => setEditing({ id: w.id, name: w.name })}
                        >
                          <Pencil aria-hidden className="mr-2 size-3.5" />
                          Rename
                        </DropdownMenuItem>
                      )}
                      {overview.canManage && overview.workspaces.length > 1 && (
                        <DropdownMenuItem
                          className="text-destructive"
                          onSelect={async () => {
                            const ok = await confirm({
                              title: `Delete “${w.name}”?`,
                              // Name the blast radius precisely. This is the
                              // most destructive action in the product and
                              // there is no undo.
                              description:
                                `This permanently deletes the workspace and everything in it — ` +
                                `${w.conversationCount} conversation(s), its contacts, messages, tickets, ` +
                                `broadcasts and ${w.channelAccountCount} connected channel account(s). ` +
                                `This cannot be undone.`,
                              confirmLabel: "Delete workspace",
                              destructive: true,
                              // Proportional friction: type the name to proceed.
                              requireText: w.name,
                              requireTextLabel: (
                                <>
                                  Type <strong>{w.name}</strong> to confirm
                                </>
                              ),
                            });
                            if (ok) {
                              await call(`/api/workspaces/${w.id}`, { method: "DELETE" });
                            }
                          }}
                        >
                          <Trash2 aria-hidden className="mr-2 size-3.5" />
                          Delete
                        </DropdownMenuItem>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-2xs text-muted-foreground">
                  No workspaces match “{search}”.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Add workspace */}
      <Dialog open={adding} onClose={() => setAdding(false)}>
        <DialogContent className="w-full max-w-md p-5" ariaLabel="Add workspace">
          <h2 className="text-base font-semibold">Add workspace</h2>
          <p className="mt-1 text-2xs text-muted-foreground">
            A new workspace starts empty — its own channels, contacts and conversations,
            with a starter pipeline and a #general channel. You&apos;ll be its first admin.
          </p>
          <form
            className="mt-4 flex flex-col gap-3"
            onSubmit={async (e) => {
              e.preventDefault();
              const name = newName.trim();
              if (!name) return;
              setCreating(true);
              const ok = await call("/api/workspaces", {
                method: "POST",
                body: JSON.stringify({ name }),
              });
              setCreating(false);
              if (ok) {
                setNewName("");
                setAdding(false);
              }
            }}
          >
            <label className="flex flex-col gap-1">
              <span className="text-2xs font-medium">Workspace name</span>
              <Input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g. Support EU"
                maxLength={60}
                className="h-9 text-sm"
              />
            </label>
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-8 px-3 text-2xs"
                onClick={() => setAdding(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                size="sm"
                className="h-8 px-3 text-2xs"
                disabled={creating || !newName.trim()}
              >
                {creating ? <Loader2 aria-hidden className="size-3.5 animate-spin" /> : "Create"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* Rename */}
      <Dialog open={editing !== null} onClose={() => setEditing(null)}>
        <DialogContent className="w-full max-w-md p-5" ariaLabel="Rename workspace">
          <h2 className="text-base font-semibold">Rename workspace</h2>
          <form
            className="mt-4 flex flex-col gap-3"
            onSubmit={async (e) => {
              e.preventDefault();
              if (!editing) return;
              const name = editing.name.trim();
              if (!name) return;
              const ok = await call(`/api/workspaces/${editing.id}`, {
                method: "PATCH",
                body: JSON.stringify({ name }),
              });
              if (ok) setEditing(null);
            }}
          >
            <Input
              autoFocus
              value={editing?.name ?? ""}
              onChange={(e) =>
                setEditing((prev) => (prev ? { ...prev, name: e.target.value } : prev))
              }
              maxLength={60}
              className="h-9 text-sm"
              aria-label="Workspace name"
            />
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-8 px-3 text-2xs"
                onClick={() => setEditing(null)}
              >
                Cancel
              </Button>
              <Button type="submit" size="sm" className="h-8 px-3 text-2xs">
                Save
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
