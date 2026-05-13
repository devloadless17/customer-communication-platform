-- AlterTable
ALTER TABLE "MessageTemplate" ADD COLUMN     "variableBindings" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "Team" ADD COLUMN     "metaAppId" TEXT;
