import { listAssignmentPolicies, listTeamMembers } from "@/lib/api/queries";
import { soft } from "@/lib/api/soft";

import { TicketsBoardClient } from "@/features/tickets/components/tickets-board-client";

export const metadata = {
  title: "Tickets",
};

/**
 * The ticket board — every piece of work across every conversation, grouped by
 * where it stands.
 *
 * Distinct from the inbox on purpose. The inbox answers "which CONVERSATIONS
 * need a reply"; this answers "what WORK is open, who owns it, and what's about
 * to miss its promise" — a supervisor's question, and one a thread-by-thread
 * view can't express because a single thread can carry several separate issues
 * over time.
 *
 * Only the roster is SSR-seeded (tiny, and the assignee filter needs it on
 * first paint). The cards themselves are fetched client-side: they're
 * keyset-paginated, filterable, and live-patched by the `ticket:changed` socket
 * frame, so an SSR seed would be discarded by the first interaction.
 */
export default async function TicketsPage() {
  const [users, teams] = await Promise.all([
    listTeamMembers(),
    // Teams drive the queue filter. Degrades to [] so a teams read failing
    // hides one filter rather than 500-ing the board; the failure is logged.
    soft("assignment policies", [], () => listAssignmentPolicies()),
  ]);
  return <TicketsBoardClient users={users} teams={teams} />;
}
