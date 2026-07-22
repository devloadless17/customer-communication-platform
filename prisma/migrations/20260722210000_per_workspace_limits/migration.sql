-- Seat caps move from the ORGANISATION to each WORKSPACE, and the organisation
-- instead caps how many workspaces it may create.
--
-- Rationale: after the workspaces restructure a member belongs to a WORKSPACE,
-- not to the organisation as a whole, so a single org-wide seat pool no longer
-- describes anything real. The org-level knob becomes "how many workspaces",
-- which is the thing an organisation actually buys.
--
-- Both are super-admin controlled and both default to 2, matching the previous
-- default so nothing changes for a single-workspace org.

-- 1. Per-workspace seat cap.
ALTER TABLE "Workspace" ADD COLUMN IF NOT EXISTS "maxMembers" INTEGER NOT NULL DEFAULT 2;

-- 2. BACKFILL BEFORE DROPPING. An org whose limit was raised (say to 10) must
--    keep that headroom on its workspaces — dropping the column first would
--    silently reset every one of them to 2 and lock members out of a workspace
--    they already belong to. Runs before step 4 for exactly that reason.
UPDATE "Workspace" w
SET "maxMembers" = o."maxMembers"
FROM "Organization" o
WHERE w."organizationId" = o."id"
  AND o."maxMembers" IS NOT NULL
  AND o."maxMembers" > 0;

-- 3. Per-organisation workspace cap.
ALTER TABLE "Organization" ADD COLUMN IF NOT EXISTS "maxWorkspaces" INTEGER NOT NULL DEFAULT 2;

-- 3b. Any org already holding more workspaces than the new default keeps them:
--     raise its cap to what it actually has, so the limit never retroactively
--     puts an org in violation of a rule that did not exist when it grew.
UPDATE "Organization" o
SET "maxWorkspaces" = GREATEST(o."maxWorkspaces", c.n)
FROM (SELECT "organizationId", COUNT(*)::int AS n FROM "Workspace" GROUP BY "organizationId") c
WHERE c."organizationId" = o."id" AND c.n > o."maxWorkspaces";

-- 4. The org-wide seat pool is gone.
ALTER TABLE "Organization" DROP COLUMN IF EXISTS "maxMembers";
