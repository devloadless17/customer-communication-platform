-- Shared Meta-app credentials per team (one app powers all Meta channels).
CREATE TABLE "MetaConnection" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "config" JSONB NOT NULL DEFAULT '{}',
    "secrets" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MetaConnection_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "MetaConnection_teamId_key" ON "MetaConnection"("teamId");
ALTER TABLE "MetaConnection" ADD CONSTRAINT "MetaConnection_teamId_fkey"
    FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
