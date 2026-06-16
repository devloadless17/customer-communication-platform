-- AlterTable
ALTER TABLE "Message" ALTER COLUMN "rawPayload" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "Conversation_contactId_idx" ON "Conversation"("contactId");
