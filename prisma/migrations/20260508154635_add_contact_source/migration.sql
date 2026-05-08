-- CreateEnum
CREATE TYPE "ContactSource" AS ENUM ('inbound', 'manual');

-- AlterTable
ALTER TABLE "Contact" ADD COLUMN     "source" "ContactSource" NOT NULL DEFAULT 'inbound';

-- CreateIndex
CREATE INDEX "Contact_teamId_source_idx" ON "Contact"("teamId", "source");
