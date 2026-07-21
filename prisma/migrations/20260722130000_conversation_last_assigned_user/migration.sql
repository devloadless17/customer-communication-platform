-- Conversation.lastAssignedUserId — the durable "who handled this customer
-- last" pointer that powers AssignmentPolicy.preferPreviousAgent.
--
-- WHY THIS IS A SEPARATE MIGRATION. The column belongs to
-- 20260722090000_assignment_routing, but the DDL never made it into that
-- file: the column was applied to the dev database by hand, and the drift
-- check that was supposed to catch the omission (`prisma migrate diff
-- --from-config-datasource`) compares the schema to the LIVE DATABASE — which
-- had the hand-applied column — so it reported clean. Production got the code
-- without the column and every `conversation.findMany` failed with P2022,
-- taking the whole inbox down.
--
-- 20260722090000 is already applied in production, so editing it would be a
-- no-op there (and would break its checksum). Forward-fix instead.
--
-- IF NOT EXISTS because environments are now in mixed states: the dev database
-- already has the column from the manual ALTER, production does not, and a
-- fresh database gets it from here. Idempotent DDL is correct for all three.
ALTER TABLE "Conversation" ADD COLUMN IF NOT EXISTS "lastAssignedUserId" TEXT;

-- Backfill: whoever currently holds a conversation is, trivially, who held it
-- last. Without this every existing thread looks like it has no history and
-- continuity routing stays dead until each one is reassigned once.
UPDATE "Conversation"
SET "lastAssignedUserId" = "assignedUserId"
WHERE "assignedUserId" IS NOT NULL AND "lastAssignedUserId" IS NULL;
