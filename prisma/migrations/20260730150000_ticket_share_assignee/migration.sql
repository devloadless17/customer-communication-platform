-- Per-share assignee.
--
-- `Ticket.assignedUserId` belongs to the OWNING workspace's roster. With one
-- column shared across departments, Billing assigning Sara silently cleared
-- Support's Ali, and each side's assignee picker rendered a blank for the
-- other's person. Two departments working ONE ticket each need their own owner:
-- status, priority, cause, history and files stay shared; accountability does
-- not.
--
-- SetNull on the FK: a departure must not delete the access grant.
ALTER TABLE "TicketShare" ADD COLUMN "assignedUserId" TEXT;
ALTER TABLE "TicketShare" ADD COLUMN "lastAssignedUserId" TEXT;

CREATE INDEX "TicketShare_guestWorkspaceId_assignedUserId_idx" ON "TicketShare"("guestWorkspaceId", "assignedUserId");
CREATE INDEX "TicketShare_assignedUserId_idx" ON "TicketShare"("assignedUserId");

ALTER TABLE "TicketShare" ADD CONSTRAINT "TicketShare_assignedUserId_fkey" FOREIGN KEY ("assignedUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
