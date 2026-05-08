-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "mediaCaption" TEXT,
ADD COLUMN     "mediaDurationMs" INTEGER,
ADD COLUMN     "mediaFilename" TEXT,
ADD COLUMN     "mediaKind" TEXT,
ADD COLUMN     "mediaMimeType" TEXT,
ADD COLUMN     "mediaPath" TEXT,
ADD COLUMN     "mediaSizeBytes" INTEGER;
