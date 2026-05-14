/*
  Warnings:

  - You are about to drop the column `mediaPath` on the `Message` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Message" DROP COLUMN "mediaPath",
ADD COLUMN     "mediaKey" TEXT,
ADD COLUMN     "mediaUrl" TEXT;
