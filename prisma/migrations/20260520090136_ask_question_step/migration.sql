-- NOTE: spurious DROP INDEX "Contact_customFields_gin_idx" stripped — the
-- index is hand-managed in the init migration's raw-SQL section. Same drift
-- quirk as the prior migrations; see schema.prisma's Contact model comment.

-- AlterEnum
ALTER TYPE "WorkflowStepType" ADD VALUE 'ask_question';

-- AlterTable
ALTER TABLE "WorkflowRun" ADD COLUMN     "pendingAnswer" JSONB;

-- CreateTable
CREATE TABLE "WorkflowAwaitingReply" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "stepId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkflowAwaitingReply_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowAwaitingReply_runId_key" ON "WorkflowAwaitingReply"("runId");

-- CreateIndex
CREATE INDEX "WorkflowAwaitingReply_teamId_contactId_idx" ON "WorkflowAwaitingReply"("teamId", "contactId");

-- CreateIndex
CREATE INDEX "WorkflowAwaitingReply_expiresAt_idx" ON "WorkflowAwaitingReply"("expiresAt");

-- AddForeignKey
ALTER TABLE "WorkflowAwaitingReply" ADD CONSTRAINT "WorkflowAwaitingReply_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowAwaitingReply" ADD CONSTRAINT "WorkflowAwaitingReply_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowAwaitingReply" ADD CONSTRAINT "WorkflowAwaitingReply_runId_fkey" FOREIGN KEY ("runId") REFERENCES "WorkflowRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowAwaitingReply" ADD CONSTRAINT "WorkflowAwaitingReply_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "Workflow"("id") ON DELETE CASCADE ON UPDATE CASCADE;
