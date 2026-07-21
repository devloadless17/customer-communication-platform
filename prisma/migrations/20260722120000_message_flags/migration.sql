-- CreateEnum
CREATE TYPE "MessageFlagStatus" AS ENUM ('open', 'resolved', 'dismissed');

-- AlterEnum
ALTER TYPE "ConversationEventKind" ADD VALUE 'flag_added';
ALTER TYPE "ConversationEventKind" ADD VALUE 'flag_reopened';
ALTER TYPE "ConversationEventKind" ADD VALUE 'flag_resolved';
ALTER TYPE "ConversationEventKind" ADD VALUE 'flag_removed';

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "openFlagCount" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "MessageFlagDefinition" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT 'slate',
    "description" TEXT,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MessageFlagDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MessageFlag" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "definitionId" TEXT NOT NULL,
    "status" "MessageFlagStatus" NOT NULL DEFAULT 'open',
    "source" TEXT NOT NULL DEFAULT 'human',
    "confidence" DOUBLE PRECISION,
    "note" TEXT,
    "createdById" TEXT,
    "assignedToId" TEXT,
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolutionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MessageFlag_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MessageFlagDefinition_teamId_name_key" ON "MessageFlagDefinition"("teamId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "MessageFlag_messageId_definitionId_key" ON "MessageFlag"("messageId", "definitionId");

-- CreateIndex
CREATE INDEX "MessageFlag_teamId_status_createdAt_id_idx" ON "MessageFlag"("teamId", "status", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "MessageFlag_teamId_assignedToId_status_idx" ON "MessageFlag"("teamId", "assignedToId", "status");

-- CreateIndex
CREATE INDEX "MessageFlag_messageId_idx" ON "MessageFlag"("messageId");

-- CreateIndex
CREATE INDEX "MessageFlag_conversationId_idx" ON "MessageFlag"("conversationId");

-- CreateIndex
CREATE INDEX "MessageFlag_definitionId_idx" ON "MessageFlag"("definitionId");

-- CreateIndex
CREATE INDEX "MessageFlag_createdById_idx" ON "MessageFlag"("createdById");

-- CreateIndex
CREATE INDEX "MessageFlag_assignedToId_idx" ON "MessageFlag"("assignedToId");

-- CreateIndex
CREATE INDEX "MessageFlag_resolvedById_idx" ON "MessageFlag"("resolvedById");

-- AddForeignKey
ALTER TABLE "MessageFlagDefinition" ADD CONSTRAINT "MessageFlagDefinition_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageFlag" ADD CONSTRAINT "MessageFlag_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageFlag" ADD CONSTRAINT "MessageFlag_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageFlag" ADD CONSTRAINT "MessageFlag_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageFlag" ADD CONSTRAINT "MessageFlag_definitionId_fkey" FOREIGN KEY ("definitionId") REFERENCES "MessageFlagDefinition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageFlag" ADD CONSTRAINT "MessageFlag_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageFlag" ADD CONSTRAINT "MessageFlag_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageFlag" ADD CONSTRAINT "MessageFlag_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex
-- PARTIAL index — not expressible in the Prisma schema (see the note on
-- Conversation). Serves the "Flagged" inbox preset:
--   WHERE "teamId" = $1 AND "openFlagCount" > 0
--   ORDER BY "lastMessageAt" DESC, "id" DESC
-- A plain composite can't work: `openFlagCount > 0` is a range predicate, so
-- placing it between teamId and the sort key forfeits the ordered index scan.
-- Partial keeps the index to only the flagged rows, which is both far smaller
-- and lets the planner walk it in sort order and stop at LIMIT.
CREATE INDEX "Conversation_teamId_openFlag_idx"
    ON "Conversation"("teamId", "lastMessageAt" DESC, "id" DESC)
    WHERE "openFlagCount" > 0;
