"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Building2, Check, ChevronsUpDown, Loader2, Plus, Settings } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { apiFetch } from "@/lib/api/client-fetch";
import { toast } from "@/lib/toast";
import { cn } from "@ccp/shared/utils";

export interface WorkspaceOption {
  id: string;
  name: string;
  role: string;
}

/**
 * Workspace switcher in the app rail.
 *
 * ALWAYS rendered, even with a single workspace. Hiding it below two made the
 * whole org→workspace model invisible: there was no way to discover that
 * workspaces exist, let alone create a second one. The dropdown is where you
 * switch, and where an org admin creates the next one.
 *
 * Switching does a FULL page navigation rather than a client-side refresh, on
 * purpose: the active workspace is the tenant scope for every RSC query AND for
 * the Socket.io room the client is joined to. A soft refresh would leave the
 * existing socket attached to the old `ws:` room, so the new workspace's inbox
 * would render but receive another workspace's realtime frames (or none). A
 * reload re-runs the handshake, which re-resolves the workspace server-side.
 */
export function WorkspaceSwitcher({
  workspaces,
  activeWorkspaceId,
  organizationName,
  collapsed,
  children,
}: {
  workspaces: WorkspaceOption[];
  activeWorkspaceId: string;
  /** Shown as the dropdown's header so the hierarchy is legible at a glance. */
  organizationName: string;
  collapsed: boolean;
  /** The existing rail badge — reused verbatim as the dropdown trigger. */
  children: React.ReactNode;
}) {
  const [pending, startTransition] = useTransition();
  const [switchingTo, setSwitchingTo] = useState<string | null>(null);

  function switchTo(workspaceId: string) {
    if (workspaceId === activeWorkspaceId || pending) return;
    setSwitchingTo(workspaceId);
    startTransition(async () => {
      try {
        const res = await apiFetch("/api/workspaces/active", {
          method: "POST",
          // `apiFetch` does NOT set this. Without it Express's json parser
          // skips the body, the route sees `{}`, Zod rejects it, and the
          // switch 400s — which used to be swallowed silently below, so
          // clicking a workspace simply did nothing.
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ workspaceId }),
        });
        if (!res.ok) {
          // Never fail silently again: a dead menu item with no explanation is
          // the worst possible outcome for the one control that changes which
          // tenant you are looking at.
          const d = (await res.json().catch(() => ({}))) as {
            detail?: string;
            error?: string;
          };
          toast.error(d.detail || d.error || "Couldn't switch workspace");
          setSwitchingTo(null);
          return;
        }
        // Full reload — see the note above about the socket's `ws:` room.
        window.location.assign("/inbox");
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Couldn't switch workspace");
        setSwitchingTo(null);
      }
    });
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="relative w-full cursor-pointer rounded-xl text-left"
          aria-label="Switch workspace"
        >
          {children}
          {!collapsed && (
            <ChevronsUpDown
              aria-hidden
              className="pointer-events-none absolute right-2 top-1/2 size-3.5 -translate-y-1/2 text-primary-foreground/70"
            />
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="right" className="w-60">
        {/* Org first, then its workspaces — the dropdown IS the explanation of
            the hierarchy for anyone who has never seen it. */}
        <DropdownMenuLabel className="pb-0 text-3xs font-normal uppercase tracking-wide text-muted-foreground">
          Organization
        </DropdownMenuLabel>
        <DropdownMenuItem asChild>
          <Link href="/organization" className="flex items-center gap-2">
            <Building2 aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate font-medium">{organizationName}</span>
            <Settings aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="pb-0 text-3xs font-normal uppercase tracking-wide text-muted-foreground">
          Workspaces
        </DropdownMenuLabel>
        {workspaces.map((w) => {
          const active = w.id === activeWorkspaceId;
          return (
            <DropdownMenuItem
              key={w.id}
              onSelect={(e) => {
                e.preventDefault();
                switchTo(w.id);
              }}
              className={cn("flex items-center gap-2", active && "font-medium")}
            >
              <span className="flex size-5 shrink-0 items-center justify-center rounded bg-primary text-3xs font-bold text-primary-foreground">
                {w.name.charAt(0).toUpperCase()}
              </span>
              <span className="min-w-0 flex-1 truncate">{w.name}</span>
              {switchingTo === w.id ? (
                <Loader2 aria-hidden className="size-3.5 shrink-0 animate-spin" />
              ) : active ? (
                <Check aria-hidden className="size-3.5 shrink-0" />
              ) : null}
            </DropdownMenuItem>
          );
        })}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/organization" className="flex items-center gap-2 text-muted-foreground">
            <Plus aria-hidden className="size-4 shrink-0" />
            {/* Deliberately a LINK to Organization settings, not an inline
                create: naming a workspace is a decision, and the page it lands
                on is where you then add people to it. */}
            <span>New workspace</span>
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
