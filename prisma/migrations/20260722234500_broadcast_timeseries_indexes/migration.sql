-- CreateIndex
CREATE INDEX "BroadcastRecipient_broadcastId_deliveredAt_idx" ON "BroadcastRecipient"("broadcastId", "deliveredAt");

-- CreateIndex
CREATE INDEX "BroadcastRecipient_broadcastId_readAt_idx" ON "BroadcastRecipient"("broadcastId", "readAt");

