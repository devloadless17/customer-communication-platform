-- CreateEnum
CREATE TYPE "BroadcastStatus" AS ENUM ('queued', 'running', 'completed', 'failed');

-- CreateEnum
CREATE TYPE "BroadcastRecipientStatus" AS ENUM ('queued', 'sent', 'failed');

-- CreateTable
CREATE TABLE "Broadcast" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "status" "BroadcastStatus" NOT NULL DEFAULT 'queued',
    "templateId" TEXT NOT NULL,
    "templateName" TEXT NOT NULL,
    "templateLanguage" TEXT NOT NULL,
    "variables" JSONB NOT NULL,
    "audienceMode" TEXT NOT NULL,
    "totalCount" INTEGER NOT NULL DEFAULT 0,
    "sentCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "Broadcast_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BroadcastRecipient" (
    "id" TEXT NOT NULL,
    "broadcastId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "conversationId" TEXT,
    "status" "BroadcastRecipientStatus" NOT NULL DEFAULT 'queued',
    "externalId" TEXT,
    "errorMessage" TEXT,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "BroadcastRecipient_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Broadcast_teamId_createdAt_idx" ON "Broadcast"("teamId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Broadcast_teamId_status_idx" ON "Broadcast"("teamId", "status");

-- CreateIndex
CREATE INDEX "BroadcastRecipient_broadcastId_status_idx" ON "BroadcastRecipient"("broadcastId", "status");

-- CreateIndex
CREATE INDEX "BroadcastRecipient_contactId_idx" ON "BroadcastRecipient"("contactId");

-- CreateIndex
CREATE UNIQUE INDEX "BroadcastRecipient_broadcastId_contactId_key" ON "BroadcastRecipient"("broadcastId", "contactId");

-- AddForeignKey
ALTER TABLE "Broadcast" ADD CONSTRAINT "Broadcast_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Broadcast" ADD CONSTRAINT "Broadcast_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BroadcastRecipient" ADD CONSTRAINT "BroadcastRecipient_broadcastId_fkey" FOREIGN KEY ("broadcastId") REFERENCES "Broadcast"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BroadcastRecipient" ADD CONSTRAINT "BroadcastRecipient_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
