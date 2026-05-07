import { getSession } from "@/lib/current-user";
import { db } from "@/lib/db";
import { listConversations } from "@/lib/queries";
import { InboxShell } from "@/components/inbox/inbox-shell";
import type { Team } from "@/lib/types";

/**
 * Server-rendered inbox layout. Fetches the current session, the team,
 * and all conversations once per navigation; passes them to the shell
 * for client-side state (filter/search) and child rendering.
 *
 * Slice 2 will layer Socket.io on top so this initial fetch becomes the
 * hydration point and live events keep it fresh.
 */
export default async function InboxLayout({ children }: { children: React.ReactNode }) {
  const { user, teamId } = await getSession();
  const teamRow = await db.team.findUniqueOrThrow({ where: { id: teamId } });
  const team: Team = { id: teamRow.id, name: teamRow.name };
  const conversations = await listConversations(teamId);

  return (
    <InboxShell currentUser={user} team={team} conversations={conversations}>
      {children}
    </InboxShell>
  );
}
