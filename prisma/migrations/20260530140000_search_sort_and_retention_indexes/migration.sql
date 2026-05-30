-- Search-sort + retention indexes from the comprehensive production audit
-- (2026-05-30). Three hot-path scans were going to seq-scan / sort-in-memory
-- as tables grow:
--
-- 1+2. Team-wide global search (Messages tab + Comments tab). The trgm GIN
--      indexes (Message_body_trgm_idx / InternalNote_body_trgm_idx) serve the
--      ILIKE filter, but the query then does ORDER BY (timestamp DESC, id DESC)
--      with no composite to satisfy it. A broad search term returns a large GIN
--      bitmap that Postgres sorts in memory before applying LIMIT. The
--      composite btrees below let the planner walk newest-first and stop at
--      LIMIT for broad terms; selective terms still ride the trgm path. These
--      ARE representable in the Prisma DSL, so they're also declared as
--      `@@index` in schema.prisma (kept in sync; this migration is the DB side).
--
-- 3.   WorkflowRun retention sweep. The retention sweeper
--      (apps/api/src/lib/sweepers/workflow-run-retention.ts) runs
--        findMany({ status: { in: ['completed','failed','skipped'] },
--                   startedAt: { lt: cutoff } })
--      The existing partial WorkflowRun_active_startedAt_idx covers the
--      COMPLEMENT (queued/running/waiting), so the retention sweep had no usable
--      index and seq-scanned the terminal bulk (the overwhelming majority of
--      rows) every run. A partial on the terminal-status subset prunes it.
--      Prisma DSL can't express `WHERE status IN (...)`, so this one is
--      hand-written + permanent, same as the other partial indexes.
--
-- CONCURRENTLY skipped: these run at migration time. A brief write lock during
-- the initial build is acceptable on a freshly-rolled / pilot-scale schema.

CREATE INDEX IF NOT EXISTS "Message_teamId_timestamp_id_idx"
  ON public."Message" ("teamId", "timestamp" DESC, "id" DESC);

CREATE INDEX IF NOT EXISTS "InternalNote_teamId_timestamp_id_idx"
  ON public."InternalNote" ("teamId", "timestamp" DESC, "id" DESC);

CREATE INDEX IF NOT EXISTS "WorkflowRun_terminal_startedAt_idx"
  ON public."WorkflowRun" ("startedAt")
  WHERE status IN ('completed', 'failed', 'skipped');
