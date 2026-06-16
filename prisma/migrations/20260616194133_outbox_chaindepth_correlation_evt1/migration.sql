-- AlterTable
ALTER TABLE "OutboundEvent" ADD COLUMN     "chainDepth" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "correlationId" TEXT;
