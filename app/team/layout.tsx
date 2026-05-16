import { db } from "@/lib/db";
import { getSession } from "@/lib/auth/current-user";
import { listTeamMembers } from "@/lib/queries";

import { AppSidebar } from "@/components/layouts/app-sidebar";
import { CatalogSyncBoundary } from "@/components/providers/catalog-sync-boundary";

/**
 * Sidebar shell for /team. Mirrors /contacts/layout.tsx so the chrome looks
 * identical across non-inbox routes. The team-chat-specific sidebar (the
 * channel list) lives inside `app/team/[channelId]/page.tsx` — putting it
 * here would force every channel switch to re-fetch the layout's data.
 */
export default async function TeamLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user, teamId } = await getSession();

  const [team, teammates] = await Promise.all([
    db.team.findUnique({
      where: { id: teamId },
      select: { id: true, name: true },
    }),
    listTeamMembers(teamId),
  ]);

  if (!team) {
    throw new Error("team not found");
  }

  return (
    <CatalogSyncBoundary>
      <div className="flex min-h-svh bg-background text-foreground">
        <AppSidebar
          currentUser={user}
          team={{ id: team.id, name: team.name }}
          teammates={teammates}
        />
        <main className="flex-1 min-w-0">{children}</main>
      </div>
    </CatalogSyncBoundary>
  );
}
