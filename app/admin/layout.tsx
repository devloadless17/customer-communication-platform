import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft, Building2, ShieldCheck } from "lucide-react";

import { getSession } from "@/lib/current-user";

/**
 * Super-admin shell. Gates access at the layout level so every page under
 * /admin/* inherits the redirect — no need for per-page checks.
 *
 * Non-superAdmin sessions bounce to /inbox. The layout mounts a slim left
 * rail with a single nav item today; if we add billing / audit-log / ops
 * sub-pages later they slot in here.
 */
export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user } = await getSession();
  if (user.role !== "superAdmin") {
    redirect("/inbox");
  }

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
          Platform admin
        </div>
        <nav className="flex flex-col gap-0.5 px-2">
          <NavLink href="/admin" icon={<Building2 className="size-4" />}>
            Organizations
          </NavLink>
        </nav>
        <div className="mt-auto flex items-center gap-2 border-t border-sidebar-border px-3 py-3 text-[11px] text-muted-foreground">
          <ShieldCheck className="size-3.5 text-amber-500" />
          <span>Signed in as superAdmin</span>
        </div>
      </aside>
      <main className="overflow-y-auto">{children}</main>
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
