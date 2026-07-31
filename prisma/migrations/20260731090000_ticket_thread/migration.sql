-- The ticket THREAD — the conversation between the departments working one
-- customer's issue, as its own entity.
--
-- Comments shipped as `TicketEvent(kind:'escalation_note')` and therefore
-- rendered inside the audit log, so the answer to "what did Billing say?" sat
-- among twenty status flips. The log's 500-row read cap is SHARED, so on a busy
-- ticket the conversation is what gets pushed out. Separating them also keeps
-- the audit trail append-only: read-state and optimistic-send ids do not belong
-- hanging off an audit row.
--
-- DDL only. The backfill of existing comments is the NEXT migration, so a copy
-- failure cannot leave this half-applied.

CREATE TABLE "TicketMessage" (
    "id" TEXT NOT NULL,
    -- The ticket's OWNING workspace (the TicketEvent convention): one thread
    -- per ticket, whichever department writes in it.
    "workspaceId" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "authorWorkspaceId" TEXT,
    "authorUserId" TEXT,
    "authorApiKeyId" TEXT,
    "body" TEXT NOT NULL,
    "clientTempId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TicketMessage_pkey" PRIMARY KEY ("id")
);

-- Optimistic-send idempotency, the TeamChannelMessage contract: a retry of the
-- same (ticket, author, tempId) returns the existing row instead of posting
-- twice. NULLs are distinct in Postgres, so API-key and backfilled rows never
-- collide here.
CREATE UNIQUE INDEX "TicketMessage_send_idem_key" ON "TicketMessage"("ticketId", "authorUserId", "clientTempId");
CREATE INDEX "TicketMessage_ticketId_createdAt_idx" ON "TicketMessage"("ticketId", "createdAt");
CREATE INDEX "TicketMessage_workspaceId_idx" ON "TicketMessage"("workspaceId");
CREATE INDEX "TicketMessage_authorUserId_idx" ON "TicketMessage"("authorUserId");
CREATE INDEX "TicketMessage_authorWorkspaceId_idx" ON "TicketMessage"("authorWorkspaceId");

ALTER TABLE "TicketMessage" ADD CONSTRAINT "TicketMessage_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TicketMessage" ADD CONSTRAINT "TicketMessage_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- SetNull on both author FKs: the conversation outlives whoever left.
ALTER TABLE "TicketMessage" ADD CONSTRAINT "TicketMessage_authorUserId_fkey" FOREIGN KEY ("authorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TicketMessage" ADD CONSTRAINT "TicketMessage_authorWorkspaceId_fkey" FOREIGN KEY ("authorWorkspaceId") REFERENCES "Workspace"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- "This person has an unread reply on this ticket."
--
-- A MARKER row, deliberately not a lastReadAt watermark: a watermark forces the
-- badge query to compare a receipt column against a column reachable only
-- through a relation, which Prisma cannot express — so it forces raw SQL, and
-- raw SQL forces a SECOND hand-written copy of "mine OR shared with me". That is
-- what ticketAccessWhere() exists to prevent, and its failure modes fail OPEN.
CREATE TABLE "TicketThreadUnread" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    -- The message that made it unread. Inserts are skipDuplicates, so a second
    -- reply keeps the FIRST — the divider sits at the first thing you missed.
    "sinceMessageId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TicketThreadUnread_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TicketThreadUnread_userId_ticketId_key" ON "TicketThreadUnread"("userId", "ticketId");
CREATE INDEX "TicketThreadUnread_ticketId_idx" ON "TicketThreadUnread"("ticketId");
CREATE INDEX "TicketThreadUnread_workspaceId_idx" ON "TicketThreadUnread"("workspaceId");
CREATE INDEX "TicketThreadUnread_sinceMessageId_idx" ON "TicketThreadUnread"("sinceMessageId");

ALTER TABLE "TicketThreadUnread" ADD CONSTRAINT "TicketThreadUnread_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TicketThreadUnread" ADD CONSTRAINT "TicketThreadUnread_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TicketThreadUnread" ADD CONSTRAINT "TicketThreadUnread_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TicketThreadUnread" ADD CONSTRAINT "TicketThreadUnread_sinceMessageId_fkey" FOREIGN KEY ("sinceMessageId") REFERENCES "TicketMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A file that came in with a REPLY now points at the message. `eventId` stays
-- for the already-migrated rows (see the backfill migration's note on why the
-- source events are not deleted).
ALTER TABLE "TicketAttachment" ADD COLUMN "messageId" TEXT;
CREATE INDEX "TicketAttachment_messageId_idx" ON "TicketAttachment"("messageId");
ALTER TABLE "TicketAttachment" ADD CONSTRAINT "TicketAttachment_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "TicketMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
