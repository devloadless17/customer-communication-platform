-- Drop the contact-level "account manager" assignee. Conversation.assignedUserId
-- is now the single source of truth for assignment; the denormalized
-- Contact.assignedUserId mirror, its external /v1 contact field, the
-- contact.assignee_changed webhook event, and the
-- $var.contact.assigned_agent_name template token were all removed alongside
-- this. This discards the column's data (backfilled in
-- 20260520080945_backfill_contact_assigned_user_id_from_conversation) on
-- purpose — the feature is being removed, not paused.

-- DropForeignKey
ALTER TABLE "Contact" DROP CONSTRAINT "Contact_assignedUserId_fkey";

-- DropIndex
DROP INDEX "Contact_teamId_assignedUserId_idx";

-- AlterTable
ALTER TABLE "Contact" DROP COLUMN "assignedUserId";
