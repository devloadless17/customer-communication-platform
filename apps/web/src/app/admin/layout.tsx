import { redirect } from "next/navigation";

import { getSession } from "@/lib/auth/current-user";
import { getCurrentTeam, listTeamMembers } from "@/lib/api/queries";

import { AppSidebar } from "@/components/layouts/app-sidebar";

/**
 * Super-admin shell. Gates access at the layout level so every page under
 * /admin/* inherits the redirect — no need for per-page checks.
 *
 * Uses the shared `AppSidebar` so the chrome matches every other area; the
 * "Platform admin" link inside the sidebar (visible only to superAdmins)
 * is the entry point. No more sidebar disappearing when you click in.
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

  const [team, teammates] = await Promise.all([
    getCurrentTeam(),
    listTeamMembers(),
  ]);

  return (
    <div className="flex min-h-svh bg-background text-foreground">
      <AppSidebar
        currentUser={user}
        team={{ id: team.id, name: team.name }}
        teammates={teammates}
      />
      <main className="flex-1 overflow-y-auto">{children}</main>
    </div>
  );
}
