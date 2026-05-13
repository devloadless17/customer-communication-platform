-- AlterTable
ALTER TABLE "Contact" ADD COLUMN     "stageId" TEXT;

-- CreateTable
CREATE TABLE "ContactStage" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT 'slate',
    "position" INTEGER NOT NULL DEFAULT 0,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContactStage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ContactStage_teamId_position_idx" ON "ContactStage"("teamId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "ContactStage_teamId_name_key" ON "ContactStage"("teamId", "name");

-- CreateIndex
CREATE INDEX "Contact_teamId_stageId_idx" ON "Contact"("teamId", "stageId");

-- AddForeignKey
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_stageId_fkey" FOREIGN KEY ("stageId") REFERENCES "ContactStage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactStage" ADD CONSTRAINT "ContactStage_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Seed one default stage per existing team so manual create + webhook ingest
-- both have something to assign to. Admins rename / reorder / extend from
-- /settings/stages. New teams created after this migration get the same
-- stage via ensureDefaultStage() in lib/queries.ts.
INSERT INTO "ContactStage" ("id", "teamId", "name", "color", "position", "isDefault", "createdAt")
SELECT
  'cstg_' || replace(gen_random_uuid()::text, '-', ''),
  t.id,
  'Stage 1',
  'slate',
  0,
  TRUE,
  CURRENT_TIMESTAMP
FROM "Team" t;

-- Backfill: park every existing contact in its team's freshly-seeded
-- default. After this every Contact has a stageId; new contacts pick one up
-- via the same helper.
UPDATE "Contact" c
SET "stageId" = s.id
FROM "ContactStage" s
WHERE s."teamId" = c."teamId"
  AND s."isDefault" = TRUE
  AND c."stageId" IS NULL;
