-- AlterEnum
ALTER TYPE "WorkflowStepType" ADD VALUE 'noop';

-- NOTE: Prisma's migrate-dev emitter wanted to DROP INDEX
-- "Contact_customFields_gin_idx" here. That index is intentionally hand-
-- managed in the raw-SQL section of the init migration; see the comment
-- on the Contact model in schema.prisma for the full explanation.
-- Stripped manually so this migration doesn't drop a live, hand-managed
-- index — same precedent as the paused-status migration that came before.
