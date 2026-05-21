-- Channel credentials moved to `ChannelConnection` (one row per team+provider),
-- backfilled in 20260521132613_add_channel_connection. These flat `meta*`
-- columns on Team are now unread by any code path — drop them.
--
-- Hand-written (not via `migrate dev`) so the spurious DROP INDEX
-- "Contact_customFields_gin_idx" that Prisma regenerates each time is not
-- bundled — that JSONB GIN index is hand-managed in the init migration; see
-- schema.prisma's Contact model comment.

-- DropIndex
DROP INDEX "Team_metaPhoneNumberId_key";

-- AlterTable
ALTER TABLE "Team"
  DROP COLUMN "metaPhoneNumberId",
  DROP COLUMN "metaDisplayPhoneNumber",
  DROP COLUMN "metaWabaId",
  DROP COLUMN "metaAccessToken",
  DROP COLUMN "metaAppSecret",
  DROP COLUMN "metaVerifyToken",
  DROP COLUMN "metaAppId";
