-- AlterTable
ALTER TABLE "ChannelConnection" ADD COLUMN     "insightsEnabledAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "TemplateAnalyticsDaily" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "templateExternalId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "sent" INTEGER NOT NULL DEFAULT 0,
    "delivered" INTEGER NOT NULL DEFAULT 0,
    "read" INTEGER,
    "clicked" INTEGER,
    "costAmountSpent" DECIMAL(14,6),
    "costPerDelivered" DECIMAL(14,6),
    "costPerUrlClick" DECIMAL(14,6),
    "currency" TEXT,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TemplateAnalyticsDaily_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TemplateAnalyticsDaily_workspaceId_templateExternalId_date_idx" ON "TemplateAnalyticsDaily"("workspaceId", "templateExternalId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "TemplateAnalyticsDaily_workspaceId_templateExternalId_date_key" ON "TemplateAnalyticsDaily"("workspaceId", "templateExternalId", "date");

-- AddForeignKey
ALTER TABLE "TemplateAnalyticsDaily" ADD CONSTRAINT "TemplateAnalyticsDaily_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

