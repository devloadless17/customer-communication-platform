"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ContactRound,
  Flag,
  Inbox,
  LogOut,
  type LucideIcon,
  Megaphone,
  MessageSquareText,
  Menu,
  Settings as SettingsIcon,
  Ticket as TicketIcon,
  UserCircle2,
  BarChart3,
  Workflow,
} from "lucide-react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Sheet } from "@/components/ui/sheet";
import { AvailabilityPicker } from "@/components/layouts/availability-picker";
import { MobileSubSidebarProvider } from "@/components/layouts/sub-sidebar";
import { useSignOutOverlay } from "@/components/auth/signout-overlay";
import { useLiveTeamName } from "@/hooks/use-live-team-name";
import { getClientSocket } from "@/lib/socket-client";
import { standingLabel } from "@ccp/shared/auth/permissions";
import { resolveAvailabilityStatus } from "@ccp/shared/presence";
import { cn, initials } from "@ccp/shared/utils";
import type { Team, User } from "@ccp/shared/types";

/**
 * Fired by descendants (e.g. the team-chat channel header on mobile) to open
 * the shell's nav drawer — which carries the section sub-sidebar (channel
 * list, filters). Decoupled via a window event so the drawer's open state
 * doesn't have to thread through a context across the server-component shell
 * boundary (SectionShell renders the chrome + page content as siblings).
 */
const OPEN_MOBILE_NAV_EVENT = "ccp:open-mobile-nav";

export function openMobileNav() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(OPEN_MOBILE_NAV_EVENT));
  }
}

/**
 * Mobile chrome shared by every authenticated section. On desktop (md+)
 * the AppRail and SubSidebar live as fixed columns and this whole tree
 * is `hidden`. Below md, the columns disappear and this renders:
 *
 *   - A sticky top bar with a hamburger trigger + section title.
 *   - A left-slide Sheet containing the primary section nav AND the
 *     section's contextual sub-sidebar (passed in via `subSidebar`).
 *
 * NOTE: this is `md:hidden` (full-width top bar only below md) by design. In
 * the 768–1023 tablet band the section sub-nav is already reachable: the (app)
 * shell wraps the section in `md:flex-row` and the SubSidebar shows as a
 * `md:flex` desktop column there, so this top bar (which a `md:flex-row` parent
 * would otherwise squeeze into a narrow vertical strip) is intentionally hidden
 * once the md+ column takes over.
 *
 * Section title is derived from the pathname so we don't have to thread
 * it from every layout. The trigger lives inside the same component so
 * we don't need a context to wire the button → drawer state.
 */

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  match?: string[];
}

// Same list, same order, as the desktop AppRail's PRIMARY_ITEMS — the rail is
// `md:flex`, so anything missing here is unreachable on a phone rather than
// merely inconvenient. Flags and Tickets were absent, which hid both surfaces
// entirely below md.
const PRIMARY_ITEMS: NavItem[] = [
  { href: "/inbox", label: "Inbox", icon: Inbox },
  { href: "/team", label: "Team chat", icon: MessageSquareText },
  { href: "/contacts", label: "Contacts", icon: ContactRound },
  { href: "/flags", label: "Flagged", icon: Flag },
  { href: "/tickets", label: "Tickets", icon: TicketIcon },
  {
    href: "/broadcasts",
    label: "Broadcasts",
    icon: Megaphone,
    match: ["/templates", "/broadcasts/groups"],
  },
];

// Workflows is admin-only — same gate as the desktop AppRail (the page
// redirects non-admins and GET /api/workspace/workflows is @RequireRole("admin")).
// Hardcoding it for everyone made non-admins tap it and bounce; appended
// conditionally below via the `canManageWorkflows` prop.
const WORKFLOWS_ITEM: NavItem = {
  href: "/workflows",
  label: "Workflows",
  icon: Workflow,
};

// Reports mirrors the desktop AppRail's `teamActivity:view` gate.
const REPORTS_ITEM: NavItem = {
  href: "/reports",
  label: "Reports",
  icon: BarChart3,
};

function sectionTitle(pathname: string): string {
  if (pathname.startsWith("/inbox")) return "Inbox";
  if (pathname.startsWith("/team")) return "Team chat";
  if (pathname.startsWith("/contacts")) return "Contacts";
  if (pathname.startsWith("/flags")) return "Flagged";
  if (pathname.startsWith("/tickets")) return "Tickets";
  if (pathname.startsWith("/broadcasts")) return "Broadcasts";
  if (pathname.startsWith("/templates")) return "Templates";
  if (pathname.startsWith("/workflows")) return "Workflows";
  if (pathname.startsWith("/reports")) return "Reports";
  if (pathname.startsWith("/settings")) return "Settings";
  return "";
}

export function MobileShellChrome({
  currentUser,
  team,
  canManageAvailability,
  canManageWorkflows,
  canViewReports,
  restrictedViewer = false,
  subSidebar,
  /** Override the auto-derived section title (rare). */
  title,
  /** Extra slot rendered at the right of the mobile header (filter button, etc). */
  rightSlot,
}: {
  currentUser: User;
  team: Team;
  /** Resolved `availability:manage` capability. Drives whether the
   *  AvailabilityPicker in the drawer footer is interactive or read-only.
   *  The server endpoint @RequireCapability is the real enforcement. */
  canManageAvailability: boolean;
  /** Whether to surface the admin-only Workflows nav item. Mirrors the
   *  desktop AppRail gate — non-admins tapping it would bounce off the
   *  redirect in workflows/page.tsx. */
  canManageWorkflows: boolean;
  /** Resolved `teamActivity:view` capability — surfaces the Reports item,
   *  mirroring the desktop AppRail gate. */
  canViewReports: boolean;
  /** Agent limited to assigned conversations — hides Broadcasts, mirroring
   *  the desktop AppRail (the API denies them wholesale). */
  restrictedViewer?: boolean;
  subSidebar?: ReactNode;
  title?: string;
  rightSlot?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname() ?? "";
  // Same signout overlay used by the desktop AppRail — masks the blank
  // window between the /logout hard nav and /login painting.
  const { trigger: signOut, overlay: signOutOverlay } = useSignOutOverlay();
  // Live org name — patches in place on `team:renamed`.
  const teamName = useLiveTeamName(team.name);

  // Live mirror of THIS user's availability so the picker survives a drawer
  // close→reopen (the Sheet unmounts its content on close, re-seeding the
  // picker). Same pattern as the desktop AppRail. Seeded from the session
  // payload, kept current by the picker's own local dispatch + cross-device
  // frames — so the reopened picker shows the last saved value, not the stale
  // SSR `currentUser`.
  const [liveAvailability, setLiveAvailability] = useState(() => ({
    status: resolveAvailabilityStatus(currentUser.availabilityStatus),
    message: currentUser.availabilityMessage ?? null,
    // Schedule provenance, so the picker can explain an automatic status.
    source: currentUser.availabilitySource ?? "manual",
    until: currentUser.availabilityUntil ?? null,
  }));
  useEffect(() => {
    const socket = getClientSocket();
    const handler: Parameters<
      typeof socket.on<"user:availability:updated">
    >[1] = (payload) => {
      if (payload.userId !== currentUser.id) return;
      setLiveAvailability((prev) => ({
        status: payload.status,
        message: payload.message === undefined ? prev.message : payload.message,
        source: payload.source === undefined ? prev.source : payload.source,
        until: payload.until === undefined ? prev.until : payload.until,
      }));
    };
    socket.on("user:availability:updated", handler);
    return () => {
      socket.off("user:availability:updated", handler);
    };
  }, [currentUser.id]);

  // Close the drawer when the route changes — without this, navigating
  // via a drawer link leaves it open over the new page.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // Open on the cross-tree signal (e.g. the channel header's mobile "browse
  // channels" button, which lives in a sibling subtree).
  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener(OPEN_MOBILE_NAV_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_MOBILE_NAV_EVENT, onOpen);
  }, []);

  const items = useMemo<NavItem[]>(() => {
    // Same gate as the desktop rail: the Broadcasts API denies restricted
    // viewers wholesale, so the entry would be a guaranteed 403.
    const out = restrictedViewer
      ? PRIMARY_ITEMS.filter((i) => i.href !== "/broadcasts")
      : [...PRIMARY_ITEMS];
    // Same order as the desktop rail: Reports beside the analytics surfaces.
    if (canViewReports) out.push(REPORTS_ITEM);
    // Workflows is admin-only — appended after the primary items (its prior
    // position) so the order is unchanged for admins, hidden for everyone else.
    if (canManageWorkflows) out.push(WORKFLOWS_ITEM);
    out.push({
      href: "/settings",
      label: "Settings",
      icon: SettingsIcon,
      match: ["/settings", "/settings/workspace"],
    });
    // No platform-admin entry: super-admins are redirected out of the (app)
    // shell entirely (→ /platform in the (app) layout), so they never render
    // this chrome. The old `/admin` push here was dead + unreachable.
    return out;
  }, [canManageWorkflows, canViewReports, restrictedViewer]);

  const resolvedTitle = title ?? sectionTitle(pathname);

  return (
    <>
      <header className="sticky top-0 z-30 flex h-12 items-center gap-1.5 border-b border-border bg-background/95 px-2 backdrop-blur md:hidden">
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Open navigation"
          aria-expanded={open}
          aria-controls="mobile-nav-drawer"
          className="inline-flex size-9 cursor-pointer items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 active:scale-[0.95]"
        >
          <Menu className="size-5" />
        </button>
        <h1 className="truncate text-sm font-semibold">{resolvedTitle}</h1>
        <div className="ml-auto flex items-center gap-1">{rightSlot}</div>
      </header>

      <Sheet
        open={open}
        onOpenChange={setOpen}
        side="left"
        contentClassName="w-70 max-w-[85vw]"
        labelledBy="mobile-nav-team-name"
        hideCloseButton
      >
        <div id="mobile-nav-drawer" className="flex h-full flex-col">
          {/* Team header */}
          <div className="flex items-center gap-3 border-b border-border px-4 py-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <span className="text-sm font-semibold">
                {teamName.charAt(0).toUpperCase()}
              </span>
            </div>
            <div className="min-w-0 flex-1">
              {/* id is the dialog's aria-labelledby target (Sheet labelledBy). */}
              <div id="mobile-nav-team-name" className="truncate text-sm font-medium">
                {teamName}
              </div>
              <div className="truncate text-2xs text-muted-foreground">
                {currentUser.name} · {standingLabel(currentUser.role, currentUser.orgRole)}
              </div>
            </div>
          </div>

          {/* Primary nav */}
          <nav aria-label="Primary navigation" className="flex flex-col gap-0.5 px-2 py-2">
            {items.map((item) => (
              <MobileNavLink
                key={item.href}
                item={item}
                pathname={pathname}
              />
            ))}
          </nav>

          {/* Optional sub-sidebar content (filters, channel list, etc.).
              The provider tells the inner SubSidebar shell to render in
              drawer mode (full-width, no h-svh). */}
          {subSidebar && (
            <div className="min-h-0 flex-1 overflow-y-auto border-t border-border">
              <MobileSubSidebarProvider>{subSidebar}</MobileSubSidebarProvider>
            </div>
          )}

          {/* Footer */}
          <div className="mt-auto border-t border-border p-2">
            <div className="flex items-center gap-2 px-2 py-1.5">
              <Avatar className="size-7">
                {currentUser.avatarUrl ? (
                  <AvatarImage src={currentUser.avatarUrl} alt={currentUser.name} />
                ) : null}
                <AvatarFallback seed={currentUser.id} className="text-3xs">
                  {initials(currentUser.name)}
                </AvatarFallback>
              </Avatar>
              <div className="min-w-0 flex-1 text-2xs text-muted-foreground">
                <div className="truncate text-foreground">{currentUser.name}</div>
                <div className="truncate">{currentUser.email}</div>
              </div>
            </div>
            {/* Availability picker — same component the desktop AppRail uses.
                Without it, mobile agents had no way to mark themselves
                busy/away/offline at all. Read-only when the user lacks
                `availability:manage`; the server endpoint @RequireCapability
                is the real gate. */}
            <div className="mt-1 border-t border-border pt-1">
              <AvailabilityPicker
                currentUser={currentUser}
                disabled={!canManageAvailability}
                seedStatus={liveAvailability.status}
                seedMessage={liveAvailability.message}
                seedSource={liveAvailability.source}
                seedUntil={liveAvailability.until}
              />
            </div>
            <div className="mt-1 flex flex-col gap-0.5 border-t border-border pt-1">
              <Link
                href="/account"
                className="flex h-8 items-center gap-2 rounded-md px-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <UserCircle2 className="size-4" />
                Account
              </Link>
              <button
                type="button"
                onClick={signOut}
                className="flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 text-left text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <LogOut className="size-4" />
                Sign out
              </button>
            </div>
          </div>
        </div>
      </Sheet>
      {signOutOverlay}
    </>
  );
}

function MobileNavLink({
  item,
  pathname,
}: {
  item: NavItem;
  pathname: string;
}) {
  const matchAll = [item.href, ...(item.match ?? [])];
  const active = matchAll.some(
    (p) => pathname === p || pathname.startsWith(p + "/"),
  );
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      className={cn(
        "flex h-9 items-center gap-2.5 rounded-md px-2.5 text-sm transition-colors",
        active
          ? "bg-accent text-accent-foreground font-medium"
          : "text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
      aria-current={active ? "page" : undefined}
    >
      <Icon className={cn("size-4 shrink-0", active && "text-primary")} />
      <span className="flex-1 truncate">{item.label}</span>
    </Link>
  );
}
