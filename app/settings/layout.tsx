import Link from "next/link";
import {
  ArrowLeft,
  KeyRound,
  Layers,
  MessageSquare,
  Sparkles,
  Users,
  UserCircle2,
} from "lucide-react";

import { getSession } from "@/lib/current-user";
import { canManageStages, canManageUsers } from "@/lib/permissions";

/**
 * Settings shell. Server component — gates by session and surfaces nav.
 *
 * Nav is grouped into two sections so it stays scannable as more
 * chatting-related settings get added:
 *   - "Chat" → things that shape how agents reply / route customers
 *     (snippets, stages today; templates / automations later).
 *   - "Workspace" → identity + plumbing (account, team, WhatsApp creds,
 *     API keys). Admin-only links auto-hide.
 *
 * Admin-only links auto-hide; everyone sees Account, Team, Snippets, Stages.
 */
export default async function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user } = await getSession();

  return (
    <div className="grid min-h-svh grid-cols-[220px_1fr] bg-background text-foreground">
      <aside className="flex flex-col border-r border-border bg-sidebar text-sidebar-foreground">
        <div className="px-4 pt-5 pb-3">
          <Link
            href="/inbox"
            className="inline-flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-3.5" />
            Back to inbox
          </Link>
        </div>

        <NavGroup label="Chat">
          <NavLink href="/settings/snippets" icon={<Sparkles className="size-4" />}>
            Snippets
          </NavLink>
          {canManageStages(user.role) && (
            <NavLink href="/settings/stages" icon={<Layers className="size-4" />}>
              Stages
            </NavLink>
          )}
        </NavGroup>

        <NavGroup label="Workspace">
          <NavLink href="/settings/account" icon={<UserCircle2 className="size-4" />}>
            Account
          </NavLink>
          <NavLink href="/settings/team" icon={<Users className="size-4" />}>
            Team
          </NavLink>
          {canManageUsers(user.role) && (
            <NavLink href="/settings/whatsapp" icon={<MessageSquare className="size-4" />}>
              WhatsApp
            </NavLink>
          )}
          {canManageUsers(user.role) && (
            <NavLink href="/settings/api-keys" icon={<KeyRound className="size-4" />}>
              API keys
            </NavLink>
          )}
        </NavGroup>
      </aside>
      <main className="overflow-y-auto">
        <div className="mx-auto max-w-3xl px-8 py-10">{children}</div>
      </main>
    </div>
  );
}

function NavGroup({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-2">
      <div className="px-4 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <nav className="flex flex-col gap-0.5 px-2">{children}</nav>
    </div>
  );
}

function NavLink({
  href,
  icon,
  children,
}: {
  href: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className="flex h-8 items-center gap-2.5 rounded-md px-2.5 text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground"
    >
      {icon}
      <span>{children}</span>
    </Link>
  );
}
