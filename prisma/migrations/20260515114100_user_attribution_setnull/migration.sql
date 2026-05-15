-- DropForeignKey
ALTER TABLE "AudienceGroup" DROP CONSTRAINT "AudienceGroup_createdById_fkey";

-- DropForeignKey
ALTER TABLE "Broadcast" DROP CONSTRAINT "Broadcast_createdById_fkey";

-- DropForeignKey
ALTER TABLE "InternalNote" DROP CONSTRAINT "InternalNote_authorUserId_fkey";

-- DropForeignKey
ALTER TABLE "Invite" DROP CONSTRAINT "Invite_createdById_fkey";

-- DropForeignKey
ALTER TABLE "Snippet" DROP CONSTRAINT "Snippet_createdById_fkey";

-- AlterTable
ALTER TABLE "AudienceGroup" ALTER COLUMN "createdById" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Broadcast" ALTER COLUMN "createdById" DROP NOT NULL;

-- AlterTable
ALTER TABLE "InternalNote" ALTER COLUMN "authorUserId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Invite" ALTER COLUMN "createdById" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Snippet" ALTER COLUMN "createdById" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "Snippet" ADD CONSTRAINT "Snippet_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invite" ADD CONSTRAINT "Invite_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AudienceGroup" ADD CONSTRAINT "AudienceGroup_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Broadcast" ADD CONSTRAINT "Broadcast_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InternalNote" ADD CONSTRAINT "InternalNote_authorUserId_fkey" FOREIGN KEY ("authorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
