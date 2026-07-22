-- Ticket workflow steps.
--
-- Enum-only. The four values are added in one migration: Postgres 12+ permits
-- several ADD VALUEs in a transaction as long as none is USED in that same
-- transaction, and nothing here writes a step row.

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "WorkflowStepType" ADD VALUE 'create_ticket';
ALTER TYPE "WorkflowStepType" ADD VALUE 'set_ticket_status';
ALTER TYPE "WorkflowStepType" ADD VALUE 'set_ticket_priority';
ALTER TYPE "WorkflowStepType" ADD VALUE 'assign_ticket';

