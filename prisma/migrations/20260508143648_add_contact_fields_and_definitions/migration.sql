-- AlterTable
ALTER TABLE "Contact" ADD COLUMN     "customFields" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "email" TEXT,
ADD COLUMN     "location" TEXT;

-- CreateTable
CREATE TABLE "ContactFieldDefinition" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContactFieldDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ContactFieldDefinition_teamId_order_idx" ON "ContactFieldDefinition"("teamId", "order");

-- CreateIndex
CREATE UNIQUE INDEX "ContactFieldDefinition_teamId_key_key" ON "ContactFieldDefinition"("teamId", "key");

-- AddForeignKey
ALTER TABLE "ContactFieldDefinition" ADD CONSTRAINT "ContactFieldDefinition_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
