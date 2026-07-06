-- Reclassify historical broadcasts where EVERY recipient failed.
--
-- Before the runner set the discrete `failed` status on the all-recipients-
-- failed path, such runs were stored as `completed`. That made them match the
-- "Completed" filter while the (count-aware) badge painted them red "All
-- failed", and the "Failed" filter showed nothing. This backfill aligns the
-- stored enum with the runner's new behavior so old rows filter correctly too.
--
-- Partial failures (failedCount > 0 but < totalCount) intentionally stay
-- `completed` — the badge renders those amber "N failed".
UPDATE "Broadcast"
SET "status" = 'failed'
WHERE "status" = 'completed'
  AND "totalCount" > 0
  AND "failedCount" >= "totalCount";
