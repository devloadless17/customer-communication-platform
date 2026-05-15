import { getSession } from "@/lib/auth/current-user";
import { db } from "@/lib/db";
import { listConversations, listContactStages, listSnippets } from "@/lib/queries";
import { InboxShell } from "@/components/inbox/inbox-shell";
import type { Team, User } from "@/lib/types";

/**
 * Server-rendered inbox layout. Fetches the current session, the team,
 * the team roster, and all conversations once per navigation; passes them
 * to the shell for client-side state (filter/search) and child rendering.
 */
export default async function InboxLayout({ children }: { children: React.ReactNode }) {
  const { user, teamId } = await getSession();
  const teamRow = await db.team.findUniqueOrThrow({ where: { id: teamId } });
  const team: Team = { id: teamRow.id, name: teamRow.name };

  const [conversationsPage, memberRows, snippets, stages] = await Promise.all([
    listConversations(teamId),
    db.user.findMany({
      where: { teamId, deactivatedAt: null },
      orderBy: { name: "asc" },
      select: { id: true, teamId: true, role: true, name: true, email: true, avatarUrl: true },
    }),
    listSnippets(teamId),
    listContactStages(teamId),
  ]);

  const teammates: User[] = memberRows.map((u) => ({
    id: u.id,
    teamId: u.teamId,
    role: u.role,
    name: u.name,
    email: u.email,
    avatarUrl: u.avatarUrl ?? undefined,
  }));

  return (
    <InboxShell
      currentUser={user}
      team={team}
      teammates={teammates}
      conversations={conversationsPage.items}
      nextConversationCursor={conversationsPage.nextCursor}
      snippets={snippets}
      stages={stages}
    >
      {children}
    </InboxShell>
  );
}
