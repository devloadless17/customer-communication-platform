-- NOTE: spurious DROP INDEX "Contact_customFields_gin_idx" stripped — the
-- index is hand-managed in the init migration's raw-SQL section. Same drift
-- quirk as the prior migrations; see schema.prisma's Contact model comment.

-- AlterTable
ALTER TABLE "WorkflowRun" ADD COLUMN     "stepOutputs" JSONB NOT NULL DEFAULT '{}';
