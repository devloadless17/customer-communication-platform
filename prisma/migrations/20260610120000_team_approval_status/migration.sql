-- Org-approval gate: Team.status lifecycle (pending → active → suspended).
--
-- Hand-written ADDITIVE migration (NOT generated via `prisma migrate dev`) so
-- the backfill below is preserved and the squashed `0_init` migration + its
-- hand-written GIN / partial indexes are never touched. See
-- project_migrations_squashed_to_single_init memory + schema.prisma header.

-- CreateEnum
CREATE TYPE "TeamStatus" AS ENUM ('pending', 'active', 'suspended');

-- AlterTable: new orgs default to `pending` (locked until a superAdmin approves).
ALTER TABLE "Team" ADD COLUMN     "status" "TeamStatus" NOT NULL DEFAULT 'pending';
ALTER TABLE "Team" ADD COLUMN     "statusReason" TEXT;
ALTER TABLE "Team" ADD COLUMN     "statusUpdatedAt" TIMESTAMP(3);
ALTER TABLE "Team" ADD COLUMN     "statusUpdatedById" TEXT;

-- Grandfather every PRE-EXISTING org to `active`. This migration runs once, so
-- only rows that already exist (the pilot customer + the Loadless super-admin
-- team) are affected — they predate the approval gate and must not be locked
-- out. Every org created AFTER this point gets the column default (`pending`)
-- and goes through super-admin review.
UPDATE "Team" SET "status" = 'active';
