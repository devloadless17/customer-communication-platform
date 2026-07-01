"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { getClientSocket } from "@/lib/socket-client";
import { apiFetch } from "@/lib/api/client-fetch";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ChevronLeft,
  ChevronRight,
  ContactRound,
  Inbox,
  LogOut,
  type LucideIcon,
  Megaphone,
  MessageSquareText,
  Settings as SettingsIcon,
  Workflow,
} from "lucide-react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useSignOutOverlay } from "@/components/auth/signout-overlay";
import { useLiveTeamName } from "@/hooks/use-live-team-name";
import { canManageUsers, roleLabel } from "@ccp/shared/auth/permissions";
import {
  AVAILABILITY_DOT_CLASSES,
  AVAILABILITY_LABELS,
  resolveAvailabilityStatus,
} from "@ccp/shared/presence";
import { cn, initials } from "@ccp/shared/utils";
import type { Team, User, UserAvailabilityStatus } from "@ccp/shared/types";
import { AvailabilityPicker } from "./availability-picker";

const STORAGE_KEY = "app-rail-collapsed";

/**
 * Team-wide UNREAD total for the Inbox nav badge. Seeds with one cheap fetch on
 * mount, then debounce-refetches on the socket events that change unread
 * (message:new bumps it, conversation:read clears a thread, status close drops
 * a thread out of the non-closed sum). Authoritative server count — no
 * client-side delta accounting — so it can't drift. Best-effort: a failed fetch
 * just leaves the badge as-is (it's informational chrome, never blocks).
 */
function useInboxUnread(): number {
  const [unread, setUnread] = useState(0);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const refetch = async () => {
      try {
        const res = await apiFetch("/api/conversations/unread-count");
        if (!res.ok) return;
        const json = (await res.json()) as { unread?: unknown };
        if (alive && typeof json.unread === "number") setUnread(json.unread);
      } catch {
        // nav badge is best-effort — ignore transient fetch failures
      }
    };
    const debounced = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void refetch(), 400);
    };
    void refetch();
    const socket = getClientSocket();
    socket.on("message:new", debounced);
    socket.on("conversation:read", debounced);
    socket.on("conversation:status", debounced);
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      socket.off("message:new", debounced);
      socket.off("conversation:read", debounced);
      socket.off("conversation:status", debounced);
    };
  }, []);
  return unread;
}

const EXPANDED_WIDTH = 232;
const COLLAPSED_WIDTH = 64;

/**
 * Far-left main navigation rail.
 *
 * Collapsible: 232px (icons + labels) ↔ 64px (icons only).
 * State persisted in localStorage. Width animates via CSS transition on the
 * inline `width` style; `overflow: hidden` clips labels during the animation
 * so they never wrap or push content. Labels are rendered unconditionally with
 * `whitespace-nowrap` — the shrinking container clips them without any
 * conditional render thrash during the transition.
 *
 * On first render the width is derived from localStorage so there's no
 * animated jump. On SSR the fallback is expanded (false) which is safe since
 * the rail is desktop-only (`md:flex`).
 */
interface RailItem {
  href: string;
  label: string;
  icon: LucideIcon;
  match?: string[];
}

const PRIMARY_ITEMS: RailItem[] = [
  { href: "/inbox", label: "Inbox", icon: Inbox },
  { href: "/team", label: "Team chat", icon: MessageSquareText },
  { href: "/contacts", label: "Contacts", icon: ContactRound },
  {
    href: "/broadcasts",
    label: "Broadcasts",
    icon: Megaphone,
    match: ["/templates", "/broadcasts/groups"],
  },
];

// Workflows is admin-only: GET /api/team/workflows is @RequireRole("admin")
// and the page redirects non-admins (workflows/page.tsx). Surfacing the rail
// icon to agents/managers would resolve to a permanent "failed to load" error
// boundary — appended only when the user can actually use it.
const WORKFLOWS_ITEM: RailItem = {
  href: "/workflows",
  label: "Workflows",
  icon: Workflow,
};

export function AppRail({
  currentUser,
  team,
  connected,
  onlineUserIds,
  canManageAvailability,
  initialCollapsed,
}: {
  currentUser: User;
  team: Team;
  connected?: boolean;
  onlineUserIds?: Set<string>;
  /** Resolved `availability:manage` capability. When false the picker is
   *  shown read-only so the user still sees their status but can't change it. */
  canManageAvailability: boolean;
  /** Server-read cookie value so SSR renders the persisted state (no flash). */
  initialCollapsed: boolean;
}) {
  const pathname = usePathname() ?? "";
  const inboxUnread = useInboxUnread();
  const isOnline = onlineUserIds?.has(currentUser.id) ?? false;
  const hasPresence = onlineUserIds !== undefined;
  // Live mirror of THIS user's availability. Seeded from the session payload
  // (so the first paint reflects the persisted status), then updated by the
  // picker's local dispatch + cross-tab/device server frames. Drives the dot
  // color on the avatar so a "busy/away" pick shows immediately in the same
  // frame as the menu state.
  const [liveAvailability, setLiveAvailability] = useState(() => ({
    status: resolveAvailabilityStatus(currentUser.availabilityStatus),
    message: currentUser.availabilityMessage ?? null,
  }));
  useEffect(() => {
    const socket = getClientSocket();
    const handler: Parameters<
      typeof socket.on<"user:availability:updated">
    >[1] = (payload) => {
      if (payload.userId !== currentUser.id) return;
      setLiveAvailability((prev) => ({
        status: payload.status,
        message:
          payload.message === undefined ? prev.message : payload.message,
      }));
    };
    socket.on("user:availability:updated", handler);
    return () => {
      socket.off("user:availability:updated", handler);
    };
  }, [currentUser.id]);
  // Live org name — patches in place on `team:renamed` (this tab's
  // optimistic dispatch or another admin's rename) without a router refresh.
  const teamName = useLiveTeamName(team.name);

  // Initial state comes from the server-read cookie (`initialCollapsed`), so
  // SSR and the first client render agree — no expand→collapse flash on load.
  // Toggling writes the cookie (below) so the next server render is correct.
  const [collapsed, setCollapsed] = useState<boolean>(initialCollapsed);

  // Labels render conditionally: hide immediately on collapse, show after a
  // short delay on expand so the width animation has time to start first.
  const [showLabels, setShowLabels] = useState<boolean>(!collapsed);
  const labelTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Transition guard: skip the CSS transition on the very first mount so
  // that restoring a collapsed state from localStorage is instantaneous
  // rather than an animated jump on page load.
  const [transitionEnabled, setTransitionEnabled] = useState(false);
  useEffect(() => {
    // Enable transition on the next frame after mount
    const raf = requestAnimationFrame(() => setTransitionEnabled(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  function toggleCollapsed() {
    const next = !collapsed;
    setCollapsed(next);
    // Persist as a cookie (not localStorage) so the SERVER layout can read it
    // and SSR the correct state on the next load — that's what kills the flash.
    document.cookie = `${STORAGE_KEY}=${String(next)}; path=/; max-age=31536000; samesite=lax`;

    if (labelTimerRef.current) clearTimeout(labelTimerRef.current);

    if (next) {
      // Collapsing: hide labels immediately so they don't clip awkwardly
      setShowLabels(false);
    } else {
      // Expanding: wait for the width animation to start (100ms) before
      // fading labels in — prevents labels from appearing in a 64px rail
      labelTimerRef.current = setTimeout(() => setShowLabels(true), 110);
    }
  }

  const canManageWorkflows = canManageUsers(currentUser.role);
  const items = useMemo<RailItem[]>(() => {
    const out = [...PRIMARY_ITEMS];
    // Workflows is admin-only — see WORKFLOWS_ITEM. Appended right after the
    // primary items (its prior position) so the layout is unchanged for admins.
    if (canManageWorkflows) out.push(WORKFLOWS_ITEM);
    out.push({
      href: "/settings",
      label: "Settings",
      icon: SettingsIcon,
      match: ["/settings", "/settings/workspace"],
    });
    // No platform-admin entry here: super-admins are redirected out of the
    // (app) shell entirely (→ /platform), so they never render this rail.
    return out;
  }, [canManageWorkflows]);

  const railStyle: React.CSSProperties = {
    width: collapsed ? COLLAPSED_WIDTH : EXPANDED_WIDTH,
    transition: transitionEnabled
      ? "width 250ms cubic-bezier(0.4, 0, 0.2, 1)"
      : "none",
  };

  return (
    <aside
      id="app-rail"
      className="hidden h-svh shrink-0 flex-col overflow-hidden border-r border-sidebar-border bg-sidebar py-3 text-sidebar-foreground md:flex"
      style={railStyle}
    >
      {/* ── Team badge ────────────────────────────────────────────────────── */}
      <div className={cn("px-3 mb-1", collapsed && "flex justify-center")}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Link
              href="/inbox"
              className={cn(
                "relative flex items-center rounded-xl bg-primary text-primary-foreground shadow-sm transition-opacity hover:opacity-90 active:opacity-80",
                collapsed
                  ? "size-9 justify-center"
                  : "h-9 w-full gap-2.5 px-2.5",
              )}
              aria-label={teamName}
            >
              <span className="shrink-0 text-sm font-bold leading-none">
                {teamName.charAt(0).toUpperCase()}
              </span>
              <span
                className="truncate text-sm font-semibold whitespace-nowrap"
                style={{
                  opacity: showLabels ? 1 : 0,
                  transition: "opacity 120ms ease",
                  width: showLabels ? undefined : 0,
                  overflow: "hidden",
                }}
              >
                {teamName}
              </span>
              {connected !== undefined && (
                <span
                  className={cn(
                    "absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full ring-2 ring-sidebar transition-colors",
                    connected ? "bg-success-fg" : "bg-muted-foreground/40",
                  )}
                  aria-label={connected ? "Realtime connected" : "Realtime disconnected"}
                />
              )}
            </Link>
          </TooltipTrigger>
          {collapsed && <TooltipContent side="right">{teamName}</TooltipContent>}
        </Tooltip>
      </div>

      <div className={cn("my-2 h-px bg-sidebar-border", collapsed ? "mx-3" : "mx-4")} />

      {/* ── Primary nav ───────────────────────────────────────────────────── */}
      <nav aria-label="Primary navigation" className="flex flex-1 flex-col gap-0.5 px-2">
        {items.map((item) => (
          <RailLink
            key={item.href}
            item={item}
            pathname={pathname}
            collapsed={collapsed}
            showLabels={showLabels}
            badge={item.href === "/inbox" ? inboxUnread : 0}
          />
        ))}
      </nav>

      {/* ── Footer ────────────────────────────────────────────────────────── */}
      <div
        className={cn(
          "mt-2 flex flex-col gap-0.5 border-t border-sidebar-border pt-2 px-2",
        )}
      >
        {/* Collapse / expand toggle */}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={toggleCollapsed}
              className={cn(
                "flex h-9 w-full items-center rounded-lg text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground active:scale-[0.97]",
                collapsed ? "justify-center" : "gap-2.5 px-2.5",
              )}
              aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              aria-expanded={!collapsed}
              aria-controls="app-rail"
            >
              {collapsed ? (
                <ChevronRight className="size-4 shrink-0" />
              ) : (
                <>
                  <ChevronLeft className="size-4 shrink-0" />
                  {showLabels && (
                    <span
                      className="whitespace-nowrap text-sm"
                      style={{ opacity: showLabels ? 1 : 0, transition: "opacity 120ms ease" }}
                    >
                      Collapse
                    </span>
                  )}
                </>
              )}
            </button>
          </TooltipTrigger>
          {collapsed && (
            <TooltipContent side="right">Expand sidebar</TooltipContent>
          )}
        </Tooltip>

        {/* User menu */}
        <UserMenu
          currentUser={currentUser}
          collapsed={collapsed}
          canManageAvailability={canManageAvailability}
          liveStatus={liveAvailability.status}
          liveMessage={liveAvailability.message}
        >
          <button
            type="button"
            className={cn(
              "group flex h-9 w-full cursor-pointer items-center rounded-lg transition-colors hover:bg-accent/60",
              collapsed ? "justify-center" : "gap-2 px-2",
            )}
            aria-label="Open account menu"
          >
            <div className="relative shrink-0">
              <Avatar className="size-7 ring-1 ring-sidebar-border transition-shadow group-hover:ring-foreground/20">
                {currentUser.avatarUrl ? (
                  <AvatarImage src={currentUser.avatarUrl} alt={currentUser.name} />
                ) : null}
                <AvatarFallback seed={currentUser.id} className="text-3xs">
                  {initials(currentUser.name)}
                </AvatarFallback>
              </Avatar>
              {hasPresence && (
                <span
                  className={cn(
                    "absolute -bottom-0.5 -right-0.5 size-2 rounded-full ring-2 ring-sidebar transition-colors",
                    // Offline overrides everything: a user who picked "Appear
                    // offline" must look identical to one with no socket. Then
                    // the availability badge color when online; fallback to
                    // emerald (available) otherwise.
                    isOnline
                      ? AVAILABILITY_DOT_CLASSES[liveAvailability.status]
                      : AVAILABILITY_DOT_CLASSES.offline,
                  )}
                  aria-label={
                    isOnline
                      ? AVAILABILITY_LABELS[liveAvailability.status]
                      : "Offline"
                  }
                />
              )}
            </div>
            {showLabels && (
              <div
                className="min-w-0 flex-1 overflow-hidden text-left"
                style={{ opacity: showLabels ? 1 : 0, transition: "opacity 120ms ease" }}
              >
                <p className="truncate text-sm font-medium leading-tight text-sidebar-foreground whitespace-nowrap">
                  {currentUser.name}
                </p>
                <p className="truncate text-2xs leading-tight text-muted-foreground whitespace-nowrap">
                  {roleLabel(currentUser.role)}
                </p>
              </div>
            )}
          </button>
        </UserMenu>
      </div>
    </aside>
  );
}

function RailLink({
  item,
  pathname,
  collapsed,
  showLabels,
  badge = 0,
}: {
  item: RailItem;
  pathname: string;
  collapsed: boolean;
  showLabels: boolean;
  /** Unread count to surface as a small pill (Inbox only today). 0 = hidden. */
  badge?: number;
}) {
  const { href, label, icon: Icon, match } = item;
  const matchAll = useMemo(() => [href, ...(match ?? [])], [href, match]);
  const active = matchAll.some(
    (p) => pathname === p || pathname.startsWith(p + "/"),
  );
  const hasBadge = badge > 0;
  const badgeText = badge > 99 ? "99+" : String(badge);

  const link = (
    <Link
      href={href}
      className={cn(
        "group relative flex h-9 w-full items-center rounded-lg transition-colors",
        collapsed ? "justify-center" : "gap-2.5 px-2.5",
        active
          ? "bg-primary/10 text-primary"
          : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
      )}
      aria-current={active ? "page" : undefined}
      aria-label={hasBadge ? `${label} (${badge} unread)` : label}
    >
      <span className="relative shrink-0">
        <Icon className="size-4.5" />
        {/* Collapsed: a tiny count pill anchored to the icon's top-right so it
            reads as "unread on Inbox" even with no label. ring-sidebar lifts it
            off the icon. */}
        {hasBadge && collapsed && (
          <span className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1 text-3xs font-semibold leading-none text-primary-foreground ring-2 ring-sidebar">
            {badgeText}
          </span>
        )}
      </span>
      {showLabels && (
        <span
          className="truncate text-sm whitespace-nowrap"
          style={{ opacity: showLabels ? 1 : 0, transition: "opacity 120ms ease" }}
        >
          {label}
        </span>
      )}
      {/* Expanded: the count sits at the row's right edge, past the label. */}
      {hasBadge && showLabels && (
        <span className="ml-auto flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-2xs font-semibold leading-none text-primary-foreground">
          {badgeText}
        </span>
      )}
      {/* Active indicator — a bolder bar pinned to the inner left edge of the
          rail. The 4px width + rounded-r-md reads as deliberate (Linear-style)
          vs. the prior hairline. The collapsed state stays legible via the
          icon's own text-primary fill (active branch above). */}
      {active && (
        <span className="absolute -left-2 top-1.5 h-6 w-1 rounded-r-md bg-primary" />
      )}
    </Link>
  );

  if (collapsed) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{link}</TooltipTrigger>
        <TooltipContent side="right">{label}</TooltipContent>
      </Tooltip>
    );
  }

  return link;
}

function UserMenu({
  currentUser,
  collapsed,
  canManageAvailability,
  liveStatus,
  liveMessage,
  children,
}: {
  currentUser: User;
  collapsed: boolean;
  canManageAvailability: boolean;
  liveStatus: UserAvailabilityStatus;
  liveMessage: string | null;
  children: React.ReactNode;
}) {
  const { trigger: signOut, overlay } = useSignOutOverlay();
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          side={collapsed ? "right" : "top"}
          className="w-72"
        >
          <DropdownMenuLabel>
            <div className="flex flex-col">
              <span className="text-sm font-medium">{currentUser.name}</span>
              <span className="text-2xs font-normal text-muted-foreground">
                {currentUser.email}
              </span>
              <span className="mt-0.5 text-3xs font-normal text-muted-foreground/80">
                {roleLabel(currentUser.role)}
              </span>
            </div>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          {/* Availability picker (busy/away/appear-offline + optional note).
              Read-only when the user lacks `availability:manage` — the dot
              still shows the persisted status so they can see it, they just
              can't change it. The server endpoint @RequireCapability is the
              real enforcement; this disabled-state is UX. */}
          <AvailabilityPicker
            currentUser={currentUser}
            disabled={!canManageAvailability}
            seedStatus={liveStatus}
            seedMessage={liveMessage}
          />
          <DropdownMenuSeparator />
          {/* One Settings entry → the single grouped /settings landing. (Was
              two items, "Account settings" + "Workspace settings", pointing at
              two different landings — read as three separate settings areas.) */}
          <DropdownMenuItem asChild>
            <Link href="/settings">
              <SettingsIcon className="size-4 text-muted-foreground" />
              Settings
            </Link>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={(e) => {
              e.preventDefault();
              signOut();
            }}
          >
            <LogOut className="size-4 text-muted-foreground" />
            Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {overlay}
    </>
  );
}
