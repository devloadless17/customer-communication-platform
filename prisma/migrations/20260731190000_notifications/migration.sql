-- The notification centre: one thing that happened, for ONE person.
--
-- Append-only. No unique key to coalesce on, deliberately — the bell groups by
-- ticket when it renders, which needs no partial index and has no race.
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "ticketId" TEXT,
    "actorUserId" TEXT,
    "actorName" TEXT,
    "ticketNumber" INTEGER,
    "ticketSubject" TEXT,
    "summary" TEXT,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- The bell's only read: my recent, newest first.
CREATE INDEX "Notification_userId_workspaceId_createdAt_idx"
    ON "Notification"("userId", "workspaceId", "createdAt" DESC);
-- The badge count, and the retention sweep.
CREATE INDEX "Notification_userId_workspaceId_readAt_idx"
    ON "Notification"("userId", "workspaceId", "readAt");
CREATE INDEX "Notification_ticketId_idx" ON "Notification"("ticketId");
CREATE INDEX "Notification_workspaceId_idx" ON "Notification"("workspaceId");
CREATE INDEX "Notification_actorUserId_idx" ON "Notification"("actorUserId");

ALTER TABLE "Notification" ADD CONSTRAINT "Notification_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- Cascade: a notification about a deleted ticket is a dead link with nothing to
-- show. (The ticket-delete path relies on this — see deleteTicket.)
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- SetNull, not Cascade: someone leaving the org must not delete the record that
-- they assigned you something. `actorName` is snapshotted for exactly this.
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
