-- MessengerPersona — the mapping from one of OUR agents to a Meta persona id on
-- one Page. See the model docblock in schema.prisma for why this is the only
-- Messenger surface with a local table: it is not a copy of a Meta record, it is
-- a join Meta does not store and cannot answer.
--
-- Written by hand rather than generated. `prisma migrate diff` against this
-- database also emits an unrelated `ALTER TABLE "Invite" DROP COLUMN
-- "organizationId"` from in-flight drift, and a DROP COLUMN riding along in an
-- additive migration is exactly how the org→workspace rename destroyed six raw
-- partial indexes (see the note at the bottom of 0_init).

-- CreateTable
CREATE TABLE "MessengerPersona" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "channelConnectionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "externalPersonaId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MessengerPersona_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MessengerPersona_workspaceId_idx" ON "MessengerPersona"("workspaceId");

-- One persona per agent per Page. Also the race guard: two concurrent first
-- replies by the same agent on the same Page must not mint two personas.
-- CreateIndex
CREATE UNIQUE INDEX "MessengerPersona_channelConnectionId_userId_key" ON "MessengerPersona"("channelConnectionId", "userId");

-- AddForeignKey
ALTER TABLE "MessengerPersona" ADD CONSTRAINT "MessengerPersona_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessengerPersona" ADD CONSTRAINT "MessengerPersona_channelConnectionId_fkey" FOREIGN KEY ("channelConnectionId") REFERENCES "ChannelConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessengerPersona" ADD CONSTRAINT "MessengerPersona_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
