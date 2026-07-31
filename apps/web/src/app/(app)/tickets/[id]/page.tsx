import { notFound } from "next/navigation";

import {
  getTicket,
  listAssignmentPolicies,
  listEscalationTargets,
  listTags,
  listTeamMembers,
  locateTicket,
} from "@/lib/api/queries";
import { soft } from "@/lib/api/soft";
import { getSession } from "@/lib/auth/current-user";

import { TicketDetailClient } from "./ticket-detail-client";
import { TicketElsewhere } from "./ticket-elsewhere";

export const metadata = {
  title: "Ticket",
};

/**
 * One ticket: what it is, who owns it, what it promised, and everything that
 * has happened to it.
 *
 * SSR-seeded (unlike the board) because a detail page is a single row the user
 * navigated to deliberately — there is no filter to invalidate the seed, and a
 * server render means the page is readable on first paint instead of after a
 * client round-trip. Live updates then patch it through the socket frame.
 */
export default async function TicketDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [detail, session] = await Promise.all([
    // soft() rather than a bare catch: a TRANSIENT api failure used to be
    // indistinguishable from a real 404 in the logs — the page showed the
    // dead-ticket state with no trace of why.
    soft("ticket detail", null, () => getTicket(id)),
    getSession(),
  ]);
  if (!detail) {
    // Not in THIS workspace — but maybe in a sibling the viewer can open
    // (an escalation pair followed across a switch, a colleague's link, the
    // back button). Offer the one-click switch instead of a dead 404.
    const elsewhere = await soft("ticket locate", null, () => locateTicket(id));
    if (elsewhere) {
      return (
        <div className="h-full overflow-y-auto">
          <TicketElsewhere
            workspaceId={elsewhere.workspaceId}
            workspaceName={elsewhere.workspaceName}
            number={elsewhere.number}
          />
        </div>
      );
    }
    notFound();
  }
  const [users, tags, teams, escalationTargets] = await Promise.all([
    listTeamMembers(),
    listTags(),
    // Teams (AssignmentPolicy) drive the handoff picker. Degrades to [] — a
    // teams read failing must not 500 a ticket the agent navigated to; the
    // picker simply says there are none, and the failure is logged.
    soft("assignment policies", [], () => listAssignmentPolicies()),
    // Sibling workspaces drive the escalation picker — same degradation.
    soft("escalation targets", [], () => listEscalationTargets()),
  ]);
  const { ticket, events } = detail;
  // Delete is destructive and reserved for the people who supervise the queue —
  // matches the API's admin/manager gate, so the button only shows when the
  // click will actually work.
  const canDelete = session.user.role === "admin" || session.user.role === "manager";
  return (
    // The section layout pins <main> to `overflow-hidden` for the BOARD's
    // sake (its columns own their scrolling). A ticket detail is a normal
    // long document, so it brings its own vertical scroller — without this,
    // anything below the fold (history, escalation thread) was unreachable.
    <div className="h-full overflow-y-auto px-4 py-6 sm:px-6 md:px-8">
      <TicketDetailClient
        ticket={ticket}
        events={events}
        users={users}
        tags={tags}
        teams={teams}
        escalationTargets={escalationTargets}
        canDelete={canDelete}
      />
    </div>
  );
}
