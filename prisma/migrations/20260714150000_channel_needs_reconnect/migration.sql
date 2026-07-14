-- Token-health flags for the "reconnect the channel" UX (Graph error 190).
ALTER TABLE "ChannelConnection" ADD COLUMN "needsReconnect" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ChannelConnection" ADD COLUMN "lastAuthErrorAt" TIMESTAMP(3);
