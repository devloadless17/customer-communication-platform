-- NOTE: spurious DROP INDEX "Contact_customFields_gin_idx" stripped — the
-- index is hand-managed in the init migration's raw-SQL section. Same drift
-- quirk as the prior migrations; see schema.prisma's Contact model comment.

-- CreateTable
CREATE TABLE "TeamChannelMember" (
    "channelId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "addedById" TEXT,

    CONSTRAINT "TeamChannelMember_pkey" PRIMARY KEY ("channelId","userId")
);

-- CreateIndex
CREATE INDEX "TeamChannelMember_userId_idx" ON "TeamChannelMember"("userId");

-- AddForeignKey
ALTER TABLE "TeamChannelMember" ADD CONSTRAINT "TeamChannelMember_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "TeamChannel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamChannelMember" ADD CONSTRAINT "TeamChannelMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamChannelMember" ADD CONSTRAINT "TeamChannelMember_addedById_fkey" FOREIGN KEY ("addedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill: every existing team member is implicitly in every existing channel
-- (matches v0 behavior). After this point, new channels need explicit member
-- inserts at creation time, but the existing access surface is preserved.
-- Idempotent via ON CONFLICT so re-running the migration script on an already-
-- backfilled DB is a no-op.
INSERT INTO "TeamChannelMember" ("channelId", "userId", "addedAt", "addedById")
SELECT c."id", u."id", NOW(), NULL
FROM "TeamChannel" c
JOIN "User" u ON u."teamId" = c."teamId"
ON CONFLICT ("channelId", "userId") DO NOTHING;

-- Backfill: any ContactStage row with NULL/empty color → "slate" so the
-- palette renderer has a real key to look up. Hand-bundled here because it's
-- a one-time data fix tied to the broader "stage colors render white" thread
-- and we don't want a separate migration just for one UPDATE.
UPDATE "ContactStage" SET "color" = 'slate' WHERE "color" IS NULL OR "color" = '';
