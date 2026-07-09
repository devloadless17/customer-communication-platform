-- CreateEnum
CREATE TYPE "BroadcastKind" AS ENUM ('template', 'freeform');

-- AlterTable
ALTER TABLE "Broadcast" ADD COLUMN     "bodyText" TEXT,
ADD COLUMN     "channel" "Channel" NOT NULL DEFAULT 'whatsapp',
ADD COLUMN     "kind" "BroadcastKind" NOT NULL DEFAULT 'template',
ALTER COLUMN "templateId" DROP NOT NULL,
ALTER COLUMN "templateName" DROP NOT NULL,
ALTER COLUMN "templateLanguage" DROP NOT NULL;
