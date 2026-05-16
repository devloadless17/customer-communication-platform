-- Workflow engine migration. Replaces the single-action Automation tables
-- with a multi-step DAG Workflow model. Every existing Automation becomes a
-- single-step Workflow with the same trigger + conditions + a matching step.

-- ===========================================================================
-- 1. New enums
-- ===========================================================================

CREATE TYPE "WorkflowTriggerEvent" AS ENUM (
  'message_received',
  'conversation_created',
  'conversation_opened',
  'conversation_closed',
  'conversation_assigned',
  'conversation_status_changed',
  'contact_field_updated',
  'contact_tag_updated',
  'contact_lifecycle_updated',
  'manual_trigger',
  'incoming_webhook'
);

CREATE TYPE "WorkflowStepType" AS ENUM (
  'send_message',
  'send_template',
  'add_comment',
  'assign_to',
  'set_status',
  'open_conversation',
  'close_conversation',
  'add_tag',
  'remove_tag',
  'update_field',
  'update_lifecycle',
  'branch',
  'wait',
  'jump_to_step',
  'http_request',
  'trigger_workflow'
);

CREATE TYPE "WorkflowRunStatus" AS ENUM (
  'queued',
  'running',
  'waiting',
  'completed',
  'failed',
  'skipped'
);

-- ===========================================================================
-- 2. New tables
-- ===========================================================================

CREATE TABLE "Workflow" (
  "id"                      TEXT NOT NULL,
  "teamId"                  TEXT NOT NULL,
  "name"                    TEXT NOT NULL,
  "enabled"                 BOOLEAN NOT NULL DEFAULT true,
  "published"               BOOLEAN NOT NULL DEFAULT false,
  "trigger"                 "WorkflowTriggerEvent" NOT NULL,
  "triggerConfig"           JSONB NOT NULL DEFAULT '{}'::jsonb,
  "triggerConditions"       JSONB NOT NULL DEFAULT '{"op":"AND","children":[]}'::jsonb,
  "triggerOncePerContact"   BOOLEAN NOT NULL DEFAULT false,
  "graph"                   JSONB NOT NULL DEFAULT '{"startNodeId":"","nodes":[],"edges":[]}'::jsonb,
  "createdAt"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"               TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Workflow_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Workflow_teamId_trigger_enabled_published_idx"
  ON "Workflow"("teamId", "trigger", "enabled", "published");
CREATE UNIQUE INDEX "Workflow_teamId_name_key" ON "Workflow"("teamId", "name");

ALTER TABLE "Workflow"
  ADD CONSTRAINT "Workflow_teamId_fkey"
  FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE;

CREATE TABLE "WorkflowRun" (
  "id"             TEXT NOT NULL,
  "workflowId"     TEXT NOT NULL,
  "teamId"         TEXT NOT NULL,
  "status"         "WorkflowRunStatus" NOT NULL DEFAULT 'queued',
  "trigger"        "WorkflowTriggerEvent" NOT NULL,
  "contactId"      TEXT,
  "conversationId" TEXT,
  "eventPayload"   JSONB NOT NULL,
  "currentStepId"  TEXT,
  "waitUntil"      TIMESTAMP(3),
  "jumpsUsed"      INTEGER NOT NULL DEFAULT 0,
  "stepLog"        JSONB NOT NULL DEFAULT '[]'::jsonb,
  "attempts"       INTEGER NOT NULL DEFAULT 0,
  "errorMessage"   TEXT,
  "startedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt"     TIMESTAMP(3),
  CONSTRAINT "WorkflowRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "WorkflowRun_workflowId_startedAt_idx"
  ON "WorkflowRun"("workflowId", "startedAt" DESC);
CREATE INDEX "WorkflowRun_teamId_startedAt_idx"
  ON "WorkflowRun"("teamId", "startedAt" DESC);
CREATE INDEX "WorkflowRun_status_waitUntil_idx"
  ON "WorkflowRun"("status", "waitUntil");

ALTER TABLE "WorkflowRun"
  ADD CONSTRAINT "WorkflowRun_workflowId_fkey"
  FOREIGN KEY ("workflowId") REFERENCES "Workflow"("id") ON DELETE CASCADE;
ALTER TABLE "WorkflowRun"
  ADD CONSTRAINT "WorkflowRun_teamId_fkey"
  FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE;

CREATE TABLE "WorkflowContactState" (
  "id"         TEXT NOT NULL,
  "workflowId" TEXT NOT NULL,
  "contactId"  TEXT NOT NULL,
  "teamId"     TEXT NOT NULL,
  "firedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WorkflowContactState_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WorkflowContactState_workflowId_contactId_key"
  ON "WorkflowContactState"("workflowId", "contactId");
CREATE INDEX "WorkflowContactState_teamId_idx"
  ON "WorkflowContactState"("teamId");

ALTER TABLE "WorkflowContactState"
  ADD CONSTRAINT "WorkflowContactState_workflowId_fkey"
  FOREIGN KEY ("workflowId") REFERENCES "Workflow"("id") ON DELETE CASCADE;
ALTER TABLE "WorkflowContactState"
  ADD CONSTRAINT "WorkflowContactState_teamId_fkey"
  FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE;

-- ===========================================================================
-- 3. Conversation analytics columns
-- ===========================================================================

ALTER TABLE "Conversation"
  ADD COLUMN "firstAssignedAt" TIMESTAMP(3),
  ADD COLUMN "firstAssignedUserId" TEXT,
  ADD COLUMN "lastAssignedAt" TIMESTAMP(3),
  ADD COLUMN "firstResponseAt" TIMESTAMP(3),
  ADD COLUMN "firstResponseByUserId" TEXT,
  ADD COLUMN "closedAt" TIMESTAMP(3),
  ADD COLUMN "closedByUserId" TEXT,
  ADD COLUMN "closedCategory" TEXT,
  ADD COLUMN "closedSummary" TEXT,
  ADD COLUMN "assignmentsCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "incomingMessagesCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "outgoingMessagesCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "responsesCount" INTEGER NOT NULL DEFAULT 0;

-- ===========================================================================
-- 4. Migrate Automation rows → single-step Workflow rows
-- ===========================================================================
--
-- For each existing Automation we build a Workflow with:
--   - a single step matching the old action type
--   - the same trigger + conditions (legacy flat-array conditions are wrapped
--     into a single AND group via jsonb_build_object)
--   - published = enabled (old rows didn't have publish state)
--   - graph.startNodeId = the synthetic single-step id "s1"
--
-- Action-type mapping:
--   webhook        → http_request
--   send_template  → send_template
--   assign_to_user → assign_to
--   set_status     → set_status
--   add_tag        → add_tag

INSERT INTO "Workflow" (
  "id", "teamId", "name", "enabled", "published", "trigger",
  "triggerConfig", "triggerConditions", "triggerOncePerContact",
  "graph", "createdAt", "updatedAt"
)
SELECT
  a."id",
  a."teamId",
  a."name",
  a."enabled",
  a."enabled",  -- published mirrors enabled for migrated rules
  a."trigger"::text::"WorkflowTriggerEvent",
  '{}'::jsonb,
  -- Lift legacy conditions to canonical group shape. The runtime accepts
  -- either, but storing canonical lets the new UI render without coercion.
  CASE
    WHEN jsonb_typeof(a."conditions") = 'array' THEN
      jsonb_build_object('op', 'AND', 'children', a."conditions")
    ELSE a."conditions"
  END,
  false,
  jsonb_build_object(
    'startNodeId', 's1',
    'nodes', jsonb_build_array(
      jsonb_build_object(
        'id', 's1',
        'type', CASE a."actionType"::text
          WHEN 'webhook' THEN 'http_request'
          WHEN 'assign_to_user' THEN 'assign_to'
          ELSE a."actionType"::text
        END,
        'config', a."actionConfig",
        'position', jsonb_build_object('x', 0, 'y', 200)
      )
    ),
    'edges', jsonb_build_array()
  ),
  a."createdAt",
  a."updatedAt"
FROM "Automation" a;

-- Migrate run history. Old rows had only a single action; we synthesize a
-- one-element stepLog so the UI's per-step view still shows something.
INSERT INTO "WorkflowRun" (
  "id", "workflowId", "teamId", "status", "trigger",
  "contactId", "conversationId", "eventPayload",
  "currentStepId", "stepLog", "attempts",
  "errorMessage", "startedAt", "finishedAt"
)
SELECT
  ar."id",
  ar."automationId",
  ar."teamId",
  CASE ar."status"::text
    WHEN 'success' THEN 'completed'::"WorkflowRunStatus"
    WHEN 'failed'  THEN 'failed'::"WorkflowRunStatus"
    WHEN 'queued'  THEN 'queued'::"WorkflowRunStatus"
    WHEN 'running' THEN 'running'::"WorkflowRunStatus"
    WHEN 'skipped' THEN 'skipped'::"WorkflowRunStatus"
  END,
  ar."trigger"::text::"WorkflowTriggerEvent",
  -- Best-effort: pull contactId / conversationId out of the snapshot
  -- if it's there. Falls back to null when not present.
  ar."eventPayload" #>> '{contact,id}',
  ar."eventPayload" #>> '{conversation,id}',
  ar."eventPayload",
  NULL,
  jsonb_build_array(
    jsonb_build_object(
      'stepId', 's1',
      'type', 'legacy',
      'status', ar."status"::text,
      'startedAt', ar."startedAt",
      'finishedAt', ar."finishedAt",
      'responseStatus', ar."responseStatus",
      'responseBody', ar."responseBody",
      'errorMessage', ar."errorMessage"
    )
  ),
  ar."attempts",
  ar."errorMessage",
  ar."startedAt",
  ar."finishedAt"
FROM "AutomationRun" ar;

-- ===========================================================================
-- 5. Drop old tables + enums
-- ===========================================================================

DROP TABLE "AutomationRun";
DROP TABLE "Automation";
DROP TYPE "AutomationRunStatus";
DROP TYPE "AutomationActionType";
DROP TYPE "AutomationTriggerEvent";
