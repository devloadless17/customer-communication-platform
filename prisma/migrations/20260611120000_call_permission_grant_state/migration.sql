-- Call-permission grant state: distinguish a permission REQUEST (sent) from a
-- permission GRANT (the customer accepted). Before this, expiresAt was stamped
-- +72h at REQUEST time and the grant webhook never touched the row, so the
-- placeCall pre-flight treated "we sent a request 5 minutes ago" as "permission
-- is live" for 72h — calling out the whole time and getting opaque
-- provider_rejected errors for ungranted/denied contacts.
--
-- Hand-written ADDITIVE migration (NOT generated via `prisma migrate dev`) so
-- the squashed `0_init` migration + its hand-written GIN / partial indexes are
-- never touched. See schema.prisma header + the migration memory notes.

-- CreateEnum
CREATE TYPE "CallPermissionStatus" AS ENUM ('pending', 'granted', 'denied');

-- AlterTable: new rows are `pending` until Meta's permission webhook lands.
ALTER TABLE "CallPermissionRequest"
  ADD COLUMN "status" "CallPermissionStatus" NOT NULL DEFAULT 'pending',
  ADD COLUMN "grantedAt" TIMESTAMP(3);

-- Backfill: every PRE-EXISTING row stays `pending`. We cannot retroactively
-- know which past requests the customer actually accepted (the grant webhook
-- never wrote the row before this migration), so we conservatively leave them
-- ungranted — the worst case is one extra (correctly-gated) permission request
-- on the next call attempt, which is the right safe default. No data loss:
-- expiresAt / externalRequestId / rateLimitedUntil are untouched.
-- (Column default already applied 'pending' to existing rows; this is explicit
-- for clarity and to document the intent.)
UPDATE "CallPermissionRequest" SET "status" = 'pending' WHERE "status" IS NULL;
