import { redirect } from "next/navigation";

import { getSession } from "@/lib/auth/current-user";
import { getCurrentTeam } from "@/lib/api/queries";

import { AppRail } from "@/components/layouts/app-rail";
import { AdminSubSidebar } from "@/components/layouts/section-sub-sidebars";
import { CatalogSyncBoundary } from "@/providers/catalog-sync-boundary";

/**
 * Super-admin shell. Gates access at the layout level so every page under
 * /admin/* inherits the redirect — no need for per-page checks.
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
  const team = await getCurrentTeam();

  return (
    <CatalogSyncBoundary>
      <div className="flex min-h-svh bg-background text-foreground">
        <AppRail currentUser={user} team={{ id: team.id, name: team.name }} />
        <AdminSubSidebar />
        <main className="flex-1 overflow-y-auto">{children}</main>
      </div>
    </CatalogSyncBoundary>
  );
}
