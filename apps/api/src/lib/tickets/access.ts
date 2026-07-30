import type { Prisma } from "@prisma/client";

/**
 * The ONE definition of "which tickets may this workspace touch".
 *
 * A ticket belongs to exactly one workspace (`Ticket.workspaceId`) — that never
 * changes. Escalating does not copy the ticket into a second workspace; it
 * writes a `TicketShare` row granting a named sibling workspace access to the
 * SAME ticket. So every ticket read and write asks one question:
 *
 *     mine, OR shared with me?
 *
 * That predicate lives HERE and nowhere else. The reason is the reason
 * `resolveActiveWorkspaceId` and `inboxViewWhereClauses` live in one place
 * each: this is the tenancy boundary, and a copy of it in the board query, the
 * detail read, the update path and the /v1 service is four chances to drift —
 * three of which fail OPEN (a missing `shares` clause hides legitimate work;
 * a missing `workspaceId` leaks another org's).
 *
 * Composition rule, same as the saved-view builder: this returns a predicate a
 * caller ANDs into its `where`. It is never spread into a sibling position
 * where a later key could overwrite it.
 */

/** A ticket predicate: owned by this workspace, or shared with it. */
export function ticketAccessWhere(workspaceId: string): Prisma.TicketWhereInput {
  return {
    OR: [{ workspaceId }, { shares: { some: { guestWorkspaceId: workspaceId } } }],
  };
}

/**
 * The same question for ONE ticket id, as a `findFirst` where. Callers use this
 * instead of `{ id, workspaceId }` — which is the shape that silently 404s a
 * shared ticket for the department it was escalated to.
 */
export function ticketByIdWhere(workspaceId: string, ticketId: string): Prisma.TicketWhereInput {
  return { id: ticketId, AND: [ticketAccessWhere(workspaceId)] };
}

/**
 * What THIS workspace is, relative to a ticket it can see.
 *  - `owner` — the workspace that raised it; sees the customer conversation,
 *    may escalate it onward, may delete it.
 *  - `guest` — a workspace it was escalated to; sees the contact SNAPSHOT and
 *    its own conversation (if it started one), works the same ticket, and may
 *    hand back access but not delete the ticket.
 */
export type TicketRole = "owner" | "guest";

export function ticketRoleFor(
  workspaceId: string,
  ticket: { workspaceId: string },
): TicketRole {
  return ticket.workspaceId === workspaceId ? "owner" : "guest";
}
