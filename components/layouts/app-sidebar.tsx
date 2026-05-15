"use client";

import { useMemo, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ContactRound,
  FileText,
  Inbox,
  LogOut,
  type LucideIcon,
  Megaphone,
  MessageSquareText,
  Settings as SettingsIcon,
  ShieldCheck,
  Sparkles,
  UserCircle2,
  Users2,
  Zap,
} from "lucide-react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { roleLabel } from "@/lib/auth/permissions";
import { closeClientSocket } from "@/lib/socket/client";
import { cn, initials } from "@/lib/utils";
import type { Team, User } from "@/lib/types";

/**
 * App-wide left sidebar. Used by every authenticated area (inbox, contacts,
 * broadcasts, templates, automations, settings, admin) so users see the same
 * shell on every page.
 *
 * Items are grouped into labeled sections — "Conversations / Contacts /
 * Outreach / Workspace / Account" — so related navigation lives together.
 * Sections that need elevated permissions (Workspace, Platform admin) hide
 * for users who can't act on them; the rest of the sidebar stays identical
 * across roles to avoid the "sidebar moves around" feeling.
 *
 * The inbox is the only area that needs more than a plain link: it wants the
 * preset filters (All/Mine/Unassigned/Closed) and the stages selector. Those
 * render via the `inboxControls` slot, nested directly under the Inbox row,
 * but only when /inbox is the active route. On other pages, Inbox is just a
 * single link — the slot is empty so the sidebar height doesn't jump.
 *
 * Presence dots and the WhatsApp connection indicator are only meaningful
 * once the Socket.io connection is up, which today only happens inside the
 * inbox. They're optional props; when omitted the sidebar gracefully drops
 * the dot rather than showing a stale "offline" badge.
 */

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

// Snippets and Stages live in /settings now (the team-settings landing page).
// They're configuration, not day-to-day navigation, so keeping them out of
// the main sidebar avoids the "what's the difference between this and that"
// noise. Settings landing page has cards for both.

const CONVERSATION_NAV: NavItem[] = [
  { href: "/inbox", label: "Inbox", icon: Inbox },
];

const CONTACTS_NAV: NavItem[] = [
  { href: "/contacts", label: "Contacts", icon: ContactRound },
];

// Broadcasts is the parent for outbound. Audience groups (the "who") and
// Templates (the "what") live nested under it so the user has one place to
// look when planning a send — no more hunting around the sidebar for the
// related concepts. Always visible (not collapse-on-route) so even agents
// who haven't yet clicked into Broadcasts know the pieces exist.
const BROADCASTS_CHILDREN: NavItem[] = [
  { href: "/broadcasts/groups", label: "Audience groups", icon: Users2 },
  { href: "/templates", label: "Templates", icon: FileText },
];

export function AppSidebar({
  currentUser,
  team,
  teammates,
  inboxControls,
  onlineUserIds,
  connected,
}: {
  currentUser: User;
  team: Team;
  teammates: User[];
  /** Filters + stages for the Inbox section. Only passed from /inbox. */
  inboxControls?: ReactNode;
  /** When provided, teammate avatars get a green/grey dot. */
  onlineUserIds?: Set<string>;
  /** When provided, header shows a Socket.io connection dot. */
  connected?: boolean;
}) {
  const pathname = usePathname() ?? "";

  // Pin "you" first so the agent can find their own row without scanning.
  const orderedTeammates = useMemo(() => {
    const me = teammates.find((u) => u.id === currentUser.id);
    const others = teammates.filter((u) => u.id !== currentUser.id);
    return me ? [me, ...others] : [currentUser, ...others];
  }, [teammates, currentUser]);

  const onInbox = pathname === "/inbox" || pathname.startsWith("/inbox/");

  return (
    <aside className="flex h-svh w-60 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
      {/* Header: team identity + (optional) connection dot */}
      <div className="flex items-center gap-2.5 px-4 pt-4 pb-3">
        <div className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <MessageSquareText className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold leading-tight">{team.name}</div>
          <div className="truncate text-[11px] text-muted-foreground">WhatsApp · Phase 1</div>
        </div>
        {connected !== undefined && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                className={cn(
                  "size-2 shrink-0 rounded-full transition-colors",
                  connected ? "bg-emerald-500" : "bg-muted-foreground/40",
                )}
                aria-label={connected ? "Realtime connected" : "Realtime disconnected"}
              />
            </TooltipTrigger>
            <TooltipContent side="right">
              {connected ? "Realtime connected" : "Realtime disconnected"}
            </TooltipContent>
          </Tooltip>
        )}
      </div>

      {/* Scrollable middle so long sidebars (many stages, many teammates) don't
          push the user footer off-screen. min-h-0 so flex shrinking works. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto pb-2">
        <Section label="Conversations">
          {CONVERSATION_NAV.map((item) => (
            <SidebarLink
              key={item.href}
              item={item}
              pathname={pathname}
              extra={item.href === "/inbox" && onInbox ? inboxControls : null}
            />
          ))}
        </Section>

        <Section label="Contacts">
          {CONTACTS_NAV.map((item) => (
            <SidebarLink key={item.href} item={item} pathname={pathname} />
          ))}
        </Section>

        <Section label="Outreach">
          <SidebarLink
            item={{ href: "/broadcasts", label: "Broadcasts", icon: Megaphone }}
            pathname={pathname}
            extra={
              <NestedNav>
                {BROADCASTS_CHILDREN.map((item) => (
                  <NestedLink key={item.href} item={item} pathname={pathname} />
                ))}
              </NestedNav>
            }
          />
          <SidebarLink
            item={{ href: "/automations", label: "Automations", icon: Zap }}
            pathname={pathname}
          />
        </Section>

        <Section label="Settings">
          <SidebarLink
            item={{ href: "/settings", label: "Team settings", icon: Sparkles }}
            pathname={pathname}
            active={isTeamSettingsRoute(pathname)}
          />
          <SidebarLink
            item={{ href: "/settings/workspace", label: "Account settings", icon: UserCircle2 }}
            pathname={pathname}
            active={isAccountSettingsRoute(pathname)}
          />
          {currentUser.role === "superAdmin" && (
            <SidebarLink
              item={{ href: "/admin", label: "Platform admin", icon: ShieldCheck }}
              pathname={pathname}
              tone="admin"
            />
          )}
        </Section>

        <Section label="Teammates">
          {orderedTeammates.map((u) => {
            // Only render presence dots when we actually know status.
            // Otherwise the row is identical for every page.
            const hasPresence = onlineUserIds !== undefined;
            const online = hasPresence ? onlineUserIds.has(u.id) : false;
            return (
              <div
                key={u.id}
                className="flex h-8 items-center gap-2.5 rounded-md px-2.5 text-sm text-muted-foreground"
              >
                <div className="relative">
                  <Avatar className="size-5">
                    <AvatarFallback className="text-[9px]">{initials(u.name)}</AvatarFallback>
                  </Avatar>
                  {hasPresence && (
                    <span
                      className={cn(
                        "absolute -bottom-0.5 -right-0.5 size-2 rounded-full ring-2 ring-sidebar transition-colors",
                        online ? "bg-emerald-500" : "bg-muted-foreground/40",
                      )}
                      aria-label={online ? "Online" : "Offline"}
                    />
                  )}
                </div>
                <span className="truncate">{u.name}</span>
                {u.id === currentUser.id && (
                  <Badge variant="muted" className="ml-auto px-1.5 py-0 text-[10px]">
                    you
                  </Badge>
                )}
              </div>
            );
          })}
        </Section>
      </div>

      <div className="flex items-center gap-2 border-t border-sidebar-border px-3 py-3">
        <Avatar className="size-8">
          <AvatarFallback>{initials(currentUser.name)}</AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{currentUser.name}</div>
          <div className="truncate text-[11px] text-muted-foreground">{currentUser.email}</div>
        </div>
        <UserMenu currentUser={currentUser} />
      </div>
    </aside>
  );
}

// ----------------------------------------------------------------------------
// Sub-components
// ----------------------------------------------------------------------------

/**
 * Wrapper for sub-nav rendered under a parent SidebarLink. Same indent +
 * left rail as the inbox controls so visually all "child of X" rows match.
 */
function NestedNav({ children }: { children: ReactNode }) {
  return (
    <div className="ml-3 mt-0.5 mb-1 flex flex-col gap-0.5 border-l border-sidebar-border/60 pl-1.5">
      {children}
    </div>
  );
}

function NestedLink({ item, pathname }: { item: NavItem; pathname: string }) {
  const { href, label, icon: Icon } = item;
  const active = pathname === href || pathname.startsWith(href + "/");
  return (
    <Link
      href={href}
      className={cn(
        "group flex h-7 items-center gap-2 rounded-md px-2 text-[13px] transition-colors",
        "hover:bg-accent hover:text-accent-foreground",
        active
          ? "bg-accent text-accent-foreground font-medium"
          : "text-muted-foreground",
      )}
    >
      <Icon
        className={cn(
          "size-3.5 shrink-0",
          active ? "text-primary" : "text-muted-foreground group-hover:text-foreground",
        )}
      />
      <span className="truncate">{label}</span>
    </Link>
  );
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mt-3 first:mt-1">
      <div className="px-4 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/80">
        {label}
      </div>
      <div className="flex flex-col gap-0.5 px-2">{children}</div>
    </div>
  );
}

function SidebarLink({
  item,
  pathname,
  extra,
  tone = "default",
  active: activeOverride,
}: {
  item: NavItem;
  pathname: string;
  /** Rendered nested under this link when present (used by Inbox controls). */
  extra?: ReactNode;
  tone?: "default" | "admin";
  /** Optional override. Needed when the default prefix match would over- or
   *  under-match — e.g. /settings would otherwise highlight for every /settings/* page. */
  active?: boolean;
}) {
  const { href, label, icon: Icon } = item;
  // Active = exact match OR sub-path. /broadcasts highlights for /broadcasts/123 too.
  const active = activeOverride ?? (pathname === href || pathname.startsWith(href + "/"));
  const isAdminTone = tone === "admin";

  return (
    <div>
      <Link
        href={href}
        className={cn(
          "group flex h-8 items-center gap-2.5 rounded-md px-2.5 text-sm transition-colors",
          isAdminTone
            ? cn(
                "border border-dashed border-amber-500/30",
                active
                  ? "bg-amber-500/10 text-amber-700 dark:text-amber-300 font-medium"
                  : "text-amber-700/80 hover:bg-amber-500/10 hover:text-foreground dark:text-amber-300/80",
              )
            : cn(
                "hover:bg-accent hover:text-accent-foreground",
                active
                  ? "bg-accent text-accent-foreground font-medium"
                  : "text-muted-foreground",
              ),
        )}
      >
        <Icon
          className={cn(
            "size-4 shrink-0",
            isAdminTone
              ? "text-amber-500"
              : active
                ? "text-primary"
                : "text-muted-foreground group-hover:text-foreground",
          )}
        />
        <span className="flex-1 text-left truncate">{label}</span>
      </Link>
      {extra}
    </div>
  );
}

// Settings is split into two landing pages with shared child routes underneath
// them, so prefix-matching alone misclassifies (every /settings/* would light
// up Team settings). These helpers route each child page to the right parent.
const TEAM_SETTINGS_CHILDREN = ["/settings/snippets", "/settings/stages"];
const ACCOUNT_SETTINGS_CHILDREN = [
  "/settings/workspace",
  "/settings/account",
  "/settings/team",
  "/settings/whatsapp",
  "/settings/api-keys",
];

function isTeamSettingsRoute(pathname: string): boolean {
  if (pathname === "/settings") return true;
  return TEAM_SETTINGS_CHILDREN.some(
    (p) => pathname === p || pathname.startsWith(p + "/"),
  );
}

function isAccountSettingsRoute(pathname: string): boolean {
  return ACCOUNT_SETTINGS_CHILDREN.some(
    (p) => pathname === p || pathname.startsWith(p + "/"),
  );
}

function UserMenu({ currentUser }: { currentUser: User }) {
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
              aria-label="Open user menu"
            >
              <SettingsIcon className="size-4" />
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="top">Account menu</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" side="top" className="min-w-45">
        <DropdownMenuLabel>{roleLabel(currentUser.role)}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/settings/workspace">
            <UserCircle2 className="size-4 text-muted-foreground" />
            Account settings
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href="/settings">
            <SettingsIcon className="size-4 text-muted-foreground" />
            Team settings
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={(e) => {
            e.preventDefault();
            // Drop the socket BEFORE the navigation so other clients see this
            // user go offline immediately — soft client navs would otherwise
            // keep the connection alive past the cookie clear.
            closeClientSocket();
            // Hard navigation to /logout — Better Auth's nextCookies plugin
            // races with redirect() inside a server action (same root cause
            // as the historical /login?next=/ bug).
            window.location.assign("/logout");
          }}
        >
          <LogOut className="size-4 text-muted-foreground" />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
