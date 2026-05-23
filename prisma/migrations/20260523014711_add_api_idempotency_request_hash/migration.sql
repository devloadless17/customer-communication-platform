-- AlterTable
ALTER TABLE "ApiIdempotencyKey" ADD COLUMN     "requestHash" TEXT;

-- NOTE: `prisma migrate dev` re-adds a spurious `DROP INDEX
-- "Contact_customFields_gin_idx"` on every diff because that GIN index is
-- hand-written in 0_init (USING GIN ("customFields" jsonb_path_ops)) and is
-- NOT represented in schema.prisma. It was STRIPPED from this migration —
-- applying it on deploy would drop a production index. Same fix + rationale as
-- 20260522155859_workflow_run_graph_snapshot. Do NOT let the DROP back in.
