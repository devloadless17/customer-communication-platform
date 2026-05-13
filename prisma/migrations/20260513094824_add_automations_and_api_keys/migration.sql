-- CreateEnum
CREATE TYPE "AutomationTriggerEvent" AS ENUM ('message_received', 'conversation_assigned', 'conversation_status_changed');

-- CreateEnum
CREATE TYPE "AutomationActionType" AS ENUM ('webhook');

-- CreateEnum
CREATE TYPE "AutomationRunStatus" AS ENUM ('queued', 'running', 'success', 'failed', 'skipped');

-- CreateTable
CREATE TABLE "Automation" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "trigger" "AutomationTriggerEvent" NOT NULL,
    "conditions" JSONB NOT NULL DEFAULT '[]',
    "actionType" "AutomationActionType" NOT NULL DEFAULT 'webhook',
    "actionConfig" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Automation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomationRun" (
    "id" TEXT NOT NULL,
    "automationId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "status" "AutomationRunStatus" NOT NULL DEFAULT 'queued',
    "trigger" "AutomationTriggerEvent" NOT NULL,
    "eventPayload" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "responseStatus" INTEGER,
    "responseBody" TEXT,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "AutomationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamApiKey" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "tokenPrefix" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "TeamApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Automation_teamId_trigger_enabled_idx" ON "Automation"("teamId", "trigger", "enabled");

-- CreateIndex
CREATE INDEX "AutomationRun_automationId_startedAt_idx" ON "AutomationRun"("automationId", "startedAt" DESC);

-- CreateIndex
CREATE INDEX "AutomationRun_teamId_startedAt_idx" ON "AutomationRun"("teamId", "startedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "TeamApiKey_tokenHash_key" ON "TeamApiKey"("tokenHash");

-- CreateIndex
CREATE INDEX "TeamApiKey_teamId_revokedAt_idx" ON "TeamApiKey"("teamId", "revokedAt");

-- AddForeignKey
ALTER TABLE "Automation" ADD CONSTRAINT "Automation_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationRun" ADD CONSTRAINT "AutomationRun_automationId_fkey" FOREIGN KEY ("automationId") REFERENCES "Automation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationRun" ADD CONSTRAINT "AutomationRun_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamApiKey" ADD CONSTRAINT "TeamApiKey_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
