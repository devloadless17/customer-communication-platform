-- `Broadcast.channelConnectionId` was added as a bare column; without the FK
-- (and the Prisma relation it backs) the portfolio-scoped 24h budget query
-- cannot traverse `channelConnection.portfolioId`, so a two-number portfolio's
-- shared limit could not be counted at all.
ALTER TABLE "Broadcast"
  ADD CONSTRAINT "Broadcast_channelConnectionId_fkey"
  FOREIGN KEY ("channelConnectionId") REFERENCES "ChannelConnection"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "Broadcast_channelConnectionId_idx" ON "Broadcast"("channelConnectionId");
