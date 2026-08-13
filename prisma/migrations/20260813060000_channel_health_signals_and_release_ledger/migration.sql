-- Swallowed-failures backlog close-out (2026-08-13). Three additive pieces:
--
-- 1. `ChannelConnection.registrationStatus` — the number's Cloud API `status`
--    (CONNECTED | DISCONNECTED | PENDING | ...). Read at connect and by the
--    health poll since forever, then DROPPED — so Settings said "Connected"
--    over a number whose every send failed (the 2026-08-11 live incident).
--
-- 2. `ChannelConnection.lastWebhookRejectedAt/-Reason` — inbound webhooks we
--    403'd (bad_signature / no_config). Meta gives up on a failing endpoint
--    after ~24-36h, so a persistent mismatch is silently-lost inbound; these
--    stamps drive the Settings banner (channel-wide, throttled in-process).
--
-- 3. `PendingSubscriptionRelease` — the retry ledger for webhook-subscription
--    releases owed to Meta. Removing an account used to fire ONE best-effort
--    DELETE /subscribed_apps; on failure the removed customer's traffic kept
--    arriving forever (dropped as `unknown_account`). Rows are written before
--    the inline attempt, deleted on success, retried with backoff by the
--    `subscription-release-retry` sweeper (loud give-up at 7 attempts).

-- AlterTable
ALTER TABLE "ChannelConnection" ADD COLUMN     "lastWebhookRejectReason" TEXT,
ADD COLUMN     "lastWebhookRejectedAt" TIMESTAMP(3),
ADD COLUMN     "registrationStatus" TEXT;

-- CreateTable
CREATE TABLE "PendingSubscriptionRelease" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "channel" "Channel" NOT NULL,
    "externalObjectId" TEXT NOT NULL,
    "secrets" JSONB NOT NULL DEFAULT '{}',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PendingSubscriptionRelease_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PendingSubscriptionRelease_nextAttemptAt_idx" ON "PendingSubscriptionRelease"("nextAttemptAt");

-- CreateIndex
CREATE INDEX "PendingSubscriptionRelease_workspaceId_idx" ON "PendingSubscriptionRelease"("workspaceId");

-- AddForeignKey
ALTER TABLE "PendingSubscriptionRelease" ADD CONSTRAINT "PendingSubscriptionRelease_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
