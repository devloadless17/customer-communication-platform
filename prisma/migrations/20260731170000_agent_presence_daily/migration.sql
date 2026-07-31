-- Per-(workspace, user, UTC day) online-time ledger behind the team report's
-- "Online" column (lib/sweepers/agent-presence-sample.ts writes it; the team
-- report sums it). Sampling-based on purpose: a crash can never leave a
-- dangling open session that inflates someone's hours.
CREATE TABLE "AgentPresenceDaily" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "onlineMinutes" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "AgentPresenceDaily_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AgentPresenceDaily_workspaceId_userId_date_key" ON "AgentPresenceDaily"("workspaceId", "userId", "date");
CREATE INDEX "AgentPresenceDaily_workspaceId_date_idx" ON "AgentPresenceDaily"("workspaceId", "date");
CREATE INDEX "AgentPresenceDaily_userId_idx" ON "AgentPresenceDaily"("userId");

ALTER TABLE "AgentPresenceDaily" ADD CONSTRAINT "AgentPresenceDaily_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgentPresenceDaily" ADD CONSTRAINT "AgentPresenceDaily_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
