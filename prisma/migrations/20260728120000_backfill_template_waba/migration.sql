-- Adopt legacy `wabaId = ''` templates into their workspace's WABA.
--
-- `MessageTemplate.wabaId` was added with multi-account; every row synced
-- before it carries the `''` sentinel. That sentinel is not just cosmetic:
-- `refreshTemplateAnalytics` has no catalog to resolve the owning account
-- from, so on a workspace that later connected a second number the fetch
-- refused and Meta's ~7-day analytics horizon passed with the read/click
-- counts never captured. That loss is permanent and silent.
--
-- Adopt ONLY where the answer is unambiguous: the workspace has exactly ONE
-- distinct real WABA across its WhatsApp connections. A workspace with two
-- genuinely cannot be resolved here, and guessing would point a template's
-- whole analytics history at the wrong business account — those rows are left
-- alone and the app now says so loudly instead of failing as "not configured".

-- Step 1: drop `''` duplicates that a later per-WABA sync already re-created
-- under the real id. Without this the UPDATE below violates
-- `MessageTemplate_workspaceId_wabaId_name_language_key`.
--
-- `variableBindings` is the ONE thing Meta cannot give back on a re-sync, so a
-- legacy row carrying bindings is NEVER deleted — it keeps its `''` and stays
-- visible. Only genuinely redundant duplicates go.
DELETE FROM "MessageTemplate" legacy
USING "MessageTemplate" real
WHERE legacy."wabaId" = ''
  AND real."wabaId" <> ''
  AND real."workspaceId" = legacy."workspaceId"
  AND real."name" = legacy."name"
  AND real."language" = legacy."language"
  AND (
    legacy."variableBindings" IS NULL
    OR legacy."variableBindings"::text IN ('{}', 'null')
  )
  AND legacy."workspaceId" IN (
    SELECT "workspaceId"
    FROM "ChannelConnection"
    WHERE channel = 'whatsapp' AND "wabaId" IS NOT NULL AND "wabaId" <> ''
    GROUP BY "workspaceId"
    HAVING COUNT(DISTINCT "wabaId") = 1
  );

-- Step 2: stamp the remaining `''` rows with the workspace's sole WABA.
UPDATE "MessageTemplate" t
SET "wabaId" = w.waba
FROM (
  SELECT "workspaceId", MIN("wabaId") AS waba
  FROM "ChannelConnection"
  WHERE channel = 'whatsapp' AND "wabaId" IS NOT NULL AND "wabaId" <> ''
  GROUP BY "workspaceId"
  HAVING COUNT(DISTINCT "wabaId") = 1
) w
WHERE t."workspaceId" = w."workspaceId"
  AND t."wabaId" = ''
  -- Belt-and-braces against the unique key: skip any row whose target slot is
  -- still occupied (a duplicate step 1 preserved because it had bindings).
  AND NOT EXISTS (
    SELECT 1 FROM "MessageTemplate" other
    WHERE other."workspaceId" = t."workspaceId"
      AND other."wabaId" = w.waba
      AND other."name" = t."name"
      AND other."language" = t."language"
  );
