-- AlterEnum
ALTER TYPE "BroadcastStatus" ADD VALUE 'paused';

-- NOTE: Prisma's migrate-dev emitter wanted to DROP INDEX
-- "Contact_customFields_gin_idx" here. That index is intentionally hand-
-- managed in the raw-SQL section of the init migration; the schema's
-- Contact model has a comment explaining the quirk
-- (raw("jsonb_path_ops")` round-trips with a redundant ASC that Prisma
-- then flags as drift on every `migrate dev`). Removed manually so this
-- migration doesn't drop a live, hand-managed index.

-- CreateTable
CREATE TABLE "OutboundSendAttempt" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "attemptStartedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "externalId" TEXT,
    "failedAt" TIMESTAMP(3),
    "failureReason" TEXT,

    CONSTRAINT "OutboundSendAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OutboundSendAttempt_jobId_key" ON "OutboundSendAttempt"("jobId");

-- CreateIndex
CREATE INDEX "OutboundSendAttempt_attemptStartedAt_idx" ON "OutboundSendAttempt"("attemptStartedAt");

-- CreateIndex
CREATE INDEX "OutboundSendAttempt_teamId_completedAt_idx" ON "OutboundSendAttempt"("teamId", "completedAt");

-- AddForeignKey
ALTER TABLE "OutboundSendAttempt" ADD CONSTRAINT "OutboundSendAttempt_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
