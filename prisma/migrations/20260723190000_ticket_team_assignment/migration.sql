-- Hand a ticket to a TEAM, not just to a person.
--
-- The workflow this exists for: a customer messages Support, the issue turns
-- out to belong to Sales, and Support hands the ticket over so Sales can either
-- take the customer themselves or tell Support what to answer.
--
-- Before this, a ticket could only be assigned to a USER — which forced the
-- handing-over agent to pick WHICH person on the other team should own it, the
-- one decision they are least qualified to make. `policyId` looked like it
-- covered this but does not: it is provenance ("which queue did this arrive
-- through") and never changes on a handoff.
--
-- A "team" here is an AssignmentPolicy — the existing per-workspace group with
-- membership, capacity and routing strategy. No new entity.
--
-- SetNull: deleting a team must never delete the work it was holding. Its
-- tickets fall back to the unassigned backlog where someone can see them.
ALTER TABLE "Ticket" ADD COLUMN "assignedTeamId" TEXT;

ALTER TABLE "Ticket"
  ADD CONSTRAINT "Ticket_assignedTeamId_fkey"
  FOREIGN KEY ("assignedTeamId") REFERENCES "AssignmentPolicy"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- The team-queue board: "everything waiting on Sales", newest first. Carries
-- the sort key so the list is a range scan that stops after `take`.
CREATE INDEX "Ticket_workspaceId_assignedTeamId_status_createdAt_id_idx"
  ON "Ticket" ("workspaceId", "assignedTeamId", "status", "createdAt" DESC, "id" DESC);

-- FK index for the SetNull — without it, deleting a team seq-scans every ticket.
CREATE INDEX "Ticket_assignedTeamId_idx" ON "Ticket" ("assignedTeamId");
