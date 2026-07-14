-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "webchatWidgetId" TEXT;

-- CreateTable
CREATE TABLE "WebchatWidget" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "allowedOrigins" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "config" JSONB NOT NULL DEFAULT '{}',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebchatWidget_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WebchatWidget_publicKey_key" ON "WebchatWidget"("publicKey");

-- CreateIndex
CREATE INDEX "WebchatWidget_teamId_idx" ON "WebchatWidget"("teamId");

-- AddForeignKey
ALTER TABLE "WebchatWidget" ADD CONSTRAINT "WebchatWidget_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_webchatWidgetId_fkey" FOREIGN KEY ("webchatWidgetId") REFERENCES "WebchatWidget"("id") ON DELETE SET NULL ON UPDATE CASCADE;
