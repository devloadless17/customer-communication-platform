import Link from "next/link";
import { ArrowLeft, MessageSquare, Users, UserCircle2 } from "lucide-react";

import { getSession } from "@/lib/current-user";
import { canManageUsers } from "@/lib/permissions";

/**
 * Settings shell. Server component — gates by session and surfaces nav.
 * The team-management link only shows for admins.
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
        <div className="px-4 pb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Settings
        </div>
        <nav className="flex flex-col gap-0.5 px-2">
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
        </nav>
      </aside>
      <main className="overflow-y-auto">
        <div className="mx-auto max-w-3xl px-8 py-10">{children}</div>
      </main>
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
