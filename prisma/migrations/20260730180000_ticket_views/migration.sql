-- Saved TICKET views — a named, reusable filter over the board.
--
-- Mirrors InboxView deliberately (same visibility split, same colour/icon
-- slots, same one-validated-JSON-document rule): the two are the same product
-- idea over two different lists, and a second subtly-different design would be
-- two sets of bugs.
CREATE TABLE "TicketView" (
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

    CONSTRAINT "TicketView_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "TicketView_workspaceId_visibility_position_idx" ON "TicketView"("workspaceId", "visibility", "position");
CREATE INDEX "TicketView_createdById_idx" ON "TicketView"("createdById");

ALTER TABLE "TicketView" ADD CONSTRAINT "TicketView_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- SetNull: a SHARED view outlives the agent who built it.
ALTER TABLE "TicketView" ADD CONSTRAINT "TicketView_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Case-insensitive name uniqueness, per visibility group. Prisma's DSL can
-- express neither `lower(name)` nor a `WHERE`, which is exactly why these live
-- in raw SQL and are asserted by apps/api/test/partial-indexes.spec.ts — the
-- same treatment InboxView's two indexes get. A shared view named "Escalations"
-- and a personal one may coexist; two shared ones may not.
CREATE UNIQUE INDEX "TicketView_shared_name_key" ON public."TicketView" USING btree ("workspaceId", lower(name)) WHERE (visibility = 'shared'::"InboxViewVisibility");
CREATE UNIQUE INDEX "TicketView_personal_name_key" ON public."TicketView" USING btree ("workspaceId", "createdById", lower(name)) WHERE (visibility = 'personal'::"InboxViewVisibility");
