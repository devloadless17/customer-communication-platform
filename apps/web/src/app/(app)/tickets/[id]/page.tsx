import { notFound } from "next/navigation";

import { getTicket, listTags, listTeamMembers } from "@/lib/api/queries";

import { TicketDetailClient } from "./ticket-detail-client";

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
  const detail = await getTicket(id).catch(() => null);
  if (!detail) notFound();
  const [users, tags] = await Promise.all([listTeamMembers(), listTags()]);
  const { ticket, events } = detail;
  return <TicketDetailClient ticket={ticket} events={events} users={users} tags={tags} />;
}
