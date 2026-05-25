-- Two indexes the schema's doc-comments DESCRIBE as already existing "in the
-- init migration's raw-SQL section" but which were never actually written into
-- any migration (verified absent from every migration file AND from the live
-- dev DB — both tables had only their primary key / the name-unique). This
-- migration makes the comments true.

-- 1) OutboundEvent drainer hot-path.
-- The transactional-outbox drainer (apps/api/src/lib/events/outbox.ts) polls
-- every ~100ms with:
--   WHERE publishedAt IS NULL AND failedAt IS NULL
--   ORDER BY createdAt ASC LIMIT n FOR UPDATE SKIP LOCKED
-- With no supporting index this is a full Seq Scan + Sort of the WHOLE
-- OutboundEvent table on every tick. Published rows accumulate indefinitely
-- (no cleanup sweep wired yet), so the per-poll cost grows linearly with the
-- table's lifetime size — the single most frequent query in the system slowly
-- degrades. A partial index on the pending predicate keeps it to the handful
-- of unpublished rows. Ordered by createdAt to also serve the ORDER BY.
-- No teamId in the index on purpose: the drainer never filters by team.
CREATE INDEX IF NOT EXISTS "OutboundEvent_drainer_pending_idx"
  ON "OutboundEvent" ("createdAt")
  WHERE "publishedAt" IS NULL AND "failedAt" IS NULL;

-- 2) ContactStage one-default-per-team correctness backstop.
-- The schema comment (model ContactStage) claims at-most-one default stage per
-- team "is enforced by a partial unique index … the app-code pre-check is no
-- longer load-bearing for correctness." That index didn't exist, so the only
-- guard was the non-Serializable ensureDefaultStage() read-modify-write — two
-- concurrent first-contact ingests for a brand-new team could each create a
-- default, yielding two isDefault=true rows with nothing to catch it. This
-- restores the DB-level guarantee the comment promises.
-- Pre-flight de-dup (defensive — keep the lowest-position default per team if a
-- duplicate somehow already exists) so the unique index can be created.
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY "teamId"
           ORDER BY "position" ASC, "id" ASC
         ) AS rn
  FROM "ContactStage"
  WHERE "isDefault" = true
)
UPDATE "ContactStage" cs
SET "isDefault" = false
FROM ranked
WHERE cs.id = ranked.id AND ranked.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS "ContactStage_teamId_isDefault_key"
  ON "ContactStage" ("teamId")
  WHERE "isDefault" = true;
