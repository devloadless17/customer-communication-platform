-- The board's sort key: when something last HAPPENED on a ticket.
--
-- Backfilled from the ticket's own history rather than defaulting everything to
-- now(): seeding a constant would flatten the order on the very first render
-- and every existing ticket would appear equally fresh, which is the opposite
-- of the point.
ALTER TABLE "Ticket" ADD COLUMN "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

UPDATE "Ticket" t
SET "lastActivityAt" = GREATEST(
    t."createdAt",
    t."updatedAt",
    COALESCE((SELECT MAX(e."createdAt") FROM "TicketEvent" e WHERE e."ticketId" = t."id"), t."createdAt"),
    COALESCE((SELECT MAX(m."createdAt") FROM "TicketMessage" m WHERE m."ticketId" = t."id"), t."createdAt")
);

-- Serves the board's default read: scope + status, newest activity first.
CREATE INDEX "Ticket_workspaceId_status_lastActivityAt_id_idx"
    ON "Ticket"("workspaceId", "status", "lastActivityAt" DESC, "id" DESC);
