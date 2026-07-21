-- CreateEnum
CREATE TYPE "AssignmentStrategy" AS ENUM ('round_robin', 'least_busy', 'weighted', 'fixed', 'manual');

-- CreateEnum
CREATE TYPE "AssignmentEligibility" AS ENUM ('online_first', 'online_only', 'available_only', 'any_active');

-- CreateEnum
CREATE TYPE "AssignmentOverflow" AS ENUM ('leave_unassigned', 'ignore_capacity', 'fallback_user');

-- CreateEnum
CREATE TYPE "BroadcastAssignmentMode" AS ENUM ('none', 'fixed', 'split_counts', 'split_percent', 'policy');

-- AlterTable
ALTER TABLE "Broadcast" ADD COLUMN     "assignmentLeftover" TEXT NOT NULL DEFAULT 'leave_unassigned',
ADD COLUMN     "assignmentMode" "BroadcastAssignmentMode" NOT NULL DEFAULT 'none',
ADD COLUMN     "assignmentOverwrite" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "assignmentPolicyId" TEXT,
ADD COLUMN     "assignmentSplit" JSONB,
ADD COLUMN     "assignmentTrigger" TEXT NOT NULL DEFAULT 'on_reply',
ADD COLUMN     "assignmentUserId" TEXT;

-- AlterTable
ALTER TABLE "BroadcastRecipient" ADD COLUMN     "assignedUserId" TEXT;

-- CreateTable
CREATE TABLE "AssignmentPolicy" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "strategy" "AssignmentStrategy" NOT NULL DEFAULT 'least_busy',
    "eligibility" "AssignmentEligibility" NOT NULL DEFAULT 'online_first',
    "eligibleRoles" "Role"[] DEFAULT ARRAY[]::"Role"[],
    "includeAllMembers" BOOLEAN NOT NULL DEFAULT true,
    "defaultMaxOpen" INTEGER,
    "overflow" "AssignmentOverflow" NOT NULL DEFAULT 'leave_unassigned',
    "fallbackUserId" TEXT,
    "fixedUserId" TEXT,
    "cursorUserId" TEXT,
    "preferPreviousAgent" BOOLEAN NOT NULL DEFAULT true,
    "previousAgentWindowDays" INTEGER NOT NULL DEFAULT 30,
    "version" INTEGER NOT NULL DEFAULT 1,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AssignmentPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssignmentPolicyMember" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "policyId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "weight" INTEGER NOT NULL DEFAULT 1,
    "maxOpen" INTEGER,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "served" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AssignmentPolicyMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssignmentRule" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "policyId" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "conditions" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AssignmentRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssignmentSettings" (
    "teamId" TEXT NOT NULL,
    "autoAssignOnNewConversation" BOOLEAN NOT NULL DEFAULT false,
    "skipWhenAiHandling" BOOLEAN NOT NULL DEFAULT true,
    "autoAssignOnReopen" BOOLEAN NOT NULL DEFAULT false,
    "reassignOnOffline" BOOLEAN NOT NULL DEFAULT false,
    "reassignOfflineAfterMinutes" INTEGER NOT NULL DEFAULT 15,
    "reassignOfflineOnlyPending" BOOLEAN NOT NULL DEFAULT true,
    "reassignOnDeactivate" BOOLEAN NOT NULL DEFAULT true,
    "aiHandoffPolicyId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AssignmentSettings_pkey" PRIMARY KEY ("teamId")
);

-- CreateIndex
CREATE INDEX "AssignmentPolicy_teamId_archivedAt_idx" ON "AssignmentPolicy"("teamId", "archivedAt");

-- CreateIndex
CREATE INDEX "AssignmentPolicy_teamId_isDefault_idx" ON "AssignmentPolicy"("teamId", "isDefault");

-- CreateIndex
CREATE INDEX "AssignmentPolicyMember_teamId_idx" ON "AssignmentPolicyMember"("teamId");

-- CreateIndex
CREATE UNIQUE INDEX "AssignmentPolicyMember_policyId_userId_key" ON "AssignmentPolicyMember"("policyId", "userId");

-- CreateIndex
CREATE INDEX "AssignmentRule_teamId_enabled_position_idx" ON "AssignmentRule"("teamId", "enabled", "position");

-- AddForeignKey
ALTER TABLE "AssignmentPolicy" ADD CONSTRAINT "AssignmentPolicy_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssignmentPolicyMember" ADD CONSTRAINT "AssignmentPolicyMember_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "AssignmentPolicy"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssignmentPolicyMember" ADD CONSTRAINT "AssignmentPolicyMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssignmentRule" ADD CONSTRAINT "AssignmentRule_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssignmentRule" ADD CONSTRAINT "AssignmentRule_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "AssignmentPolicy"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssignmentSettings" ADD CONSTRAINT "AssignmentSettings_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- At most ONE default policy per team. Prisma can't express a partial unique,
-- so it lives here. This is what lets `resolvePolicy` do a single lookup for
-- "the team's fallback" without an ORDER BY tiebreak.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX "AssignmentPolicy_teamId_default_key"
  ON "AssignmentPolicy"("teamId")
  WHERE "isDefault" AND "archivedAt" IS NULL;

-- ---------------------------------------------------------------------------
-- Backfill: every EXISTING team gets a default policy configured to reproduce
-- the previous hardcoded behavior EXACTLY (round-robin, online-first tiering,
-- all members, no cap, leave-unassigned on overflow), carrying over the
-- team-wide rotation cursor so rotation doesn't restart mid-day. New teams get
-- the same row from `ensureDefaultPolicy` on first read.
--
-- AssignmentSettings is seeded with every auto-assign trigger OFF, so this
-- migration is behaviour-neutral: nothing new fires until an admin opts in.
-- ---------------------------------------------------------------------------
INSERT INTO "AssignmentPolicy" ("id", "teamId", "name", "description", "isDefault", "cursorUserId", "createdAt", "updatedAt")
SELECT
  'apol_' || substr(md5(random()::text || t."id"), 1, 20),
  t."id",
  'Default',
  'Balances new conversations across everyone online and available, fewest open chats first.',
  true,
  t."aiRoundRobinCursorUserId",
  NOW(),
  NOW()
FROM "Team" t;

INSERT INTO "AssignmentSettings" ("teamId", "createdAt", "updatedAt")
SELECT t."id", NOW(), NOW() FROM "Team" t;
