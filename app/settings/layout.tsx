import { getSession } from "@/lib/auth/current-user";
import { listTeamMembers } from "@/lib/queries";
import { db } from "@/lib/db";

import { AppSidebar } from "@/components/layouts/app-sidebar";

/**
 * Settings shell. Uses the same `AppSidebar` every other area uses — Account,
 * Team, WhatsApp, API keys, Snippets, and Stages now all live in labeled
 * groups in the main sidebar, so users don't lose the global nav the moment
 * they open settings.
 *
 * The old inline sub-sidebar (Chat / Workspace groups) is gone; navigation
 * happens from the same shell on every page, and a settings landing card
 * grid still exists at /settings for direct deep-links.
 */
export default async function SettingsLayout({
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
    <div className="flex min-h-svh bg-background text-foreground">
      <AppSidebar
        currentUser={user}
        team={{ id: team.id, name: team.name }}
        teammates={teammates}
      />
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-8 py-10">{children}</div>
      </main>
    </div>
  );
}
