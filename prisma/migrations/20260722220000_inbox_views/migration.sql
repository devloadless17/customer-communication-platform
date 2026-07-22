-- CreateEnum
CREATE TYPE "InboxViewVisibility" AS ENUM ('personal', 'shared');

-- CreateTable
CREATE TABLE "InboxView" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT 'slate',
    "icon" TEXT NOT NULL DEFAULT 'filter',
    "visibility" "InboxViewVisibility" NOT NULL DEFAULT 'personal',
    "createdById" TEXT,
    "filters" JSONB NOT NULL DEFAULT '{}',
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InboxView_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InboxView_workspaceId_visibility_idx" ON "InboxView"("workspaceId", "visibility");

-- CreateIndex
CREATE INDEX "InboxView_workspaceId_createdById_idx" ON "InboxView"("workspaceId", "createdById");

-- AddForeignKey
ALTER TABLE "InboxView" ADD CONSTRAINT "InboxView_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboxView" ADD CONSTRAINT "InboxView_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Name uniqueness — PARTIAL, because the rule is conditional and Prisma cannot
-- express it in the schema (see the model comment on InboxView).
--
--   shared   → one "Escalations" per workspace, whoever created it
--   personal → one "Escalations" per person, and two teammates may each have
--              their own without colliding
--
-- lower(name) so "Escalations" and "escalations" collide, which is what a user
-- means by "that name is taken".
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX "InboxView_shared_name_key"
  ON "InboxView"("workspaceId", lower("name"))
  WHERE "visibility" = 'shared';

CREATE UNIQUE INDEX "InboxView_personal_name_key"
  ON "InboxView"("workspaceId", "createdById", lower("name"))
  WHERE "visibility" = 'personal';
