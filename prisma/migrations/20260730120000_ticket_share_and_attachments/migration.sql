-- ONE SHARED TICKET (supersedes the twin-pair escalation of 3 days ago).
--
-- A ticket is how two departments talk about one customer's issue, so there is
-- exactly ONE ticket row: one number, one status, one history. Escalating hands
-- a sibling workspace the KEY (TicketShare) instead of copying the work.
--
-- Also: TicketEvent.actorWorkspaceId (a shared log must say WHICH department
-- did it) and TicketAttachment (files on the ticket and on its comments).

-- New timeline kinds. PostgreSQL 12+ allows ADD VALUE inside the migration
-- transaction as long as the value is not USED in the same transaction.
ALTER TYPE "TicketEventKind" ADD VALUE 'escalation_revoked';
ALTER TYPE "TicketEventKind" ADD VALUE 'attachment_added';
ALTER TYPE "TicketEventKind" ADD VALUE 'attachment_removed';

-- Who did it, on a history both departments read. Null for pre-share rows.
ALTER TABLE "TicketEvent" ADD COLUMN "actorWorkspaceId" TEXT;

CREATE TABLE "TicketShare" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "ownerWorkspaceId" TEXT NOT NULL,
    "guestWorkspaceId" TEXT NOT NULL,
    "contactSnapshot" JSONB NOT NULL,
    "guestConversationId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TicketShare_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TicketShare_ticketId_guestWorkspaceId_key" ON "TicketShare"("ticketId", "guestWorkspaceId");
CREATE INDEX "TicketShare_guestWorkspaceId_idx" ON "TicketShare"("guestWorkspaceId");
CREATE INDEX "TicketShare_ownerWorkspaceId_idx" ON "TicketShare"("ownerWorkspaceId");
CREATE INDEX "TicketShare_organizationId_idx" ON "TicketShare"("organizationId");
CREATE INDEX "TicketShare_createdById_idx" ON "TicketShare"("createdById");
CREATE INDEX "TicketShare_guestConversationId_idx" ON "TicketShare"("guestConversationId");

ALTER TABLE "TicketShare" ADD CONSTRAINT "TicketShare_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TicketShare" ADD CONSTRAINT "TicketShare_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TicketShare" ADD CONSTRAINT "TicketShare_ownerWorkspaceId_fkey" FOREIGN KEY ("ownerWorkspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TicketShare" ADD CONSTRAINT "TicketShare_guestWorkspaceId_fkey" FOREIGN KEY ("guestWorkspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TicketShare" ADD CONSTRAINT "TicketShare_guestConversationId_fkey" FOREIGN KEY ("guestConversationId") REFERENCES "Conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TicketShare" ADD CONSTRAINT "TicketShare_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "TicketAttachment" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "eventId" TEXT,
    "blobKey" TEXT NOT NULL,
    "blobUrl" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "uploadedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TicketAttachment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "TicketAttachment_ticketId_createdAt_idx" ON "TicketAttachment"("ticketId", "createdAt");
CREATE INDEX "TicketAttachment_eventId_idx" ON "TicketAttachment"("eventId");
CREATE INDEX "TicketAttachment_workspaceId_idx" ON "TicketAttachment"("workspaceId");
CREATE INDEX "TicketAttachment_uploadedById_idx" ON "TicketAttachment"("uploadedById");

ALTER TABLE "TicketAttachment" ADD CONSTRAINT "TicketAttachment_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TicketAttachment" ADD CONSTRAINT "TicketAttachment_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TicketAttachment" ADD CONSTRAINT "TicketAttachment_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "TicketEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TicketAttachment" ADD CONSTRAINT "TicketAttachment_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Data migration: collapse every existing twin PAIR into one shared ticket.
--
-- The source ticket survives as THE ticket (it owns the conversation and the
-- customer). The twin's timeline is re-pointed onto it so nothing written in
-- the guest workspace is lost, stamped with the guest workspace as the actor.
-- Then the twin row is deleted, which cascades its (now empty) leftovers.
-- Order matters: re-point events BEFORE deleting the twin, or the cascade
-- takes them.
-- ---------------------------------------------------------------------------

-- 1. One share per pair, carrying the snapshot the twin was handed. Pairs whose
--    source was already deleted (severed) have nothing to grant access TO, so
--    they are skipped and their twin is left alone as an ordinary ticket.
INSERT INTO "TicketShare" ("id", "organizationId", "ticketId", "ownerWorkspaceId", "guestWorkspaceId", "contactSnapshot", "guestConversationId", "createdById", "createdAt")
SELECT
    e."id",
    e."organizationId",
    e."sourceTicketId",
    e."sourceWorkspaceId",
    e."targetWorkspaceId",
    e."contactSnapshot",
    t."conversationId",
    e."createdById",
    e."createdAt"
FROM "TicketEscalation" e
JOIN "Ticket" t ON t."id" = e."targetTicketId"
WHERE e."sourceTicketId" IS NOT NULL
ON CONFLICT ("ticketId", "guestWorkspaceId") DO NOTHING;

-- 2. Move the twin's history onto the surviving ticket, attributed to the guest
--    workspace. `workspaceId` becomes the owner's (a shared ticket has one
--    history, all rows carrying the owning workspace).
UPDATE "TicketEvent" ev
SET "ticketId" = e."sourceTicketId",
    "workspaceId" = e."sourceWorkspaceId",
    "actorWorkspaceId" = e."targetWorkspaceId"
FROM "TicketEscalation" e
WHERE ev."ticketId" = e."targetTicketId"
  AND e."sourceTicketId" IS NOT NULL;

-- 3. Messages that attached to the twin (a guest who started their own chat)
--    re-point to the surviving ticket — the work item they belong to.
UPDATE "Message" m
SET "ticketId" = e."sourceTicketId"
FROM "TicketEscalation" e
WHERE m."ticketId" = e."targetTicketId"
  AND e."sourceTicketId" IS NOT NULL;

-- 4. Release the guest conversation's active pointer + counter before the twin
--    goes, so no conversation is left pointing at a deleted ticket.
UPDATE "Conversation" c
SET "activeTicketId" = NULL,
    "openTicketCount" = GREATEST(0, c."openTicketCount" - 1)
FROM "Ticket" t
JOIN "TicketEscalation" e ON e."targetTicketId" = t."id"
WHERE c."activeTicketId" = t."id"
  AND e."sourceTicketId" IS NOT NULL;

-- 5. Drop the twins.
DELETE FROM "Ticket" t
USING "TicketEscalation" e
WHERE t."id" = e."targetTicketId"
  AND e."sourceTicketId" IS NOT NULL;

-- 6. The bridge table is gone; TicketShare replaced it.
DROP TABLE "TicketEscalation";
