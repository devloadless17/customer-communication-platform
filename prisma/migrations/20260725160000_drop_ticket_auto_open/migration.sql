-- Remove the auto-open ticket toggle. A ticket is now always a deliberate act
-- (raised by an agent from the inbox, or by a workflow's create_ticket step);
-- an inbound message only ever ATTACHES to a live ticket or REOPENS a recently
-- solved one, never mints a new one. See routeMessageToTicket.
ALTER TABLE "Workspace" DROP COLUMN "ticketAutoOpen";
