-- Drop the now-redundant Workflow.enabled kill switch.
--
-- The editor collapsed to a single Draft↔Live control (2026-05-22), so
-- `published` alone gates execution: the dispatcher / runner / manual /
-- incoming-webhook / trigger_workflow paths all key off `published = true`.
-- Nothing set `enabled = false` anymore, so the column carried no independent
-- information. Going Live used to force `enabled = true`, so every live row's
-- flag is already true — no data is lost. Any legacy row left published-but-
-- disabled now simply runs (which is what "published" was always meant to mean).

-- DropIndex (the old hot-path index included `enabled`)
DROP INDEX "Workflow_teamId_trigger_enabled_published_idx";

-- AlterTable
ALTER TABLE "Workflow" DROP COLUMN "enabled";

-- CreateIndex (hot path: dispatcher loads WHERE teamId=? AND trigger=? AND published=true)
CREATE INDEX "Workflow_teamId_trigger_published_idx" ON "Workflow"("teamId", "trigger", "published");
