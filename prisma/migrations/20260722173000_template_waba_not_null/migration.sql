-- `MessageTemplate.wabaId` joins the uniqueness key, so it must be NOT NULL:
-- Postgres considers NULLs distinct, which would let two templates share a
-- (workspace, name, language) whenever the WABA was unknown. Empty string is
-- the explicit "legacy/unknown WABA" marker.
UPDATE "MessageTemplate" SET "wabaId" = '' WHERE "wabaId" IS NULL;
ALTER TABLE "MessageTemplate" ALTER COLUMN "wabaId" SET DEFAULT '';
ALTER TABLE "MessageTemplate" ALTER COLUMN "wabaId" SET NOT NULL;
