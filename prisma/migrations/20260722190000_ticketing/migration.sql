-- Ticketing (Phase C).
--
-- A ticket is the unit of WORK on a conversation, and there are many over time.
-- Purely additive: every column added here is nullable or defaulted, so the
-- migration is a no-op for existing rows and ticketing simply starts applying
-- to new traffic (Workspace.ticketAutoOpen defaults on).
--
-- Two indexes at the end cannot be expressed in the Prisma schema and are
-- created here in raw SQL — see the block comment on `model Ticket`.

-- CreateEnum
CREATE TYPE "TicketStatus" AS ENUM ('new', 'open', 'pending', 'on_hold', 'solved', 'closed');

-- CreateEnum
CREATE TYPE "TicketPriority" AS ENUM ('low', 'normal', 'high', 'urgent');

-- CreateEnum
CREATE TYPE "TicketEventKind" AS ENUM ('created', 'assigned', 'unassigned', 'status_changed', 'priority_changed', 'subject_changed', 'tag_added', 'tag_removed', 'field_changed', 'sla_breached', 'reopened', 'merged');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ConversationEventKind" ADD VALUE 'ticket_opened';
ALTER TYPE "ConversationEventKind" ADD VALUE 'ticket_solved';
ALTER TYPE "ConversationEventKind" ADD VALUE 'ticket_reopened';
ALTER TYPE "ConversationEventKind" ADD VALUE 'ticket_closed';

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "activeTicketId" TEXT,
ADD COLUMN     "openTicketCount" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "ticketId" TEXT;

-- AlterTable
ALTER TABLE "Workspace" ADD COLUMN     "ticketAutoOpen" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "ticketCloseConversationOnLastSolved" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "ticketReopenWindowHours" INTEGER NOT NULL DEFAULT 72;

-- CreateTable
CREATE TABLE "Ticket" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "conversationId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "channel" "Channel" NOT NULL,
    "subject" TEXT,
    "status" "TicketStatus" NOT NULL DEFAULT 'new',
    "priority" "TicketPriority" NOT NULL DEFAULT 'normal',
    "assignedUserId" TEXT,
    "lastAssignedUserId" TEXT,
    "policyId" TEXT,
    "slaPolicyId" TEXT,
    "firstResponseDueAt" TIMESTAMP(3),
    "resolutionDueAt" TIMESTAMP(3),
    "firstResponseAt" TIMESTAMP(3),
    "firstResponseBreached" BOOLEAN NOT NULL DEFAULT false,
    "resolutionBreached" BOOLEAN NOT NULL DEFAULT false,
    "slaPausedMs" INTEGER NOT NULL DEFAULT 0,
    "slaPausedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "resolvedById" TEXT,
    "resolutionCode" TEXT,
    "resolutionNote" TEXT,
    "reopenCount" INTEGER NOT NULL DEFAULT 0,
    "lastSolvedAt" TIMESTAMP(3),
    "source" TEXT NOT NULL DEFAULT 'auto',
    "createdById" TEXT,
    "createdByApiKeyId" TEXT,
    "customFields" JSONB NOT NULL DEFAULT '{}',
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Ticket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TicketEvent" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "kind" "TicketEventKind" NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "actorUserId" TEXT,
    "actorApiKeyId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TicketEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TicketSlaPolicy" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "priority" "TicketPriority" NOT NULL,
    "firstResponseMins" INTEGER,
    "resolutionMins" INTEGER,
    "pauseOnHold" BOOLEAN NOT NULL DEFAULT true,
    "pauseWhenPending" BOOLEAN NOT NULL DEFAULT false,
    "businessHoursOnly" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TicketSlaPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TicketFieldDefinition" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "isVisible" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TicketFieldDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TicketNumberCounter" (
    "workspaceId" TEXT NOT NULL,
    "next" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "TicketNumberCounter_pkey" PRIMARY KEY ("workspaceId")
);

-- CreateTable
CREATE TABLE "_TicketTags" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_TicketTags_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE INDEX "Ticket_workspaceId_status_createdAt_id_idx" ON "Ticket"("workspaceId", "status", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "Ticket_workspaceId_assignedUserId_status_createdAt_id_idx" ON "Ticket"("workspaceId", "assignedUserId", "status", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "Ticket_workspaceId_priority_status_idx" ON "Ticket"("workspaceId", "priority", "status");

-- CreateIndex
CREATE INDEX "Ticket_conversationId_createdAt_idx" ON "Ticket"("conversationId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Ticket_workspaceId_contactId_createdAt_idx" ON "Ticket"("workspaceId", "contactId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Ticket_assignedUserId_idx" ON "Ticket"("assignedUserId");

-- CreateIndex
CREATE INDEX "Ticket_resolvedById_idx" ON "Ticket"("resolvedById");

-- CreateIndex
CREATE INDEX "Ticket_slaPolicyId_idx" ON "Ticket"("slaPolicyId");

-- CreateIndex
CREATE INDEX "Ticket_contactId_idx" ON "Ticket"("contactId");

-- CreateIndex
CREATE UNIQUE INDEX "Ticket_workspaceId_number_key" ON "Ticket"("workspaceId", "number");

-- CreateIndex
CREATE INDEX "TicketEvent_ticketId_createdAt_idx" ON "TicketEvent"("ticketId", "createdAt");

-- CreateIndex
CREATE INDEX "TicketEvent_workspaceId_createdAt_idx" ON "TicketEvent"("workspaceId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "TicketEvent_actorUserId_idx" ON "TicketEvent"("actorUserId");

-- CreateIndex
CREATE UNIQUE INDEX "TicketSlaPolicy_workspaceId_priority_key" ON "TicketSlaPolicy"("workspaceId", "priority");

-- CreateIndex
CREATE INDEX "TicketFieldDefinition_workspaceId_order_idx" ON "TicketFieldDefinition"("workspaceId", "order");

-- CreateIndex
CREATE UNIQUE INDEX "TicketFieldDefinition_workspaceId_key_key" ON "TicketFieldDefinition"("workspaceId", "key");

-- CreateIndex
CREATE INDEX "_TicketTags_B_index" ON "_TicketTags"("B");

-- CreateIndex
CREATE INDEX "Message_ticketId_timestamp_idx" ON "Message"("ticketId", "timestamp");

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_activeTicketId_fkey" FOREIGN KEY ("activeTicketId") REFERENCES "Ticket"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_assignedUserId_fkey" FOREIGN KEY ("assignedUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_slaPolicyId_fkey" FOREIGN KEY ("slaPolicyId") REFERENCES "TicketSlaPolicy"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketEvent" ADD CONSTRAINT "TicketEvent_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketEvent" ADD CONSTRAINT "TicketEvent_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketEvent" ADD CONSTRAINT "TicketEvent_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketSlaPolicy" ADD CONSTRAINT "TicketSlaPolicy_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketFieldDefinition" ADD CONSTRAINT "TicketFieldDefinition_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketNumberCounter" ADD CONSTRAINT "TicketNumberCounter_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_TicketTags" ADD CONSTRAINT "_TicketTags_A_fkey" FOREIGN KEY ("A") REFERENCES "Tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_TicketTags" ADD CONSTRAINT "_TicketTags_B_fkey" FOREIGN KEY ("B") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The SLA breach sweeper scans across workspaces for tickets whose clock has run
-- out and that are not already flagged. PARTIAL, because that is a tiny fraction
-- of rows: a full index on the due date would be mostly nulls and mostly
-- already-breached rows, and the sweeper would still have to filter them.
-- Terminal tickets are excluded too — a solved ticket's clock is over.
CREATE INDEX "Ticket_first_response_due_idx"
  ON "Ticket" ("firstResponseDueAt")
  WHERE "firstResponseDueAt" IS NOT NULL
    AND "firstResponseBreached" = false
    AND "firstResponseAt" IS NULL
    AND "status" NOT IN ('solved', 'closed');

CREATE INDEX "Ticket_resolution_due_idx"
  ON "Ticket" ("resolutionDueAt")
  WHERE "resolutionDueAt" IS NOT NULL
    AND "resolutionBreached" = false
    AND "status" NOT IN ('solved', 'closed');
