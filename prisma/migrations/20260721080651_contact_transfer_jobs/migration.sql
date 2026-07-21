-- CreateEnum
CREATE TYPE "ContactTransferKind" AS ENUM ('import', 'export');

-- CreateEnum
CREATE TYPE "ContactTransferFormat" AS ENUM ('csv', 'xlsx');

-- CreateEnum
CREATE TYPE "ContactTransferStatus" AS ENUM ('pending', 'running', 'completed', 'failed', 'canceled');

-- AlterTable
ALTER TABLE "BroadcastRecipient" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- CreateTable
CREATE TABLE "ContactTransferJob" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "kind" "ContactTransferKind" NOT NULL,
    "format" "ContactTransferFormat" NOT NULL,
    "status" "ContactTransferStatus" NOT NULL DEFAULT 'pending',
    "createdByUserId" TEXT,
    "filename" TEXT NOT NULL,
    "sourceKey" TEXT,
    "artifactKey" TEXT,
    "errorArtifactKey" TEXT,
    "artifactBytes" INTEGER,
    "options" JSONB NOT NULL DEFAULT '{}',
    "totalRows" INTEGER,
    "processedRows" INTEGER NOT NULL DEFAULT 0,
    "created" INTEGER NOT NULL DEFAULT 0,
    "updated" INTEGER NOT NULL DEFAULT 0,
    "revived" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "automationsSkipped" BOOLEAN NOT NULL DEFAULT false,
    "errorSample" JSONB NOT NULL DEFAULT '[]',
    "error" TEXT,
    "heartbeatAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContactTransferJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ContactTransferJob_teamId_createdAt_idx" ON "ContactTransferJob"("teamId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "ContactTransferJob_status_heartbeatAt_idx" ON "ContactTransferJob"("status", "heartbeatAt");

-- CreateIndex
CREATE INDEX "ContactTransferJob_expiresAt_idx" ON "ContactTransferJob"("expiresAt");

-- AddForeignKey
ALTER TABLE "ContactTransferJob" ADD CONSTRAINT "ContactTransferJob_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactTransferJob" ADD CONSTRAINT "ContactTransferJob_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
