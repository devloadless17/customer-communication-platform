-- The actor-workspace relation for TicketEvent (the column itself landed in
-- 20260730120000). A shared ticket has ONE history, so every row on it carries
-- the OWNING workspace in `workspaceId`; `actorWorkspaceId` is what makes that
-- history readable — "Billing changed the status" rather than an unattributed
-- change.
--
-- SetNull, not Cascade: the history must outlive a guest workspace being
-- deleted. The entry stays and simply loses its attribution.
CREATE INDEX "TicketEvent_actorWorkspaceId_idx" ON "TicketEvent"("actorWorkspaceId");
ALTER TABLE "TicketEvent" ADD CONSTRAINT "TicketEvent_actorWorkspaceId_fkey" FOREIGN KEY ("actorWorkspaceId") REFERENCES "Workspace"("id") ON DELETE SET NULL ON UPDATE CASCADE;
