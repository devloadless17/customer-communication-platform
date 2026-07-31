-- Team report (/reports/team) windowed per-agent aggregates
-- (lib/analytics/team-report.ts).
--
-- Call: "calls placed / answered per agent in a date range" filters
-- (workspaceId, ringingAt) with no status predicate — the existing
-- (workspaceId, status, ringingAt) index puts status before the range column
-- and can't serve it.
CREATE INDEX "Call_workspaceId_ringingAt_idx" ON "Call"("workspaceId", "ringingAt");

-- ConversationEvent: "conversations assigned per agent in window" filters
-- (workspaceId, kind='assigned') over an `at` range, grouping by the assignee
-- inside `after`. Existing indexes lead with conversationId / at / userId.
-- kind='assigned' rows are exempt from the retention sweeper (the permanent
-- assignment ledger), so this index also stays useful past the 90d horizon.
CREATE INDEX "ConversationEvent_workspaceId_kind_at_idx" ON "ConversationEvent"("workspaceId", "kind", "at");
