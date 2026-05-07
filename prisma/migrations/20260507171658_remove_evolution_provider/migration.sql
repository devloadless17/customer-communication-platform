-- Drop `evolution` from the ProviderName enum. We removed the Evolution
-- provider from the codebase; only `meta_cloud` remains.
--
-- Pre-flight: rows tagged `provider = 'evolution'` were converted to
-- `meta_cloud` by hand before this ran. Postgres can't drop an enum value
-- while rows reference it.
--
-- Approach: rename old enum, create new enum without `evolution`, alter
-- the column to use the new enum, drop the old enum. Prisma wraps the
-- whole file in one transaction; no BEGIN/COMMIT here.

ALTER TYPE "ProviderName" RENAME TO "ProviderName_old";

CREATE TYPE "ProviderName" AS ENUM ('meta_cloud');

ALTER TABLE "Message"
  ALTER COLUMN "provider" TYPE "ProviderName"
  USING "provider"::text::"ProviderName";

DROP TYPE "ProviderName_old";
