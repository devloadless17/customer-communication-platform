-- AlterTable
ALTER TABLE "Broadcast" ADD COLUMN     "audienceGroupId" TEXT,
ADD COLUMN     "audienceGroupName" TEXT;

-- CreateTable
CREATE TABLE "AudienceGroup" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AudienceGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_AudienceGroupTags" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_AudienceGroupTags_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "_AudienceGroupContacts" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_AudienceGroupContacts_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE INDEX "AudienceGroup_teamId_idx" ON "AudienceGroup"("teamId");

-- CreateIndex
CREATE UNIQUE INDEX "AudienceGroup_teamId_name_key" ON "AudienceGroup"("teamId", "name");

-- CreateIndex
CREATE INDEX "_AudienceGroupTags_B_index" ON "_AudienceGroupTags"("B");

-- CreateIndex
CREATE INDEX "_AudienceGroupContacts_B_index" ON "_AudienceGroupContacts"("B");

-- AddForeignKey
ALTER TABLE "AudienceGroup" ADD CONSTRAINT "AudienceGroup_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AudienceGroup" ADD CONSTRAINT "AudienceGroup_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_AudienceGroupTags" ADD CONSTRAINT "_AudienceGroupTags_A_fkey" FOREIGN KEY ("A") REFERENCES "AudienceGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_AudienceGroupTags" ADD CONSTRAINT "_AudienceGroupTags_B_fkey" FOREIGN KEY ("B") REFERENCES "Tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_AudienceGroupContacts" ADD CONSTRAINT "_AudienceGroupContacts_A_fkey" FOREIGN KEY ("A") REFERENCES "AudienceGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_AudienceGroupContacts" ADD CONSTRAINT "_AudienceGroupContacts_B_fkey" FOREIGN KEY ("B") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
