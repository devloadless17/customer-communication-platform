-- NOTE: spurious DROP INDEX "Contact_customFields_gin_idx" stripped — the
-- index is hand-managed in the init migration's raw-SQL section. Same drift
-- quirk as the prior migrations; see schema.prisma's Contact model comment.

-- CreateTable
CREATE TABLE "ChannelConnection" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "provider" "ProviderName" NOT NULL,
    "config" JSONB NOT NULL DEFAULT '{}',
    "secrets" JSONB NOT NULL DEFAULT '{}',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChannelConnection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ChannelConnection_teamId_provider_key" ON "ChannelConnection"("teamId", "provider");

-- AddForeignKey
ALTER TABLE "ChannelConnection" ADD CONSTRAINT "ChannelConnection_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: one meta_cloud ChannelConnection per team that has any WhatsApp
-- credential. Non-secret fields → `config`; the already-envelope-encrypted
-- secret columns are copied VERBATIM into `secrets` (no decrypt/re-encrypt, so
-- the crypto boundary is untouched). jsonb_strip_nulls drops absent fields so
-- the blobs stay clean. Idempotent via ON CONFLICT in case of re-run.
INSERT INTO "ChannelConnection" ("id", "teamId", "provider", "config", "secrets", "isActive", "createdAt", "updatedAt")
SELECT
  gen_random_uuid()::text,
  t."id",
  'meta_cloud',
  jsonb_strip_nulls(jsonb_build_object(
    'phoneNumberId',      t."metaPhoneNumberId",
    'displayPhoneNumber', t."metaDisplayPhoneNumber",
    'wabaId',             t."metaWabaId",
    'appId',              t."metaAppId",
    'verifyToken',        t."metaVerifyToken"
  )),
  jsonb_strip_nulls(jsonb_build_object(
    'accessToken', t."metaAccessToken",
    'appSecret',   t."metaAppSecret"
  )),
  true,
  NOW(),
  NOW()
FROM "Team" t
WHERE t."metaPhoneNumberId" IS NOT NULL
   OR t."metaAccessToken" IS NOT NULL
   OR t."metaAppSecret" IS NOT NULL
ON CONFLICT ("teamId", "provider") DO NOTHING;
