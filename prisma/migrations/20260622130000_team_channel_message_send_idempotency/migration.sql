-- Send idempotency for team-chat messages (audit fix F2).
-- Persist the client-generated optimistic key so a retried POST (lost HTTP
-- response, or the Retry button) is deduped by the unique index below instead
-- of inserting a duplicate message visible to the whole channel. NULLs are
-- distinct in a Postgres unique index, so legacy/system rows never conflict.

-- AlterTable
ALTER TABLE "TeamChannelMessage" ADD COLUMN "clientTempId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "TeamChannelMessage_send_idem_key" ON "TeamChannelMessage"("channelId", "authorUserId", "clientTempId");
