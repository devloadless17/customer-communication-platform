-- At most ONE active (pending|running) contact transfer per team.
--
-- The service already checks this with a COUNT before inserting, but that is a
-- read-then-write with no lock: two requests that arrive together both see zero
-- and both insert. The consequence isn't cosmetic — two concurrent 100k
-- transfers for one tenant is exactly the memory/CPU spike the per-team cap
-- exists to prevent on a shared single-VPS deployment.
--
-- Prisma's DSL can't express a partial unique index, so it lives here as raw
-- SQL (same approach as ContactStage_teamId_isDefault_key). The service maps the
-- resulting P2002 to the same 409 its pre-check returns, so the friendly error
-- path is unchanged and this is purely the backstop.
CREATE UNIQUE INDEX IF NOT EXISTS "ContactTransferJob_teamId_active_key"
  ON "ContactTransferJob"("teamId")
  WHERE status IN ('pending', 'running');
