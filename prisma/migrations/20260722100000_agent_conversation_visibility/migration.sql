-- Per-organization agent conversation visibility.
--
-- "team" (default) reproduces existing behavior exactly: every member sees
-- every conversation. "assigned" restricts role `agent` to the conversations
-- currently assigned to them; admin/manager/superAdmin are never restricted.
--
-- Scoping keys on the CURRENT assignee, not on who wrote what, so reassigning
-- a thread hands over its FULL history to the new owner.
ALTER TABLE "Team" ADD COLUMN "agentConversationVisibility" TEXT NOT NULL DEFAULT 'team';
