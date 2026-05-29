-- Partial indexes from the final pre-deploy audit (2026-05-29).
--
-- Two hot-path scans were going to seq-scan as tables grow:
--
-- 1. WorkflowRun.startedAt-by-status sweeper. The waiting-recovery sweeper
--    (apps/api/src/lib/sweepers/workflow-waiting.ts) runs
--      findMany({ status: 'queued', startedAt: { lte: cutoff } })
--    Existing indexes lead with `status` + `waitUntil` (NULL on queued
--    rows = mostly tombstones) or `(teamId, startedAt DESC)` (doesn't
--    help a status-filter without teamId). Once WorkflowRun grows past a
--    week of retention, this becomes a multi-second seq-scan every 60s
--    holding a connection. A partial on `startedAt` keyed to the active
--    enum subset prunes the entire completed/failed/skipped bulk.
--
-- 2. Contact.deletedAt-IS-NULL filter is used in 20+ hot-path queries
--    (contacts list, broadcast audience expansion, external-v1 reads,
--    audience-group resolution, global search). The existing index
--    `Contact_teamId_deletedAt_idx` is FULL — soft-deletes are rare
--    (<1% of rows), so a partial WHERE deletedAt IS NULL would be
--    ~5-10x smaller AND faster for the dominant query shape. Keep the
--    existing full index for the rare soft-deleted lookup paths.
--
-- Both Prisma-DSL-unrepresentable (no `WHERE ... IS NULL` predicate
-- support). Hand-written, marked permanent same as the other partials.
--
-- CONCURRENTLY skipped: these run at migration time. Brief write lock
-- during initial build is acceptable.

CREATE INDEX IF NOT EXISTS "WorkflowRun_active_startedAt_idx"
  ON public."WorkflowRun" ("startedAt")
  WHERE status IN ('queued', 'running', 'waiting');

CREATE INDEX IF NOT EXISTS "Contact_teamId_active_idx"
  ON public."Contact" ("teamId")
  WHERE "deletedAt" IS NULL;
