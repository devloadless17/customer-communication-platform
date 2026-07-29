-- Finish the adoption `20260728120000` deliberately could not complete.
--
-- THE LEFTOVER. That migration adopted legacy `wabaId = ''` templates into
-- their workspace's real WABA, and correctly refused to DELETE a `''` duplicate
-- carrying `variableBindings` — bindings are the one thing a Meta re-sync
-- cannot give back. But step 2 then SKIPPED those same rows, because the
-- `(workspaceId, wabaId, name, language)` slot they would move into is already
-- occupied by the real row. So a `''` row with bindings survives forever,
-- holding the ONLY copy of the mappings, while the live row under the real
-- WABA — the one the catalog sync maintains and the composer sends from — has
-- none. The workspace also sees the template twice.
--
-- Preserving the row preserved the defect with it. Merge instead: copy the
-- bindings onto the live row, THEN drop the orphan.
--
-- WHAT THIS IS NOT. It is not an analytics fix. A stranded row can only exist
-- in a workspace that had exactly ONE WABA when `20260728120000` ran (that was
-- its adoption condition), and `refreshTemplateAnalytics` resolves a
-- ""-WABA template fine while a workspace has one WABA — it only throws
-- `template_waba_unresolved` once a SECOND distinct WABA is connected. So the
-- immediate harm is the stranded bindings and the duplicate; the analytics
-- blackout is a LATER consequence, if that workspace ever adds a second number.
-- Merging now removes both.
--
-- SAFETY:
--   * Only touches rows whose live counterpart already exists — never the
--     `''` rows that ARE the only copy of a template (those stay untouched and
--     still adopt on the next catalog sync).
--   * Only writes bindings onto a live row that has NONE, so a real mapping
--     someone has since configured is never overwritten.
--   * Idempotent: after it runs there are no matching rows, so a re-run is a
--     no-op.

-- 1. Move the bindings onto the live row, but only where the live row has none.
UPDATE "MessageTemplate" live
SET    "variableBindings" = legacy."variableBindings"
FROM   "MessageTemplate" legacy
WHERE  legacy."wabaId" = ''
  AND  live."wabaId" <> ''
  AND  live."workspaceId" = legacy."workspaceId"
  AND  live."name"        = legacy."name"
  AND  live."language"    = legacy."language"
  AND  legacy."variableBindings" IS NOT NULL
  AND  legacy."variableBindings"::text NOT IN ('{}', 'null')
  AND  (live."variableBindings" IS NULL
        OR live."variableBindings"::text IN ('{}', 'null'));

-- 2. Drop the now-redundant legacy duplicates. Their bindings are either
--    already on the live row (step 1) or the live row had its own, which wins.
DELETE FROM "MessageTemplate" legacy
USING  "MessageTemplate" live
WHERE  legacy."wabaId" = ''
  AND  live."wabaId" <> ''
  AND  live."workspaceId" = legacy."workspaceId"
  AND  live."name"        = legacy."name"
  AND  live."language"    = legacy."language";
