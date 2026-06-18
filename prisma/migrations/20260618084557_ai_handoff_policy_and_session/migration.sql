-- CreateEnum
CREATE TYPE "AiHandoffAction" AS ENUM ('none', 'unassign', 'assign_fixed', 'round_robin');

-- CreateEnum
CREATE TYPE "FirstTouchGreeter" AS ENUM ('ai', 'workflow');

-- AlterTable
ALTER TABLE "Team" ADD COLUMN     "aiHandoffAction" "AiHandoffAction" NOT NULL DEFAULT 'none',
ADD COLUMN     "aiHandoffAssigneeId" TEXT,
ADD COLUMN     "aiRoundRobinCursorUserId" TEXT,
ADD COLUMN     "firstTouchGreeter" "FirstTouchGreeter" NOT NULL DEFAULT 'ai',
ADD COLUMN     "sessionGapMinutes" INTEGER NOT NULL DEFAULT 360;

-- AddForeignKey
ALTER TABLE "Team" ADD CONSTRAINT "Team_aiHandoffAssigneeId_fkey" FOREIGN KEY ("aiHandoffAssigneeId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
