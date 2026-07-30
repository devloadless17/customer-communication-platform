-- The WABA becomes a first-class entity.
--
-- Meta's hierarchy is business portfolio → WABA → business phone number. Until
-- now a phone number was a row (`ChannelConnection`), a WABA was a bare string
-- column repeated on every number (plus a duplicate copy inside `config` JSON),
-- and a portfolio was a row reachable only from the number. Two consequences this
-- migration fixes:
--
--   1. A WABA WITH NO PHONE NUMBERS could not exist. Embedded Signup's
--      `FINISH_ONLY_WABA` finish event is exactly that — a completed onboarding
--      with no number — and its template + account-level webhooks start arriving
--      immediately.
--   2. `MessageTemplate.wabaId` carried a `""` "unknown WABA" sentinel, and the
--      cross-account send guard only refuses when BOTH sides are known and
--      differ. So a legacy template was sendable from any account, and a
--      connection whose WABA was never pasted could send any template in the
--      workspace. A NOT NULL FK makes that unrepresentable.
--
-- ⚠️  This migration DROPs columns. A `DROP COLUMN` silently destroys every index
-- keyed on that column — during the org→workspace rename it took out six raw
-- partial indexes. Verified before writing this: no index in the hand-maintained
-- section at the bottom of `0_init/migration.sql` references `wabaId`,
-- `portfolioId` or `insightsEnabledAt`, and `ChannelConnection_one_default_per_channel`
-- is keyed on ("workspaceId", channel) WHERE "isDefault", so it survives. Re-run
-- `apps/api/test/partial-indexes.spec.ts` after applying.

-- ── 1. Portfolio: provenance + Meta's registered-number cap ─────────────────
CREATE TYPE "WhatsappPortfolioSource" AS ENUM ('embedded_signup', 'graph_discovered', 'local');

ALTER TABLE "WhatsappPortfolio"
  ADD COLUMN "source" "WhatsappPortfolioSource" NOT NULL DEFAULT 'local',
  ADD COLUMN "maxPhoneNumbers" INTEGER;

-- Anything that already carries an external id was read back from Graph; the
-- rest are the locally-minted containers the health self-heal creates.
UPDATE "WhatsappPortfolio" SET "source" = 'graph_discovered'
 WHERE "externalPortfolioId" IS NOT NULL;

-- ── 2. The WABA entity ──────────────────────────────────────────────────────
CREATE TABLE "WhatsappBusinessAccount" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "externalWabaId" TEXT NOT NULL,
  "portfolioId" TEXT,
  "label" TEXT,
  "secrets" JSONB NOT NULL DEFAULT '{}',
  "subscribedAt" TIMESTAMP(3),
  "insightsEnabledAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WhatsappBusinessAccount_pkey" PRIMARY KEY ("id")
);

-- GLOBALLY unique, not per-workspace. Meta delivers a WABA's webhooks to
-- whichever app is subscribed to it, so two workspaces claiming one WABA means
-- one silently receives nothing — and under the app-level callback (workspace
-- resolved FROM the payload) it would route one tenant's messages into another
-- tenant's inbox. This index IS the tenancy guard, and it makes
-- payload → workspace a single indexed read.
CREATE UNIQUE INDEX "WhatsappBusinessAccount_externalWabaId_key"
  ON "WhatsappBusinessAccount"("externalWabaId");
CREATE INDEX "WhatsappBusinessAccount_workspaceId_idx"
  ON "WhatsappBusinessAccount"("workspaceId");
CREATE INDEX "WhatsappBusinessAccount_portfolioId_idx"
  ON "WhatsappBusinessAccount"("portfolioId");

ALTER TABLE "WhatsappBusinessAccount"
  ADD CONSTRAINT "WhatsappBusinessAccount_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "WhatsappBusinessAccount_portfolioId_fkey"
    FOREIGN KEY ("portfolioId") REFERENCES "WhatsappPortfolio"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- One row per REAL WABA id, carrying the portfolio + insights flag up from the
-- numbers that used to hold N copies of them. Because `externalWabaId` is
-- globally unique, a WABA pasted into two workspaces collapses to one row —
-- attributed to the oldest connection's workspace. There are no real clients; a
-- dev fixture that did this is a fixture bug, and the app now refuses the second
-- connect outright.
INSERT INTO "WhatsappBusinessAccount"
  ("id", "workspaceId", "externalWabaId", "portfolioId", "secrets", "insightsEnabledAt", "createdAt", "updatedAt")
SELECT
  gen_random_uuid()::text,
  (ARRAY_AGG(c."workspaceId" ORDER BY c."createdAt" ASC))[1],
  c."wabaId",
  (ARRAY_AGG(c."portfolioId" ORDER BY c."createdAt" ASC))[1],
  '{}'::jsonb,
  MIN(c."insightsEnabledAt"),
  MIN(c."createdAt"),
  NOW()
FROM "ChannelConnection" c
WHERE c.channel = 'whatsapp' AND c."wabaId" IS NOT NULL AND c."wabaId" <> ''
GROUP BY c."wabaId";

-- ── 3. Point phone numbers at their WABA ────────────────────────────────────
ALTER TABLE "ChannelConnection" ADD COLUMN "wabaAccountId" TEXT;

UPDATE "ChannelConnection" c SET "wabaAccountId" = w."id"
  FROM "WhatsappBusinessAccount" w
 WHERE w."externalWabaId" = c."wabaId";

CREATE INDEX "ChannelConnection_wabaAccountId_idx" ON "ChannelConnection"("wabaAccountId");
ALTER TABLE "ChannelConnection"
  ADD CONSTRAINT "ChannelConnection_wabaAccountId_fkey"
    FOREIGN KEY ("wabaAccountId") REFERENCES "WhatsappBusinessAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Strip the duplicate JSON copy. It was read by the send-config loader while the
-- column was read by template scoping, so the two could drift; the FK is now the
-- single authority and the loader joins it.
UPDATE "ChannelConnection"
   SET "config" = "config" - 'wabaId'
 WHERE channel = 'whatsapp' AND "config" ? 'wabaId';

-- ── 4. Templates: kill the "" sentinel ─────────────────────────────────────
ALTER TABLE "MessageTemplate" ADD COLUMN "wabaAccountId" TEXT;

UPDATE "MessageTemplate" t SET "wabaAccountId" = w."id"
  FROM "WhatsappBusinessAccount" w
 WHERE w."externalWabaId" = t."wabaId";

-- Adopt the `""` orphans where it is UNAMBIGUOUS: the workspace has exactly one
-- WABA and adopting wouldn't collide on (name, language). Adopt-then-delete
-- rather than delete-outright because a template's `variableBindings` are the one
-- thing a catalog re-sync cannot restore.
UPDATE "MessageTemplate" t
   SET "wabaAccountId" = w."id"
  FROM (
    SELECT "workspaceId", MIN("id") AS id, COUNT(*) AS n
      FROM "WhatsappBusinessAccount"
     GROUP BY "workspaceId"
  ) one
  JOIN "WhatsappBusinessAccount" w ON w."id" = one.id
 WHERE t."workspaceId" = one."workspaceId"
   AND one.n = 1
   AND t."wabaAccountId" IS NULL
   AND NOT EXISTS (
     SELECT 1 FROM "MessageTemplate" o
      WHERE o."workspaceId" = t."workspaceId"
        AND o."wabaAccountId" = w."id"
        AND o."name" = t."name"
        AND o."language" = t."language"
   );

-- Whatever is still unmapped belongs to a workspace with zero or several WABAs
-- and is therefore unsendable by definition — a catalog sync recreates it.
DELETE FROM "MessageTemplate" WHERE "wabaAccountId" IS NULL;

ALTER TABLE "MessageTemplate" ALTER COLUMN "wabaAccountId" SET NOT NULL;
ALTER TABLE "MessageTemplate"
  ADD CONSTRAINT "MessageTemplate_wabaAccountId_fkey"
    FOREIGN KEY ("wabaAccountId") REFERENCES "WhatsappBusinessAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

DROP INDEX IF EXISTS "MessageTemplate_workspaceId_wabaId_name_language_key";
CREATE UNIQUE INDEX "MessageTemplate_workspaceId_wabaAccountId_name_language_key"
  ON "MessageTemplate"("workspaceId", "wabaAccountId", "name", "language");
CREATE INDEX "MessageTemplate_wabaAccountId_idx" ON "MessageTemplate"("wabaAccountId");

ALTER TABLE "MessageTemplate" DROP COLUMN "wabaId";

-- ── 5. Retire the per-number copies ────────────────────────────────────────
-- `portfolioId` moves to the WABA (Meta puts `owner_business_info` on the WABA
-- node); `insightsEnabledAt` was a WABA-wide fact stored N times.
ALTER TABLE "ChannelConnection"
  DROP COLUMN "wabaId",
  DROP COLUMN "portfolioId",
  DROP COLUMN "insightsEnabledAt";
