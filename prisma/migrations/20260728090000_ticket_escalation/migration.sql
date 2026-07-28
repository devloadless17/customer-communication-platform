-- Cross-workspace ticket escalation ("referral").
-- A ticket in workspace A can be escalated to a sibling workspace in the same
-- organization: a twin ticket is created over there carrying a contact
-- SNAPSHOT, and this bridge row links the pair. Everything the sides share
-- travels as MIRRORED TicketEvent rows, one per side — no read crosses the
-- workspace boundary.

-- New timeline kinds. PostgreSQL 12+ allows ADD VALUE inside the migration
-- transaction as long as the value is not USED in the same transaction (it
-- isn't — only referenced by application code later).
ALTER TYPE "TicketEventKind" ADD VALUE 'escalated';
ALTER TYPE "TicketEventKind" ADD VALUE 'escalation_received';
ALTER TYPE "TicketEventKind" ADD VALUE 'escalation_note';
ALTER TYPE "TicketEventKind" ADD VALUE 'escalation_status';
ALTER TYPE "TicketEventKind" ADD VALUE 'escalation_severed';

-- An escalated-in ticket has no conversation/contact of its own until the
-- target workspace binds one ("Message customer"). Every other create path
-- still requires both — enforced in lib/tickets.
ALTER TABLE "Ticket" ALTER COLUMN "conversationId" DROP NOT NULL;
ALTER TABLE "Ticket" ALTER COLUMN "contactId" DROP NOT NULL;

-- TENANCY EXCEPTION: deliberately the only table spanning two workspaces.
-- Reached only through a workspace-scoped query on one of its two tickets.
CREATE TABLE "TicketEscalation" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "sourceWorkspaceId" TEXT NOT NULL,
    "sourceTicketId" TEXT,
    "targetWorkspaceId" TEXT NOT NULL,
    "targetTicketId" TEXT NOT NULL,
    "contactSnapshot" JSONB NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TicketEscalation_pkey" PRIMARY KEY ("id")
);

-- One escalation per ticket lifetime, on both sides.
CREATE UNIQUE INDEX "TicketEscalation_sourceTicketId_key" ON "TicketEscalation"("sourceTicketId");
CREATE UNIQUE INDEX "TicketEscalation_targetTicketId_key" ON "TicketEscalation"("targetTicketId");

CREATE INDEX "TicketEscalation_organizationId_idx" ON "TicketEscalation"("organizationId");
CREATE INDEX "TicketEscalation_sourceWorkspaceId_idx" ON "TicketEscalation"("sourceWorkspaceId");
CREATE INDEX "TicketEscalation_targetWorkspaceId_idx" ON "TicketEscalation"("targetWorkspaceId");
CREATE INDEX "TicketEscalation_createdById_idx" ON "TicketEscalation"("createdById");

ALTER TABLE "TicketEscalation" ADD CONSTRAINT "TicketEscalation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TicketEscalation" ADD CONSTRAINT "TicketEscalation_sourceWorkspaceId_fkey" FOREIGN KEY ("sourceWorkspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TicketEscalation" ADD CONSTRAINT "TicketEscalation_targetWorkspaceId_fkey" FOREIGN KEY ("targetWorkspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TicketEscalation" ADD CONSTRAINT "TicketEscalation_sourceTicketId_fkey" FOREIGN KEY ("sourceTicketId") REFERENCES "Ticket"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TicketEscalation" ADD CONSTRAINT "TicketEscalation_targetTicketId_fkey" FOREIGN KEY ("targetTicketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TicketEscalation" ADD CONSTRAINT "TicketEscalation_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
