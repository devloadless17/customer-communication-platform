-- CreateEnum
CREATE TYPE "TemplateStatus" AS ENUM ('approved', 'pending', 'rejected', 'paused', 'disabled');

-- CreateEnum
CREATE TYPE "TemplateCategory" AS ENUM ('marketing', 'utility', 'authentication');

-- CreateTable
CREATE TABLE "MessageTemplate" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "externalId" TEXT,
    "name" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "category" "TemplateCategory" NOT NULL,
    "status" "TemplateStatus" NOT NULL,
    "bodyText" TEXT NOT NULL DEFAULT '',
    "components" JSONB NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MessageTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MessageTemplate_teamId_status_idx" ON "MessageTemplate"("teamId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "MessageTemplate_teamId_name_language_key" ON "MessageTemplate"("teamId", "name", "language");

-- AddForeignKey
ALTER TABLE "MessageTemplate" ADD CONSTRAINT "MessageTemplate_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
