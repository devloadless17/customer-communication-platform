-- AlterTable: pin the workflow graph onto each run at creation time so a
-- mid-run edit can't corrupt an in-flight run (see WorkflowRun.graphSnapshot
-- + apps/api/src/lib/workflows/runner.ts). Nullable; runs created before this
-- column fall back to the live Workflow.graph.
ALTER TABLE "WorkflowRun" ADD COLUMN     "graphSnapshot" JSONB;

-- NOTE: `prisma migrate dev` re-adds a spurious `DROP INDEX
-- "Contact_customFields_gin_idx"` on every diff because that GIN index is
-- hand-written raw SQL the Prisma DSL can't model. It was stripped here on
-- purpose — do NOT let a generated migration drop the live index.
